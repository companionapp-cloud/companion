package store

import (
	"errors"
	"fmt"

	"companion/core/domain"
)

// Clearing data (Settings › Danger Zone). A clear permanently deletes one slice of the
// workspace, or all of it, the same way "Delete forever" does: every row becomes a tombstone
// marked dirty, so the deletion syncs to the user's other devices and the server like any
// other. It skips the Trash (trashed rows of the slice go too), and it also blanks the text a
// tombstone would otherwise keep, here and in the server's copy once it pushes, so cleared
// content doesn't linger in either database. Fields the server validates on push (a
// document's filename, an object type's schema, a task's reminders, a repeat rule) keep
// valid values, or the push would fail and wedge sync.

// DataKind names one slice of the workspace the Danger Zone clears.
type DataKind string

const (
	DataNotes    DataKind = "notes"    // notes, trashed ones included, and the ink drawn on them
	DataTasks    DataKind = "tasks"    // tasks, repeating tasks and their occurrences, read receipts
	DataCanvases DataKind = "canvases" // boards with their cards and connections
	DataChats    DataKind = "chats"    // conversations with agents (the agents themselves stay)
	DataCalendar DataKind = "calendar" // calendar accounts, subscriptions and their events
	DataAreas    DataKind = "areas"    // areas, projects and their lists; filed content stays, unfiled
	DataFiles    DataKind = "files"    // every attachment
	// The rest only go with everything else: they are settings more than content.
	DataObjectTypes DataKind = "objectTypes"
	DataAgents      DataKind = "agents"
	DataExports     DataKind = "exports"
)

// AllDataKinds is every kind, in the order a clear runs them. Content goes before the
// containers and files it points at, so the file purge at the end sees who still uses what.
var AllDataKinds = []DataKind{
	DataNotes, DataTasks, DataCanvases, DataChats, DataCalendar, DataAreas,
	DataFiles, DataObjectTypes, DataAgents, DataExports,
}

// ValidDataKind reports whether k names a kind ClearData accepts.
func ValidDataKind(k DataKind) bool {
	for _, known := range AllDataKinds {
		if k == known {
			return true
		}
	}
	return false
}

// deletedFilename stands in for a cleared document's name. The server rejects a document row
// with an empty filename, tombstones included, so the name is replaced rather than blanked.
const deletedFilename = "deleted"

// DataSummary counts the live rows (the Trash included) behind each Danger Zone row, so the
// page can say what a clear would take.
type DataSummary struct {
	Notes            int64 `json:"notes"`
	Tasks            int64 `json:"tasks"`
	Canvases         int64 `json:"canvases"`
	Chats            int64 `json:"chats"`
	Calendars        int64 `json:"calendars"`
	CalendarAccounts int64 `json:"calendarAccounts"`
	Areas            int64 `json:"areas"`
	Projects         int64 `json:"projects"`
	Files            int64 `json:"files"`
	ObjectTypes      int64 `json:"objectTypes"`
	Agents           int64 `json:"agents"`
	Exports          int64 `json:"exports"`
}

// DataSummary counts what each kind would clear right now.
func (s *Store) DataSummary() (*DataSummary, error) {
	sum := &DataSummary{}
	for _, c := range []struct {
		into  *int64
		table string
	}{
		{&sum.Notes, "notes"},
		{&sum.Tasks, "tasks"},
		{&sum.Canvases, "canvases"},
		{&sum.Chats, "chats"},
		{&sum.Calendars, "calendar_feeds"},
		{&sum.CalendarAccounts, "calendar_accounts"},
		{&sum.Areas, "areas"},
		{&sum.Projects, "projects"},
		{&sum.Files, "documents"},
		{&sum.ObjectTypes, "object_types"},
		{&sum.Agents, "llm_configs"},
		{&sum.Exports, "export_destinations"},
	} {
		n, err := s.countLive(c.table)
		if err != nil {
			return nil, err
		}
		*c.into = n
	}
	return sum, nil
}

// countLive counts a table's rows that aren't tombstones. table is a compile-time constant
// from the callers in this file, never input, so splicing it into the SQL is safe.
func (s *Store) countLive(table string) (int64, error) {
	rows, err := s.db.Query(`SELECT count(*) FROM ` + table + ` WHERE deleted_at IS NULL;`)
	if err != nil {
		return 0, fmt.Errorf("count %s: %w", table, err)
	}
	defer rows.Close()
	var n int64
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, err
		}
	}
	return n, rows.Err()
}

// ClearReport is what a clear did, plus the leftovers outside the database the caller removes
// once the rows are gone.
type ClearReport struct {
	// Cleared counts the live rows each kind deleted (its main rows: notes, tasks, boards, ...).
	Cleared map[DataKind]int64
	// SecretRefs are device secret-store handles that deleted rows pointed at: calendar
	// passwords, agent API keys, Git credentials.
	SecretRefs []string
	// GitExports are the Git export destinations deleted, whose local repositories go too.
	GitExports []string
	// OrphanBlobs are the content hashes of deleted files that no live file still uses, whose
	// bytes this device can drop.
	OrphanBlobs []string
}

// ClearData permanently deletes the given kinds of data in one transaction (see the top of
// this file), then rebuilds the link index from what is left. Files the cleared content used
// are deleted with it unless something that stays still uses them (another note, a task, a
// board, an area or project cover).
func (s *Store) ClearData(kinds []DataKind) (*ClearReport, error) {
	want := map[DataKind]bool{}
	for _, k := range kinds {
		if !ValidDataKind(k) {
			return nil, fmt.Errorf("unknown data kind %q", k)
		}
		want[k] = true
	}
	rep := &ClearReport{Cleared: map[DataKind]int64{}}
	if len(want) == 0 {
		return rep, nil
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	err := s.Batch(func() error {
		// Read which files the cleared content uses before its text is blanked.
		files, err := s.filesUsedBy(want)
		if err != nil {
			return err
		}
		for _, k := range AllDataKinds {
			if !want[k] {
				continue
			}
			n, err := s.clearKind(k, now, rep)
			if err != nil {
				return fmt.Errorf("clear %s: %w", k, err)
			}
			rep.Cleared[k] = n
		}
		// DataFiles already took every file; otherwise delete the ones nothing uses anymore.
		purged := files
		if !want[DataFiles] {
			if purged, err = s.purgeUnusedFiles(files, now); err != nil {
				return err
			}
		}
		if rep.OrphanBlobs, err = s.orphanedHashes(purged); err != nil {
			return err
		}
		// The index is derived (links.go): re-deriving it from the rows that survived drops
		// every edge the cleared rows held, in either direction.
		if _, _, err := s.Links.Rebuild(); err != nil {
			return fmt.Errorf("rebuild links: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return rep, nil
}

// clearKind deletes one kind, returning how many of its live rows went.
func (s *Store) clearKind(k DataKind, now string, rep *ClearReport) (int64, error) {
	switch k {
	case DataNotes:
		return s.clearNotes(now)
	case DataTasks:
		return s.clearTasks(now)
	case DataCanvases:
		return s.clearCanvases(now)
	case DataChats:
		return s.clearChats(now)
	case DataCalendar:
		return s.clearCalendar(now, rep)
	case DataAreas:
		return s.clearAreas(now)
	case DataFiles:
		return s.clearFiles(now)
	case DataObjectTypes:
		return s.clearObjectTypes(now)
	case DataAgents:
		return s.clearAgents(now, rep)
	case DataExports:
		return s.clearExports(rep)
	}
	return 0, fmt.Errorf("unknown data kind %q", k)
}

// tombstone is the statement shape every kind uses: blank the given columns and tombstone the
// row, for live rows and for older tombstones that still carry text. set is the column list
// ("title = '', content_md = ''"; empty for a row with no text), leftover the condition that
// finds a tombstone with text. Both are compile-time constants from this file. deleted_at
// keeps an older tombstone's instant; updated_at and dirty move so the blanked row pushes again.
func (s *Store) tombstone(table, set, leftover, now string) error {
	if set != "" {
		set += ", "
	}
	q := `UPDATE ` + table + ` SET ` + set + `deleted_at = COALESCE(deleted_at, ?), updated_at = ?, dirty = 1
	       WHERE deleted_at IS NULL`
	if leftover != "" {
		q += ` OR ` + leftover
	}
	if _, err := s.db.Exec(q+`;`, now, now); err != nil {
		return fmt.Errorf("tombstone %s: %w", table, err)
	}
	return nil
}

// leaveContainers tombstones the memberships that file entities of the given types in an
// area or project. Their graph edges go with the link rebuild at the end.
func (s *Store) leaveContainers(now string, entityTypes ...string) error {
	in, args := placeholders(entityTypes)
	args = append([]any{now, now}, args...)
	if _, err := s.db.Exec(
		`UPDATE project_members SET deleted_at = ?, updated_at = ?, dirty = 1
		 WHERE deleted_at IS NULL AND entity_type IN (`+in+`);`, args...); err != nil {
		return fmt.Errorf("leave containers: %w", err)
	}
	return nil
}

func (s *Store) clearNotes(now string) (int64, error) {
	n, err := s.countLive("notes")
	if err != nil {
		return 0, err
	}
	if err := s.tombstone("note_ink", `data_json = '{}'`, `data_json <> '{}'`, now); err != nil {
		return 0, err
	}
	if err := s.leaveContainers(now, domain.NodeNote); err != nil {
		return 0, err
	}
	// object_type_id goes with the props: a plaintext account's server validates props
	// against the type on every push, tombstones included, and empty props could fail it.
	err = s.tombstone("notes",
		`title = '', content_md = '', date = NULL, object_type_id = NULL, props_json = '{}'`,
		`title <> '' OR content_md <> '' OR date IS NOT NULL OR object_type_id IS NOT NULL OR props_json <> '{}'`, now)
	return n, err
}

func (s *Store) clearTasks(now string) (int64, error) {
	n, err := s.countLive("tasks")
	if err != nil {
		return 0, err
	}
	// A task's place in a project list, its filing, and the reads of its reminders go with it.
	if _, err := s.db.Exec(
		`UPDATE list_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE kind = 'task' AND deleted_at IS NULL;`,
		now, now); err != nil {
		return 0, fmt.Errorf("remove tasks from lists: %w", err)
	}
	if err := s.leaveContainers(now, domain.NodeTask); err != nil {
		return 0, err
	}
	if err := s.tombstone("notification_reads", ``, ``, now); err != nil {
		return 0, err
	}
	if err := s.tombstone("pomodoros", ``, ``, now); err != nil {
		return 0, err
	}
	// Reminders and repeat rules stay: the server validates them on push and times a
	// repeating task's next copy from them, which a tombstoned seed no longer gets.
	err = s.tombstone("tasks",
		`title = '', notes_md = '', object_type_id = NULL, props_json = '{}'`,
		`title <> '' OR notes_md <> '' OR object_type_id IS NOT NULL OR props_json <> '{}'`, now)
	return n, err
}

func (s *Store) clearCanvases(now string) (int64, error) {
	n, err := s.countLive("canvases")
	if err != nil {
		return 0, err
	}
	if err := s.tombstone("canvas_edges", `label = ''`, `label <> ''`, now); err != nil {
		return 0, err
	}
	if err := s.tombstone("canvas_nodes", `data_json = '{}'`, `data_json <> '{}'`, now); err != nil {
		return 0, err
	}
	// Viewports are local-only rows with no content; nothing to sync.
	if _, err := s.db.Exec(`DELETE FROM canvas_views;`); err != nil {
		return 0, fmt.Errorf("clear canvas views: %w", err)
	}
	if err := s.leaveContainers(now, domain.NodeCanvas); err != nil {
		return 0, err
	}
	err = s.tombstone("canvases", `name = ''`, `name <> ''`, now)
	return n, err
}

func (s *Store) clearChats(now string) (int64, error) {
	n, err := s.countLive("chats")
	if err != nil {
		return 0, err
	}
	if err := s.tombstone("chat_messages",
		`text = '', tool_calls = NULL, tool_results = NULL`,
		`text <> '' OR tool_calls IS NOT NULL OR tool_results IS NOT NULL`, now); err != nil {
		return 0, err
	}
	err = s.tombstone("chats", `title = '', agent_session_id = NULL`, `title <> '' OR agent_session_id IS NOT NULL`, now)
	return n, err
}

// clearCalendar forgets every calendar account and subscription through the repos' own
// deletes, which never touch the provider: a CalDAV event's tombstone is marked as already in
// step, so no device sends a DELETE for it. Then it blanks what they held.
func (s *Store) clearCalendar(now string, rep *ClearReport) (int64, error) {
	n, err := s.countLive("calendar_feeds")
	if err != nil {
		return 0, err
	}
	accounts, err := s.CalendarAccounts.List()
	if err != nil {
		return 0, err
	}
	for _, a := range accounts {
		if a.CredentialRef != nil && *a.CredentialRef != "" {
			rep.SecretRefs = append(rep.SecretRefs, *a.CredentialRef)
		}
		if err := s.CalendarAccounts.Delete(a.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return 0, err
		}
	}
	feeds, err := s.CalendarFeeds.List()
	if err != nil {
		return 0, err
	}
	for _, f := range feeds {
		if err := s.CalendarFeeds.Delete(f.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return 0, err
		}
	}
	for _, t := range []struct{ table, set, leftover string }{
		{"calendar_events", `title = '', location = NULL, description = NULL`, `title <> '' OR location IS NOT NULL OR description IS NOT NULL`},
		{"calendar_objects", `ics = '', push_state = 'synced', push_error = NULL`, `ics <> ''`},
		// A private ICS link is a credential of its own, so the URL goes as well.
		{"calendar_feeds", `name = '', url = '', ics_text = NULL`, `name <> '' OR url <> '' OR ics_text IS NOT NULL`},
		{"calendar_accounts",
			`name = '', server_url = '', username = '', credential_enc = NULL, credential_ref = NULL, home_set_url = '', last_error = NULL`,
			`name <> '' OR server_url <> '' OR username <> '' OR credential_enc IS NOT NULL OR credential_ref IS NOT NULL`},
	} {
		if err := s.tombstone(t.table, t.set, t.leftover, now); err != nil {
			return 0, err
		}
	}
	if _, err := s.db.Exec(`DELETE FROM caldav_feed_state;`); err != nil {
		return 0, fmt.Errorf("clear calendar sync state: %w", err)
	}
	return n, s.leaveContainers(now, domain.MemberCalendar, domain.MemberCalendarAccount)
}

// clearAreas deletes every area, project and list. What was filed in them stays and becomes
// unfiled, as when a single project is deleted without its content.
func (s *Store) clearAreas(now string) (int64, error) {
	areas, err := s.countLive("areas")
	if err != nil {
		return 0, err
	}
	projects, err := s.countLive("projects")
	if err != nil {
		return 0, err
	}
	for _, t := range []struct{ table, set, leftover string }{
		{"list_items", `title = ''`, `title <> ''`},
		{"lists", `name = ''`, `name <> ''`},
		{"project_members", ``, ``},
		{"projects", `name = '', description_md = ''`, `name <> '' OR description_md <> ''`},
		{"areas", `name = '', description_md = ''`, `name <> '' OR description_md <> ''`},
	} {
		if err := s.tombstone(t.table, t.set, t.leftover, now); err != nil {
			return 0, err
		}
	}
	return areas + projects, nil
}

func (s *Store) clearFiles(now string) (int64, error) {
	n, err := s.countLive("documents")
	if err != nil {
		return 0, err
	}
	_, err = s.db.Exec(
		`UPDATE documents SET filename = ?, deleted_at = COALESCE(deleted_at, ?), updated_at = ?, dirty = 1
		 WHERE deleted_at IS NULL OR filename <> ?;`, deletedFilename, now, now, deletedFilename)
	if err != nil {
		return 0, fmt.Errorf("tombstone documents: %w", err)
	}
	return n, nil
}

// clearObjectTypes deletes every archetype. Its schema is left as it was: the server
// validates a type's schema on push, tombstones included.
func (s *Store) clearObjectTypes(now string) (int64, error) {
	n, err := s.countLive("object_types")
	if err != nil {
		return 0, err
	}
	return n, s.tombstone("object_types", ``, ``, now)
}

// clearAgents deletes every installed agent and wipes the API keys they carried.
func (s *Store) clearAgents(now string, rep *ClearReport) (int64, error) {
	n, err := s.countLive("llm_configs")
	if err != nil {
		return 0, err
	}
	rows, err := s.db.Query(`SELECT api_key_ref FROM llm_configs WHERE api_key_ref IS NOT NULL AND api_key_ref <> '';`)
	if err != nil {
		return 0, fmt.Errorf("read agent keys: %w", err)
	}
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			rows.Close()
			return 0, err
		}
		rep.SecretRefs = append(rep.SecretRefs, ref)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	err = s.tombstone("llm_configs", `api_key_enc = NULL, api_key_ref = NULL`,
		`api_key_enc IS NOT NULL OR api_key_ref IS NOT NULL`, now)
	return n, err
}

// clearExports deletes every folder and Git export through the repo's own delete, which wipes
// the credential and forgets the manifest. What they already wrote stays where it is.
func (s *Store) clearExports(rep *ClearReport) (int64, error) {
	dests, err := s.Exports.List()
	if err != nil {
		return 0, err
	}
	for _, d := range dests {
		rep.SecretRefs = append(rep.SecretRefs, "export/"+d.ID)
		if d.Kind == ExportKindGit {
			rep.GitExports = append(rep.GitExports, d.ID)
		}
		if err := s.Exports.Delete(d.ID); err != nil {
			return 0, err
		}
	}
	return int64(len(dests)), nil
}

// filesUsedBy returns the documents the kinds about to be cleared use: files embedded in
// notes or tasks (the Trash included, whose links are already gone, so the text is read),
// images on boards, and area and project covers. With DataFiles it is every document.
func (s *Store) filesUsedBy(want map[DataKind]bool) ([]string, error) {
	if want[DataFiles] {
		return s.queryIDs(`SELECT id FROM documents WHERE deleted_at IS NULL;`)
	}
	seen := map[string]bool{}
	var out []string
	add := func(ids ...string) {
		for _, id := range ids {
			if id != "" && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	embedded := func(q string) error {
		texts, err := s.queryIDs(q)
		if err != nil {
			return err
		}
		for _, md := range texts {
			for _, ref := range domain.ParseRefs(md) {
				if ref.TargetType == domain.NodeDocument {
					add(ref.TargetID)
				}
			}
		}
		return nil
	}
	if want[DataNotes] {
		if err := embedded(`SELECT content_md FROM notes WHERE deleted_at IS NULL;`); err != nil {
			return nil, err
		}
	}
	if want[DataTasks] {
		if err := embedded(`SELECT notes_md FROM tasks WHERE deleted_at IS NULL;`); err != nil {
			return nil, err
		}
	}
	if want[DataCanvases] {
		ids, err := s.queryIDs(`SELECT ref_id FROM canvas_nodes WHERE ref_type = 'document' AND ref_id IS NOT NULL AND deleted_at IS NULL;`)
		if err != nil {
			return nil, err
		}
		add(ids...)
	}
	if want[DataAreas] {
		ids, err := s.queryIDs(
			`SELECT cover_document_id FROM areas WHERE cover_document_id IS NOT NULL AND deleted_at IS NULL
			 UNION SELECT cover_document_id FROM projects WHERE cover_document_id IS NOT NULL AND deleted_at IS NULL;`)
		if err != nil {
			return nil, err
		}
		add(ids...)
	}
	return out, nil
}

// purgeUnusedFiles deletes the candidate documents nothing that survived the clear still
// uses, returning the ids it deleted.
func (s *Store) purgeUnusedFiles(candidates []string, now string) ([]string, error) {
	var purged []string
	for _, id := range candidates {
		used, err := s.fileInUse(id)
		if err != nil {
			return nil, err
		}
		if used {
			continue
		}
		res, err := s.db.Exec(
			`UPDATE documents SET filename = ?, deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
			deletedFilename, now, now, id)
		if err != nil {
			return nil, fmt.Errorf("tombstone document: %w", err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			purged = append(purged, id)
		}
	}
	return purged, nil
}

// fileInUse reports whether anything live still uses a document: the text of a note or task
// (trashed ones too, so restoring one never finds a hole), a board's image, or a cover.
func (s *Store) fileInUse(id string) (bool, error) {
	like := "%" + id + "%"
	rows, err := s.db.Query(
		`SELECT 1 FROM notes WHERE deleted_at IS NULL AND (content_md LIKE ? OR props_json LIKE ?)
		 UNION ALL SELECT 1 FROM tasks WHERE deleted_at IS NULL AND (notes_md LIKE ? OR props_json LIKE ?)
		 UNION ALL SELECT 1 FROM canvas_nodes n JOIN canvases c ON c.id = n.canvas_id
		   WHERE n.ref_type = 'document' AND n.ref_id = ? AND n.deleted_at IS NULL AND c.deleted_at IS NULL
		 UNION ALL SELECT 1 FROM areas WHERE cover_document_id = ? AND deleted_at IS NULL
		 UNION ALL SELECT 1 FROM projects WHERE cover_document_id = ? AND deleted_at IS NULL
		 LIMIT 1;`, like, like, like, like, id, id, id)
	if err != nil {
		return false, fmt.Errorf("query document use: %w", err)
	}
	defer rows.Close()
	used := rows.Next()
	return used, rows.Err()
}

// orphanedHashes returns the content hashes of the given (now deleted) documents that no
// live document shares, so their bytes can go. Content addressing lets two rows share one
// blob, which is why the hash, not the row, decides.
func (s *Store) orphanedHashes(docIDs []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, id := range docIDs {
		d, err := s.Documents.GetAny(id)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		if seen[d.SHA256] {
			continue
		}
		seen[d.SHA256] = true
		shared, err := s.Documents.HashReferencedElsewhere(d.SHA256, id)
		if err != nil {
			return nil, err
		}
		if !shared {
			out = append(out, d.SHA256)
		}
	}
	return out, nil
}

// queryIDs runs a one-column text query. NULLs come back as "".
func (s *Store) queryIDs(q string, args ...any) ([]string, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
