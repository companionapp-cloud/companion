package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// Notebooks (PLAN-notebooks.md): three repos over three synced tables — the book
// (NotebooksRepo), its pages (NotebookPagesRepo) and the ink on each page (NotebookInkRepo).
// Pages are ordered by a dense integer sort_order, rewritten on insert and reorder like list
// items, so a page inserted mid-book shifts the pages after it. Nothing here touches notes,
// project_members or the link index: pages are not notes and are not graph nodes.

// ---- notebooks -------------------------------------------------------------------------

type NotebooksRepo struct {
	db    Driver
	clock domain.Clock
}

const notebookColumns = `id, title, cover_color, cover_document_id, settings_json, sort_order, created_at, updated_at, deleting_at, deleted_at, version, dirty`

type CreateNotebookInput struct {
	Title      string `json:"title"`
	CoverColor string `json:"coverColor"`
}

// UpdateNotebookInput carries partial updates; nil fields are left unchanged. An empty
// CoverDocumentID clears the cover image.
type UpdateNotebookInput struct {
	Title           *string          `json:"title,omitempty"`
	CoverColor      *string          `json:"coverColor,omitempty"`
	CoverDocumentID *string          `json:"coverDocumentId,omitempty"`
	Settings        *json.RawMessage `json:"settingsJson,omitempty"`
}

// Create inserts a notebook at the end of the shelf. The caller adds its first page.
func (r *NotebooksRepo) Create(in CreateNotebookInput) (*domain.Notebook, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	var next int
	if rows, err := r.db.Query(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notebooks WHERE deleted_at IS NULL;`); err == nil {
		if rows.Next() {
			_ = rows.Scan(&next)
		}
		rows.Close()
	}
	now := r.clock.Now().UTC()
	color := strings.TrimSpace(in.CoverColor)
	if color == "" {
		color = "ink"
	}
	n := &domain.Notebook{
		ID: id.String(), Title: strings.TrimSpace(in.Title), CoverColor: color, Settings: json.RawMessage("{}"),
		SortOrder: next, CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := n.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO notebooks (id, title, cover_color, cover_document_id, settings_json, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 1);`,
		n.ID, n.Title, n.CoverColor, string(n.Settings), n.SortOrder, n.CreatedAt.Format(timeFormat), n.UpdatedAt.Format(timeFormat),
	); err != nil {
		return nil, fmt.Errorf("insert notebook: %w", err)
	}
	return n, nil
}

// Get returns a live (not trashed, not tombstoned) notebook.
func (r *NotebooksRepo) Get(id string) (*domain.Notebook, error) {
	n, err := r.GetAny(id)
	if err != nil {
		return nil, err
	}
	if n.DeletedAt != nil || n.DeletingAt != nil {
		return nil, ErrNotFound
	}
	return n, nil
}

// List returns every live notebook in shelf order.
func (r *NotebooksRepo) List() ([]*domain.Notebook, error) {
	return r.list(`SELECT ` + notebookColumns + ` FROM notebooks WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY sort_order, created_at, id;`)
}

func (r *NotebooksRepo) Update(id string, in UpdateNotebookInput) (*domain.Notebook, error) {
	n, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Title != nil {
		n.Title = strings.TrimSpace(*in.Title)
	}
	if in.CoverColor != nil && strings.TrimSpace(*in.CoverColor) != "" {
		n.CoverColor = strings.TrimSpace(*in.CoverColor)
	}
	if in.CoverDocumentID != nil {
		if strings.TrimSpace(*in.CoverDocumentID) == "" {
			n.CoverDocumentID = nil
		} else {
			v := strings.TrimSpace(*in.CoverDocumentID)
			n.CoverDocumentID = &v
		}
	}
	if in.Settings != nil {
		n.Settings = json.RawMessage(normalizeProps(*in.Settings))
	}
	n.UpdatedAt = r.clock.Now().UTC()
	n.Dirty = true
	if err := n.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`UPDATE notebooks SET title = ?, cover_color = ?, cover_document_id = ?, settings_json = ?, updated_at = ?, dirty = 1 WHERE id = ?;`,
		n.Title, n.CoverColor, nullPtr(n.CoverDocumentID), string(n.Settings), n.UpdatedAt.Format(timeFormat), n.ID,
	); err != nil {
		return nil, fmt.Errorf("update notebook: %w", err)
	}
	return n, nil
}

// Touch bumps updated_at without marking the row dirty, so the shelf's recency reflects page
// edits. Local only: the book row has nothing new to push.
func (r *NotebooksRepo) Touch(id string) error {
	now := r.clock.Now().UTC()
	if _, err := r.db.Exec(`UPDATE notebooks SET updated_at = ? WHERE id = ? AND deleted_at IS NULL;`, now.Format(timeFormat), id); err != nil {
		return fmt.Errorf("touch notebook: %w", err)
	}
	return nil
}

// Reorder rewrites shelf order from the full ordered id list.
func (r *NotebooksRepo) Reorder(ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(`UPDATE notebooks SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, i, now, id); err != nil {
			return fmt.Errorf("reorder notebooks: %w", err)
		}
	}
	return nil
}

// Trash moves a notebook to the Trash (PLAN §4.3). Its pages and ink are untouched: they
// follow the book and come back with it on Restore.
func (r *NotebooksRepo) Trash(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE notebooks SET deleting_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		now.Add(TrashRetention).Format(timeFormat), now.Format(timeFormat), id)
	if err != nil {
		return fmt.Errorf("trash notebook: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *NotebooksRepo) Restore(id string) error {
	n, err := r.GetAny(id)
	if err != nil {
		return err
	}
	if n.DeletedAt == nil && n.DeletingAt == nil {
		return ErrNotFound
	}
	now := r.clock.Now().UTC()
	if _, err := r.db.Exec(`UPDATE notebooks SET deleting_at = NULL, deleted_at = NULL, updated_at = ?, dirty = 1 WHERE id = ?;`, now.Format(timeFormat), id); err != nil {
		return fmt.Errorf("restore notebook: %w", err)
	}
	return nil
}

func (r *NotebooksRepo) ListTrash() ([]*domain.Notebook, error) {
	return r.list(`SELECT ` + notebookColumns + ` FROM notebooks WHERE deleted_at IS NULL AND deleting_at IS NOT NULL ORDER BY deleting_at ASC, id ASC;`)
}

// Delete tombstones a notebook ("delete forever"). Callers tombstone its pages and ink too
// (see the bridge) so they stop syncing.
func (r *NotebooksRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(`UPDATE notebooks SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id)
	if err != nil {
		return fmt.Errorf("delete notebook: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *NotebooksRepo) list(query string, args ...any) ([]*domain.Notebook, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query notebooks: %w", err)
	}
	defer rows.Close()
	out := []*domain.Notebook{}
	for rows.Next() {
		n, err := scanNotebook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.Notebook] ---

func (r *NotebooksRepo) EntityType() string { return protocol.EntityNotebook }

func (r *NotebooksRepo) Dirty() ([]*domain.Notebook, error) {
	return r.list(`SELECT ` + notebookColumns + ` FROM notebooks WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *NotebooksRepo) GetAny(id string) (*domain.Notebook, error) {
	rows, err := r.db.Query(`SELECT `+notebookColumns+` FROM notebooks WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query notebook: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNotebook(rows)
}

func (r *NotebooksRepo) Apply(n *domain.Notebook) error {
	if _, err := r.db.Exec(
		`INSERT INTO notebooks (id, title, cover_color, cover_document_id, settings_json, sort_order, created_at, updated_at, deleting_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title, cover_color = excluded.cover_color, cover_document_id = excluded.cover_document_id,
		   settings_json = excluded.settings_json, sort_order = excluded.sort_order, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		n.ID, n.Title, coverColorOr(n.CoverColor), nullPtr(n.CoverDocumentID), normalizeProps(n.Settings), n.SortOrder,
		n.CreatedAt.UTC().Format(timeFormat), n.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(n.DeletingAt), fmtNullTime(n.DeletedAt), n.Version,
	); err != nil {
		return fmt.Errorf("apply notebook: %w", err)
	}
	return nil
}

func (r *NotebooksRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE notebooks SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: a book row carries a title, a cover and guides, and a forked
// copy would be an empty book. Last-writer-wins converges, as it does for canvases.
func (r *NotebooksRepo) MeaningfulDiff(a, b *domain.Notebook) bool { return false }

func (r *NotebooksRepo) ConflictedCopy(local *domain.Notebook, suffix string) error { return nil }

func (r *NotebooksRepo) Decode(raw json.RawMessage) (*domain.Notebook, error) {
	var n domain.Notebook
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, fmt.Errorf("decode notebook: %w", err)
	}
	return &n, nil
}

func scanNotebook(rows Rows) (*domain.Notebook, error) {
	var (
		n                               domain.Notebook
		coverDoc, deletingAt, deletedAt sql.NullString
		settings, createdAt, updatedAt  string
		dirty                           int
	)
	if err := rows.Scan(&n.ID, &n.Title, &n.CoverColor, &coverDoc, &settings, &n.SortOrder, &createdAt, &updatedAt, &deletingAt, &deletedAt, &n.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan notebook: %w", err)
	}
	n.CoverDocumentID = nullStr(coverDoc)
	n.Settings = json.RawMessage(normalizeProps(json.RawMessage(settings)))
	var err error
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if n.DeletingAt, err = parseNullTime(deletingAt); err != nil {
		return nil, err
	}
	if n.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	n.Dirty = dirty != 0
	return &n, nil
}

func coverColorOr(c string) string {
	if strings.TrimSpace(c) == "" {
		return "ink"
	}
	return c
}

func nullPtr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ---- pages -----------------------------------------------------------------------------

type NotebookPagesRepo struct {
	db    Driver
	clock domain.Clock
}

const notebookPageColumns = `id, notebook_id, sort_order, paper_kind, paper_spacing, content_md, created_at, updated_at, deleted_at, version, dirty`

// AddPageInput describes a new page: where it goes (after AfterID, or at the end when empty)
// and its paper. The app passes the paper of the page the writer is on.
type AddPageInput struct {
	NotebookID   string `json:"notebookId"`
	AfterID      string `json:"afterId"`
	PaperKind    string `json:"paperKind"`
	PaperSpacing int    `json:"paperSpacing"`
	ContentMD    string `json:"contentMd"`
}

// UpdatePageInput carries partial updates; nil fields are left unchanged.
type UpdatePageInput struct {
	ContentMD    *string `json:"contentMd,omitempty"`
	PaperKind    *string `json:"paperKind,omitempty"`
	PaperSpacing *int    `json:"paperSpacing,omitempty"`
}

// Add inserts a page. Pages after the insertion point are shifted down one and marked dirty,
// so the order syncs whole.
func (r *NotebookPagesRepo) Add(in AddPageInput) (*domain.NotebookPage, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	pages, err := r.ListForNotebook(in.NotebookID)
	if err != nil {
		return nil, err
	}
	at := len(pages)
	if in.AfterID != "" {
		for i, p := range pages {
			if p.ID == in.AfterID {
				at = i + 1
				break
			}
		}
	}
	now := r.clock.Now().UTC()
	kind, spacing := in.PaperKind, in.PaperSpacing
	if kind == "" {
		kind = domain.DefaultPaperKind
	}
	if spacing == 0 {
		spacing = domain.DefaultPaperSpacing
	}
	p := &domain.NotebookPage{
		ID: id.String(), NotebookID: in.NotebookID, SortOrder: at, PaperKind: kind, PaperSpacing: spacing, ContentMD: in.ContentMD,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	// Make room: every page at or past the slot moves down one.
	if _, err := r.db.Exec(`UPDATE notebook_pages SET sort_order = sort_order + 1, updated_at = ?, dirty = 1 WHERE notebook_id = ? AND deleted_at IS NULL AND sort_order >= ?;`,
		now.Format(timeFormat), in.NotebookID, at); err != nil {
		return nil, fmt.Errorf("shift pages: %w", err)
	}
	if _, err := r.db.Exec(
		`INSERT INTO notebook_pages (id, notebook_id, sort_order, paper_kind, paper_spacing, content_md, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		p.ID, p.NotebookID, p.SortOrder, p.PaperKind, p.PaperSpacing, p.ContentMD, p.CreatedAt.Format(timeFormat), p.UpdatedAt.Format(timeFormat),
	); err != nil {
		return nil, fmt.Errorf("insert page: %w", err)
	}
	return p, nil
}

func (r *NotebookPagesRepo) Get(id string) (*domain.NotebookPage, error) {
	p, err := r.GetAny(id)
	if err != nil {
		return nil, err
	}
	if p.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return p, nil
}

// ListForNotebook returns a notebook's live pages in reading order.
func (r *NotebookPagesRepo) ListForNotebook(notebookID string) ([]*domain.NotebookPage, error) {
	return r.list(`SELECT `+notebookPageColumns+` FROM notebook_pages WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id;`, notebookID)
}

func (r *NotebookPagesRepo) Update(id string, in UpdatePageInput) (*domain.NotebookPage, error) {
	p, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.ContentMD != nil {
		p.ContentMD = *in.ContentMD
	}
	if in.PaperKind != nil {
		p.PaperKind = *in.PaperKind
	}
	if in.PaperSpacing != nil {
		p.PaperSpacing = *in.PaperSpacing
	}
	p.UpdatedAt = r.clock.Now().UTC()
	p.Dirty = true
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`UPDATE notebook_pages SET content_md = ?, paper_kind = ?, paper_spacing = ?, updated_at = ?, dirty = 1 WHERE id = ?;`,
		p.ContentMD, p.PaperKind, p.PaperSpacing, p.UpdatedAt.Format(timeFormat), p.ID,
	); err != nil {
		return nil, fmt.Errorf("update page: %w", err)
	}
	return p, nil
}

// Reorder rewrites a notebook's page order from the full ordered id list.
func (r *NotebookPagesRepo) Reorder(notebookID string, ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(`UPDATE notebook_pages SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND notebook_id = ? AND deleted_at IS NULL;`, i, now, id, notebookID); err != nil {
			return fmt.Errorf("reorder pages: %w", err)
		}
	}
	return nil
}

// Delete tombstones a page. There is no per-page Trash: the app confirms first. Later pages
// keep their sort_order (gaps are harmless; reads sort).
func (r *NotebookPagesRepo) Delete(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(`UPDATE notebook_pages SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("delete page: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteForNotebook tombstones every live page of a notebook, used when the book is purged.
func (r *NotebookPagesRepo) DeleteForNotebook(notebookID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(`UPDATE notebook_pages SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE notebook_id = ? AND deleted_at IS NULL;`, now, now, notebookID); err != nil {
		return fmt.Errorf("delete pages for notebook: %w", err)
	}
	return nil
}

func (r *NotebookPagesRepo) list(query string, args ...any) ([]*domain.NotebookPage, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query notebook pages: %w", err)
	}
	defer rows.Close()
	out := []*domain.NotebookPage{}
	for rows.Next() {
		p, err := scanNotebookPage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.NotebookPage] ---

func (r *NotebookPagesRepo) EntityType() string { return protocol.EntityNotebookPage }

func (r *NotebookPagesRepo) Dirty() ([]*domain.NotebookPage, error) {
	return r.list(`SELECT ` + notebookPageColumns + ` FROM notebook_pages WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *NotebookPagesRepo) GetAny(id string) (*domain.NotebookPage, error) {
	rows, err := r.db.Query(`SELECT `+notebookPageColumns+` FROM notebook_pages WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query notebook page: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNotebookPage(rows)
}

func (r *NotebookPagesRepo) Apply(p *domain.NotebookPage) error {
	kind, spacing := p.PaperKind, p.PaperSpacing
	if !domain.PaperKinds[kind] {
		kind = domain.DefaultPaperKind
	}
	if !domain.PaperSpacings[spacing] {
		spacing = domain.DefaultPaperSpacing
	}
	if _, err := r.db.Exec(
		`INSERT INTO notebook_pages (id, notebook_id, sort_order, paper_kind, paper_spacing, content_md, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   notebook_id = excluded.notebook_id, sort_order = excluded.sort_order, paper_kind = excluded.paper_kind,
		   paper_spacing = excluded.paper_spacing, content_md = excluded.content_md, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		p.ID, p.NotebookID, p.SortOrder, kind, spacing, p.ContentMD, p.CreatedAt.UTC().Format(timeFormat), p.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(p.DeletedAt), p.Version,
	); err != nil {
		return fmt.Errorf("apply notebook page: %w", err)
	}
	return nil
}

func (r *NotebookPagesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE notebook_pages SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: a page's text is content, so a losing local edit is kept as a copy rather
// than dropped. Paper and order changes are not worth a fork; a tombstone is.
func (r *NotebookPagesRepo) MeaningfulDiff(a, b *domain.NotebookPage) bool {
	if a.ContentMD != b.ContentMD {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

// ConflictedCopy keeps the losing local text as the page right after the original, on the same
// paper, headed by a line saying where it came from (PLAN-notebooks.md §4). Ink stays with the
// original page: strokes are not text and cannot fork meaningfully.
func (r *NotebookPagesRepo) ConflictedCopy(local *domain.NotebookPage, suffix string) error {
	if strings.TrimSpace(local.ContentMD) == "" {
		return nil
	}
	_, err := r.Add(AddPageInput{
		NotebookID:   local.NotebookID,
		AfterID:      local.ID,
		PaperKind:    local.PaperKind,
		PaperSpacing: local.PaperSpacing,
		ContentMD:    "*" + strings.Trim(suffix, "()") + "*\n\n" + local.ContentMD,
	})
	return err
}

func (r *NotebookPagesRepo) Decode(raw json.RawMessage) (*domain.NotebookPage, error) {
	var p domain.NotebookPage
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("decode notebook page: %w", err)
	}
	return &p, nil
}

func scanNotebookPage(rows Rows) (*domain.NotebookPage, error) {
	var (
		p                    domain.NotebookPage
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&p.ID, &p.NotebookID, &p.SortOrder, &p.PaperKind, &p.PaperSpacing, &p.ContentMD, &createdAt, &updatedAt, &deletedAt, &p.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan notebook page: %w", err)
	}
	var err error
	if p.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if p.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if p.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	p.Dirty = dirty != 0
	return &p, nil
}

// ---- ink -------------------------------------------------------------------------------

// NotebookInkRepo owns the ink groups drawn on pages: NoteInkRepo's contract, keyed to a page.
type NotebookInkRepo struct {
	db    Driver
	clock domain.Clock
}

const notebookInkColumns = `id, notebook_id, page_id, data_json, created_at, updated_at, deleted_at, version, dirty`

// UpsertMany creates or overwrites a batch of groups on one page, returning the rows in input
// order. A known id must belong to the same page. Upserting a tombstoned id brings it back.
func (r *NotebookInkRepo) UpsertMany(notebookID, pageID string, inputs []NoteInkInput) ([]*domain.NotebookPageInk, error) {
	now := r.clock.Now().UTC()
	out := make([]*domain.NotebookPageInk, 0, len(inputs))
	for _, in := range inputs {
		g := &domain.NotebookPageInk{
			ID: strings.TrimSpace(in.ID), NotebookID: notebookID, PageID: pageID, Data: json.RawMessage(normalizeProps(in.Data)),
			CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
		}
		if existing, err := r.GetAny(g.ID); err == nil {
			if existing.PageID != pageID {
				return nil, errors.Join(domain.ErrInvalidNotebookPageInk, errors.New("ink group belongs to another page"))
			}
			g.CreatedAt = existing.CreatedAt
			g.Version = existing.Version
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := g.Validate(); err != nil {
			return nil, err
		}
		if _, err := r.db.Exec(
			`INSERT INTO notebook_page_ink (id, notebook_id, page_id, data_json, created_at, updated_at, deleted_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   data_json = excluded.data_json, updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1;`,
			g.ID, g.NotebookID, g.PageID, string(g.Data), g.CreatedAt.Format(timeFormat), g.UpdatedAt.Format(timeFormat), g.Version,
		); err != nil {
			return nil, fmt.Errorf("upsert notebook ink: %w", err)
		}
		out = append(out, g)
	}
	return out, nil
}

// ListForPage returns a page's live groups in the order they were drawn.
func (r *NotebookInkRepo) ListForPage(pageID string) ([]*domain.NotebookPageInk, error) {
	return r.list(`SELECT `+notebookInkColumns+` FROM notebook_page_ink WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, pageID)
}

func (r *NotebookInkRepo) DeleteMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	in, idArgs := placeholders(ids)
	now := r.clock.Now().UTC().Format(timeFormat)
	args := append([]any{now, now}, idArgs...)
	res, err := r.db.Exec(`UPDATE notebook_page_ink SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id IN (`+in+`) AND deleted_at IS NULL;`, args...)
	if err != nil {
		return 0, fmt.Errorf("delete notebook ink: %w", err)
	}
	affected, _ := res.RowsAffected()
	return affected, nil
}

// DeleteForPage tombstones a page's ink (the page was deleted).
func (r *NotebookInkRepo) DeleteForPage(pageID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(`UPDATE notebook_page_ink SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE page_id = ? AND deleted_at IS NULL;`, now, now, pageID); err != nil {
		return fmt.Errorf("delete ink for page: %w", err)
	}
	return nil
}

// DeleteForNotebook tombstones every live group in a notebook (the book was purged).
func (r *NotebookInkRepo) DeleteForNotebook(notebookID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(`UPDATE notebook_page_ink SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE notebook_id = ? AND deleted_at IS NULL;`, now, now, notebookID); err != nil {
		return fmt.Errorf("delete ink for notebook: %w", err)
	}
	return nil
}

func (r *NotebookInkRepo) list(query string, args ...any) ([]*domain.NotebookPageInk, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query notebook ink: %w", err)
	}
	defer rows.Close()
	out := []*domain.NotebookPageInk{}
	for rows.Next() {
		g, err := scanNotebookInk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.NotebookPageInk] ---

func (r *NotebookInkRepo) EntityType() string { return protocol.EntityNotebookPageInk }

func (r *NotebookInkRepo) Dirty() ([]*domain.NotebookPageInk, error) {
	return r.list(`SELECT ` + notebookInkColumns + ` FROM notebook_page_ink WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *NotebookInkRepo) GetAny(id string) (*domain.NotebookPageInk, error) {
	rows, err := r.db.Query(`SELECT `+notebookInkColumns+` FROM notebook_page_ink WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query notebook ink: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNotebookInk(rows)
}

func (r *NotebookInkRepo) Apply(g *domain.NotebookPageInk) error {
	if _, err := r.db.Exec(
		`INSERT INTO notebook_page_ink (id, notebook_id, page_id, data_json, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   notebook_id = excluded.notebook_id, page_id = excluded.page_id, data_json = excluded.data_json,
		   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		g.ID, g.NotebookID, g.PageID, normalizeProps(g.Data), g.CreatedAt.UTC().Format(timeFormat), g.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(g.DeletedAt), g.Version,
	); err != nil {
		return fmt.Errorf("apply notebook ink: %w", err)
	}
	return nil
}

func (r *NotebookInkRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE notebook_page_ink SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false, as for note ink: a forked group would draw the same strokes
// twice, so a concurrent edit of one group is last-writer-wins.
func (r *NotebookInkRepo) MeaningfulDiff(a, b *domain.NotebookPageInk) bool { return false }

func (r *NotebookInkRepo) ConflictedCopy(local *domain.NotebookPageInk, suffix string) error {
	return nil
}

func (r *NotebookInkRepo) Decode(raw json.RawMessage) (*domain.NotebookPageInk, error) {
	var g domain.NotebookPageInk
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, fmt.Errorf("decode notebook ink: %w", err)
	}
	return &g, nil
}

func scanNotebookInk(rows Rows) (*domain.NotebookPageInk, error) {
	var (
		g                          domain.NotebookPageInk
		deletedAt                  sql.NullString
		data, createdAt, updatedAt string
		dirty                      int
	)
	if err := rows.Scan(&g.ID, &g.NotebookID, &g.PageID, &data, &createdAt, &updatedAt, &deletedAt, &g.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan notebook ink: %w", err)
	}
	g.Data = json.RawMessage(normalizeProps(json.RawMessage(data)))
	var err error
	if g.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if g.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if g.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	g.Dirty = dirty != 0
	return &g, nil
}

// ---- search ----------------------------------------------------------------------------

// PageHit is one page whose text matched a search: enough to show "<Notebook> · p. N" with a
// snippet and open the notebook at that page.
type PageHit struct {
	PageID        string `json:"pageId"`
	NotebookID    string `json:"notebookId"`
	NotebookTitle string `json:"notebookTitle"`
	// 1-based position in the notebook.
	PageNumber int    `json:"pageNumber"`
	Snippet    string `json:"snippet"`
	UpdatedAt  string `json:"updatedAt"`
}

// SearchPages finds live pages in live notebooks whose text contains every token, most
// recently edited first. Same LIKE matching as SearchRepo, for the same portability reason.
func (r *NotebookPagesRepo) SearchPages(query string, limit int) ([]PageHit, error) {
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		return []PageHit{}, nil
	}
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitDefault
	}
	conds := make([]string, 0, len(tokens))
	args := make([]any, 0, len(tokens))
	for _, tok := range tokens {
		conds = append(conds, `lower(p.content_md) LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(tok)+"%")
	}
	args = append(args, limit)
	rows, err := r.db.Query(fmt.Sprintf(
		`SELECT p.id, p.notebook_id, n.title, p.content_md, p.updated_at,
		        (SELECT COUNT(*) FROM notebook_pages q WHERE q.notebook_id = p.notebook_id AND q.deleted_at IS NULL
		           AND (q.sort_order < p.sort_order OR (q.sort_order = p.sort_order AND (q.created_at < p.created_at OR (q.created_at = p.created_at AND q.id < p.id))))) + 1
		 FROM notebook_pages p JOIN notebooks n ON n.id = p.notebook_id
		 WHERE p.deleted_at IS NULL AND n.deleted_at IS NULL AND n.deleting_at IS NULL AND %s
		 ORDER BY p.updated_at DESC, p.id LIMIT ?;`, strings.Join(conds, " AND ")), args...)
	if err != nil {
		return nil, fmt.Errorf("search pages: %w", err)
	}
	defer rows.Close()
	out := []PageHit{}
	for rows.Next() {
		var h PageHit
		var body string
		if err := rows.Scan(&h.PageID, &h.NotebookID, &h.NotebookTitle, &body, &h.UpdatedAt, &h.PageNumber); err != nil {
			return nil, fmt.Errorf("scan page hit: %w", err)
		}
		h.Snippet = snippet(tokens, body, "")
		out = append(out, h)
	}
	return out, rows.Err()
}
