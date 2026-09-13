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

// ListsRepo is the CRUD + sync repository for project lists (domain.List): drag-ordered
// collections of tasks scoped to one project. Their rows live in ListItemsRepo.
type ListsRepo struct {
	db    Driver
	clock domain.Clock
}

const listColumns = `id, project_id, name, sort_order, created_at, updated_at, deleted_at, version, dirty`

// CreateListInput carries the client-supplied fields for a new list.
type CreateListInput struct {
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
}

// UpdateListInput carries partial updates; nil fields are left unchanged.
type UpdateListInput struct {
	Name      *string `json:"name,omitempty"`
	SortOrder *int    `json:"sortOrder,omitempty"`
}

// Create inserts a new list at the end of its project's lists (UUIDv7 id, version 0, dirty).
func (r *ListsRepo) Create(in CreateListInput) (*domain.List, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	order, err := nextSortOrder(r.db, `lists`, `project_id`, in.ProjectID)
	if err != nil {
		return nil, err
	}
	l := &domain.List{
		ID: id.String(), ProjectID: in.ProjectID, Name: strings.TrimSpace(in.Name), SortOrder: order,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := l.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO lists (id, project_id, name, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
		l.ID, l.ProjectID, l.Name, l.SortOrder,
		l.CreatedAt.Format(timeFormat), l.UpdatedAt.Format(timeFormat), l.Version, boolToInt(l.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert list: %w", err)
	}
	return l, nil
}

// nextSortOrder returns the sort_order that appends after every live row of `table` sharing
// the given scope column value.
func nextSortOrder(db Driver, table, scopeCol, scope string) (int, error) {
	rows, err := db.Query(
		`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM `+table+` WHERE `+scopeCol+` = ? AND deleted_at IS NULL;`, scope)
	if err != nil {
		return 0, fmt.Errorf("next sort order for %s: %w", table, err)
	}
	defer rows.Close()
	next := 0
	if rows.Next() {
		if err := rows.Scan(&next); err != nil {
			return 0, err
		}
	}
	return next, rows.Err()
}

// Get returns a single live list by id, or ErrNotFound.
func (r *ListsRepo) Get(id string) (*domain.List, error) {
	rows, err := r.db.Query(`SELECT `+listColumns+` FROM lists WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query list: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanList(rows)
}

// ListForProject returns a project's live lists in their user-defined order.
func (r *ListsRepo) ListForProject(projectID string) ([]*domain.List, error) {
	return r.list(`SELECT `+listColumns+` FROM lists
		WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id;`, projectID)
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *ListsRepo) Update(id string, in UpdateListInput) (*domain.List, error) {
	l, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		l.Name = strings.TrimSpace(*in.Name)
	}
	if in.SortOrder != nil {
		l.SortOrder = *in.SortOrder
	}
	l.UpdatedAt = r.clock.Now().UTC()
	l.Dirty = true
	if err := l.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE lists SET name = ?, sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		l.Name, l.SortOrder, l.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update list: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return l, nil
}

// Reorder assigns sort_order = position for each id within the given project, only touching
// rows that belong to it. Marks each dirty so the order syncs.
func (r *ListsRepo) Reorder(projectID string, ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(
			`UPDATE lists SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND project_id = ? AND deleted_at IS NULL;`,
			i, now, id, projectID,
		); err != nil {
			return fmt.Errorf("reorder lists: %w", err)
		}
	}
	return nil
}

// Delete soft-deletes a list. Its items are tombstoned by the caller (bridge) via
// ListItemsRepo.DeleteForList; the tasks themselves are never touched.
func (r *ListsRepo) Delete(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE lists SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("delete list: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *ListsRepo) list(query string, args ...any) ([]*domain.List, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query lists: %w", err)
	}
	defer rows.Close()
	out := []*domain.List{}
	for rows.Next() {
		l, err := scanList(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.List] --------------------------------------------

func (r *ListsRepo) EntityType() string { return protocol.EntityList }

func (r *ListsRepo) Dirty() ([]*domain.List, error) {
	return r.list(`SELECT ` + listColumns + ` FROM lists WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *ListsRepo) GetAny(id string) (*domain.List, error) {
	rows, err := r.db.Query(`SELECT `+listColumns+` FROM lists WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query list: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanList(rows)
}

func (r *ListsRepo) Apply(l *domain.List) error {
	var deletedAt any
	if l.DeletedAt != nil {
		deletedAt = l.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO lists (id, project_id, name, sort_order, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   project_id = excluded.project_id, name = excluded.name, sort_order = excluded.sort_order,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		l.ID, l.ProjectID, l.Name, l.SortOrder,
		l.CreatedAt.UTC().Format(timeFormat), l.UpdatedAt.UTC().Format(timeFormat), deletedAt, l.Version,
	)
	if err != nil {
		return fmt.Errorf("apply list: %w", err)
	}
	return nil
}

func (r *ListsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE lists SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *ListsRepo) MeaningfulDiff(a, b *domain.List) bool {
	if a.ProjectID != b.ProjectID || a.Name != b.Name {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *ListsRepo) Decode(raw json.RawMessage) (*domain.List, error) {
	var l domain.List
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, fmt.Errorf("decode list: %w", err)
	}
	return &l, nil
}

// ConflictedCopy forks a losing local list into a fresh (empty) row (§7.3). Its items stay
// with the winning server copy — a list's items are separate rows that converge on their own.
func (r *ListsRepo) ConflictedCopy(local *domain.List, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	name := local.Name
	if name == "" {
		name = "Untitled"
	}
	if _, err := r.db.Exec(
		`INSERT INTO lists (id, project_id, name, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), local.ProjectID, name+" "+suffix, local.SortOrder, now, now,
	); err != nil {
		return fmt.Errorf("insert conflicted list: %w", err)
	}
	return nil
}

func scanList(rows Rows) (*domain.List, error) {
	var (
		l                    domain.List
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&l.ID, &l.ProjectID, &l.Name, &l.SortOrder, &createdAt, &updatedAt, &deletedAt, &l.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan list: %w", err)
	}
	var err error
	if l.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if l.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if l.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	l.Dirty = dirty != 0
	return &l, nil
}

// =============================================================================
// List items
// =============================================================================

// ListItemsRepo owns the rows of a list: task references and headings sharing one flat
// sort order (domain.ListItem). Task items use a deterministic id derived from the
// (list, task) tuple so the same task added on two devices converges to one row.
type ListItemsRepo struct {
	db    Driver
	clock domain.Clock
}

const listItemColumns = `id, list_id, kind, task_id, title, sort_order, created_at, updated_at, deleted_at, version, dirty`

// UpdateListItemInput carries partial updates for an item (only headings have editable text).
type UpdateListItemInput struct {
	Title *string `json:"title,omitempty"`
}

// AddTask appends a task to a list (idempotent). A tombstoned item for the same tuple is
// revived at the end of the list rather than duplicated.
func (r *ListItemsRepo) AddTask(listID, taskID string) (*domain.ListItem, error) {
	now := r.clock.Now().UTC()
	tid := taskID
	item := &domain.ListItem{
		ID: domain.ListTaskItemID(listID, taskID), ListID: listID, Kind: domain.ListItemTask, TaskID: &tid,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := item.Validate(); err != nil {
		return nil, err
	}
	existing, err := r.GetAny(item.ID)
	switch {
	case err == nil && existing.DeletedAt == nil:
		return existing, nil // already in the list
	case err == nil:
		order, err := nextSortOrder(r.db, `list_items`, `list_id`, listID)
		if err != nil {
			return nil, err
		}
		if _, err := r.db.Exec(
			`UPDATE list_items SET deleted_at = NULL, sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ?;`,
			order, now.Format(timeFormat), item.ID); err != nil {
			return nil, fmt.Errorf("revive list item: %w", err)
		}
		existing.DeletedAt = nil
		existing.SortOrder = order
		existing.UpdatedAt = now
		existing.Dirty = true
		return existing, nil
	case errors.Is(err, ErrNotFound):
		return r.insert(item)
	default:
		return nil, err
	}
}

// AddHeading appends a heading (sublist) to a list.
func (r *ListItemsRepo) AddHeading(listID, title string) (*domain.ListItem, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	item := &domain.ListItem{
		ID: id.String(), ListID: listID, Kind: domain.ListItemHeading, Title: strings.TrimSpace(title),
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := item.Validate(); err != nil {
		return nil, err
	}
	return r.insert(item)
}

func (r *ListItemsRepo) insert(item *domain.ListItem) (*domain.ListItem, error) {
	order, err := nextSortOrder(r.db, `list_items`, `list_id`, item.ListID)
	if err != nil {
		return nil, err
	}
	item.SortOrder = order
	if _, err := r.db.Exec(
		`INSERT INTO list_items (id, list_id, kind, task_id, title, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		item.ID, item.ListID, item.Kind, item.TaskID, item.Title, item.SortOrder,
		item.CreatedAt.Format(timeFormat), item.UpdatedAt.Format(timeFormat), item.Version, boolToInt(item.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert list item: %w", err)
	}
	return item, nil
}

// Get returns a live item by id, or ErrNotFound.
func (r *ListItemsRepo) Get(id string) (*domain.ListItem, error) {
	rows, err := r.db.Query(`SELECT `+listItemColumns+` FROM list_items WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query list item: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanListItem(rows)
}

// Update edits a heading's title. Task items carry no editable text.
func (r *ListItemsRepo) Update(id string, in UpdateListItemInput) (*domain.ListItem, error) {
	item, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Title != nil {
		if item.Kind != domain.ListItemHeading {
			return nil, errors.Join(domain.ErrInvalidListItem, errors.New("only headings have a title"))
		}
		item.Title = strings.TrimSpace(*in.Title)
	}
	item.UpdatedAt = r.clock.Now().UTC()
	item.Dirty = true
	res, err := r.db.Exec(
		`UPDATE list_items SET title = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		item.Title, item.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update list item: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return item, nil
}

// Reorder assigns sort_order = position for each id within the given list, only touching
// rows that belong to it (the drag-and-drop write path). Marks each dirty so the order syncs.
func (r *ListItemsRepo) Reorder(listID string, ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(
			`UPDATE list_items SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND list_id = ? AND deleted_at IS NULL;`,
			i, now, id, listID,
		); err != nil {
			return fmt.Errorf("reorder list items: %w", err)
		}
	}
	return nil
}

// Remove soft-deletes an item (idempotent on already-removed rows: ErrNotFound).
func (r *ListItemsRepo) Remove(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE list_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("remove list item: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// ListForList returns a list's live items in display order.
func (r *ListItemsRepo) ListForList(listID string) ([]*domain.ListItem, error) {
	return r.list(`SELECT `+listItemColumns+` FROM list_items
		WHERE list_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id;`, listID)
}

// ListIDsForTask returns the ids of the live lists a task appears in.
func (r *ListItemsRepo) ListIDsForTask(taskID string) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT DISTINCT li.list_id FROM list_items li JOIN lists l ON l.id = li.list_id
		 WHERE li.task_id = ? AND li.deleted_at IS NULL AND l.deleted_at IS NULL;`, taskID)
	if err != nil {
		return nil, fmt.Errorf("query lists for task: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// RemoveTaskFromProject tombstones the task's items in every list of the given project —
// used when a task leaves a project, since a list can only hold its project's tasks.
func (r *ListItemsRepo) RemoveTaskFromProject(projectID, taskID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	_, err := r.db.Exec(
		`UPDATE list_items SET deleted_at = ?, updated_at = ?, dirty = 1
		 WHERE task_id = ? AND deleted_at IS NULL
		   AND list_id IN (SELECT id FROM lists WHERE project_id = ? AND deleted_at IS NULL);`,
		now, now, taskID, projectID)
	if err != nil {
		return fmt.Errorf("remove task from project lists: %w", err)
	}
	return nil
}

// DeleteForList tombstones every live item of a list (used when the list is deleted).
func (r *ListItemsRepo) DeleteForList(listID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE list_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE list_id = ? AND deleted_at IS NULL;`,
		now, now, listID); err != nil {
		return fmt.Errorf("delete list items: %w", err)
	}
	return nil
}

func (r *ListItemsRepo) list(query string, args ...any) ([]*domain.ListItem, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query list items: %w", err)
	}
	defer rows.Close()
	out := []*domain.ListItem{}
	for rows.Next() {
		item, err := scanListItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.ListItem] ----------------------------------------

func (r *ListItemsRepo) EntityType() string { return protocol.EntityListItem }

func (r *ListItemsRepo) Dirty() ([]*domain.ListItem, error) {
	return r.list(`SELECT ` + listItemColumns + ` FROM list_items WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *ListItemsRepo) GetAny(id string) (*domain.ListItem, error) {
	rows, err := r.db.Query(`SELECT `+listItemColumns+` FROM list_items WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query list item: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanListItem(rows)
}

func (r *ListItemsRepo) Apply(item *domain.ListItem) error {
	var deletedAt any
	if item.DeletedAt != nil {
		deletedAt = item.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO list_items (id, list_id, kind, task_id, title, sort_order, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   list_id = excluded.list_id, kind = excluded.kind, task_id = excluded.task_id,
		   title = excluded.title, sort_order = excluded.sort_order,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		item.ID, item.ListID, item.Kind, item.TaskID, item.Title, item.SortOrder,
		item.CreatedAt.UTC().Format(timeFormat), item.UpdatedAt.UTC().Format(timeFormat), deletedAt, item.Version,
	)
	if err != nil {
		return fmt.Errorf("apply list item: %w", err)
	}
	return nil
}

func (r *ListItemsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE list_items SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: only a heading's text is user content worth forking; ordering and
// alive-vs-deleted converge last-write-wins (a task item is an immutable tuple).
func (r *ListItemsRepo) MeaningfulDiff(a, b *domain.ListItem) bool {
	return a.Kind == domain.ListItemHeading && b.Kind == domain.ListItemHeading && a.Title != b.Title &&
		a.DeletedAt == nil && b.DeletedAt == nil
}

// ConflictedCopy forks a losing local heading into a fresh heading next to it (§7.3).
func (r *ListItemsRepo) ConflictedCopy(local *domain.ListItem, suffix string) error {
	if local.Kind != domain.ListItemHeading {
		return nil
	}
	_, err := r.AddHeading(local.ListID, local.Title+" "+suffix)
	return err
}

func (r *ListItemsRepo) Decode(raw json.RawMessage) (*domain.ListItem, error) {
	var item domain.ListItem
	if err := json.Unmarshal(raw, &item); err != nil {
		return nil, fmt.Errorf("decode list item: %w", err)
	}
	return &item, nil
}

func scanListItem(rows Rows) (*domain.ListItem, error) {
	var (
		item                 domain.ListItem
		taskID, deletedAt    sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&item.ID, &item.ListID, &item.Kind, &taskID, &item.Title, &item.SortOrder, &createdAt, &updatedAt, &deletedAt, &item.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan list item: %w", err)
	}
	if taskID.Valid {
		item.TaskID = &taskID.String
	}
	var err error
	if item.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if item.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if item.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	item.Dirty = dirty != 0
	return &item, nil
}
