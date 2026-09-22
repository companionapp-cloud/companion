//go:build !js

package store

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
)

// sha returns a valid 64-char lowercase hex content address built from one repeated digit.
func fakeSHA(d string) string { return strings.Repeat(d, 64) }

// row reads one row of a single-table query as strings, "NULL" for a NULL. The clear tests
// check columns the domain structs don't all expose (dirty, blanked text, local tables).
func clearRow(t *testing.T, s *Store, q string, args ...any) []string {
	t.Helper()
	rows, err := s.db.Query(q, args...)
	if err != nil {
		t.Fatalf("query %q: %v", q, err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatalf("query %q: no row", q)
	}
	cols := strings.Count(strings.SplitN(strings.SplitN(q, " FROM ", 2)[0], "SELECT ", 2)[1], ",") + 1
	vals := make([]any, cols)
	out := make([]sql.NullString, cols)
	for i := range vals {
		vals[i] = &out[i]
	}
	if err := rows.Scan(vals...); err != nil {
		t.Fatalf("scan %q: %v", q, err)
	}
	strs := make([]string, cols)
	for i, v := range out {
		strs[i] = v.String
		if !v.Valid {
			strs[i] = "NULL"
		}
	}
	return strs
}

func clearCount(t *testing.T, s *Store, q string, args ...any) int {
	t.Helper()
	rows, err := s.db.Query(q, args...)
	if err != nil {
		t.Fatalf("count %q: %v", q, err)
	}
	defer rows.Close()
	var n int
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan count: %v", err)
		}
	}
	return n
}

func mustClear(t *testing.T, s *Store, kinds ...DataKind) *ClearReport {
	t.Helper()
	rep, err := s.ClearData(kinds)
	if err != nil {
		t.Fatalf("clear %v: %v", kinds, err)
	}
	return rep
}

func TestClearNotesTombstonesAndBlanksEveryNote(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	onlyHere, _ := s.Documents.Create(CreateDocumentInput{Filename: "scan.pdf", SHA256: fakeSHA("a")})
	shared, _ := s.Documents.Create(CreateDocumentInput{Filename: "diagram.png", SHA256: fakeSHA("b")})
	date := "2026-09-22"
	live, _ := s.Notes.Create(CreateNoteInput{Title: "Diary", ContentMD: "secret ![[doc:" + onlyHere.ID + "]] ![[doc:" + shared.ID + "]]", Date: &date})
	trashed, _ := s.Notes.Create(CreateNoteInput{Title: "Old", ContentMD: "gone soon"})
	if err := s.Notes.Trash(trashed.ID); err != nil {
		t.Fatal(err)
	}
	// An older "delete forever" tombstone still carries its text until a clear blanks it.
	old, _ := s.Notes.Create(CreateNoteInput{Title: "Tombstone", ContentMD: "left behind"})
	if err := s.Notes.Delete(old.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Notes.MarkPushed(old.ID, 3); err != nil {
		t.Fatal(err)
	}
	inkID := "0190f5a4-0000-7000-8000-000000000001"
	if _, err := s.NoteInk.UpsertMany(live.ID, []NoteInkInput{{ID: inkID, Data: json.RawMessage(`{"strokes":[1,2,3]}`)}}); err != nil {
		t.Fatal(err)
	}
	task, _ := s.Tasks.Create(CreateTaskInput{Title: "Keep me", NotesMD: "uses ![[doc:" + shared.ID + "]]"})
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Home"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Garden"})
	if _, err := s.ProjectMembers.Add(proj.ID, domain.NodeNote, live.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMembers.Add(proj.ID, domain.NodeTask, task.ID); err != nil {
		t.Fatal(err)
	}

	rep := mustClear(t, s, DataNotes)

	if rep.Cleared[DataNotes] != 2 {
		t.Errorf("cleared notes = %d, want 2 (the live and the trashed one)", rep.Cleared[DataNotes])
	}
	for _, id := range []string{live.ID, trashed.ID, old.ID} {
		got := clearRow(t, s, `SELECT title, content_md, date, props_json, dirty, deleted_at FROM notes WHERE id = ?;`, id)
		if got[0] != "" || got[1] != "" || got[2] != "NULL" || got[3] != "{}" || got[4] != "1" || got[5] == "NULL" {
			t.Errorf("note %s after clear = %v, want blank, dirty tombstone", id, got)
		}
	}
	// The older tombstone keeps the instant it was deleted.
	if got := clearRow(t, s, `SELECT deleted_at FROM notes WHERE id = ?;`, old.ID)[0]; got != clk.t.Format(timeFormat) {
		t.Errorf("old tombstone deleted_at = %s", got)
	}
	if got := clearRow(t, s, `SELECT data_json, dirty, deleted_at IS NOT NULL FROM note_ink WHERE id = ?;`, inkID); got[0] != "{}" || got[1] != "1" || got[2] != "1" {
		t.Errorf("ink after clear = %v", got)
	}
	// The note leaves its project; the task stays filed.
	if n := clearCount(t, s, `SELECT count(*) FROM project_members WHERE deleted_at IS NULL AND entity_type = 'note';`); n != 0 {
		t.Errorf("live note memberships = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM project_members WHERE deleted_at IS NULL AND entity_type = 'task';`); n != 1 {
		t.Errorf("live task memberships = %d, want 1", n)
	}
	// The file only the note used goes (bytes included); the one the task also uses stays.
	if got := clearRow(t, s, `SELECT filename, deleted_at IS NOT NULL FROM documents WHERE id = ?;`, onlyHere.ID); got[0] != deletedFilename || got[1] != "1" {
		t.Errorf("note-only document = %v, want deleted", got)
	}
	if got := clearRow(t, s, `SELECT filename, deleted_at FROM documents WHERE id = ?;`, shared.ID); got[0] != "diagram.png" || got[1] != "NULL" {
		t.Errorf("shared document = %v, want untouched", got)
	}
	if len(rep.OrphanBlobs) != 1 || rep.OrphanBlobs[0] != fakeSHA("a") {
		t.Errorf("orphan blobs = %v, want [%s]", rep.OrphanBlobs, fakeSHA("a"))
	}
	// The task and its edge to the shared file survive the link rebuild; nothing is left
	// from a note.
	if _, err := s.Tasks.Get(task.ID); err != nil {
		t.Errorf("task: %v", err)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM links WHERE source_type = 'note';`); n != 0 {
		t.Errorf("links from notes = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM links WHERE source_type = 'task' AND target_id = ?;`, shared.ID); n != 1 {
		t.Errorf("task's link to the shared file = %d, want 1", n)
	}
}

func TestClearTasksLeavesHeadingsAndTakesReads(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"})
	list, _ := s.Lists.Create(CreateListInput{ProjectID: proj.ID, Name: "Todo"})
	task, _ := s.Tasks.Create(CreateTaskInput{Title: "Ship it", NotesMD: "notes", Reminders: []domain.Reminder{}})
	seed, _ := s.Tasks.Create(CreateTaskInput{Title: "Standup", RepeatRule: strPtr("FREQ=DAILY")})
	if _, err := s.ListItems.AddTask(list.ID, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ListItems.AddHeading(list.ID, "Later"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMembers.Add(proj.ID, domain.NodeTask, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.NotificationReads.MarkRead(task.ID, clk.t); err != nil {
		t.Fatal(err)
	}
	note, _ := s.Notes.Create(CreateNoteInput{Title: "Stays", ContentMD: "[[task:" + task.ID + "]]"})

	rep := mustClear(t, s, DataTasks)

	if rep.Cleared[DataTasks] != 2 {
		t.Errorf("cleared tasks = %d, want 2", rep.Cleared[DataTasks])
	}
	for _, id := range []string{task.ID, seed.ID} {
		got := clearRow(t, s, `SELECT title, notes_md, dirty, deleted_at IS NOT NULL FROM tasks WHERE id = ?;`, id)
		if got[0] != "" || got[1] != "" || got[2] != "1" || got[3] != "1" {
			t.Errorf("task %s after clear = %v", id, got)
		}
	}
	// The repeat rule stays valid for the server; the seed is dead anyway.
	if got := clearRow(t, s, `SELECT repeat_rule FROM tasks WHERE id = ?;`, seed.ID)[0]; got != "FREQ=DAILY" {
		t.Errorf("seed repeat_rule = %q", got)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM list_items WHERE deleted_at IS NULL AND kind = 'task';`); n != 0 {
		t.Errorf("live task list items = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM list_items WHERE deleted_at IS NULL AND kind = 'heading';`); n != 1 {
		t.Errorf("live headings = %d, want 1", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM notification_reads WHERE deleted_at IS NULL;`); n != 0 {
		t.Errorf("live reads = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM project_members WHERE deleted_at IS NULL;`); n != 0 {
		t.Errorf("live memberships = %d", n)
	}
	// The note is untouched and keeps its (now dangling) link, like any other delete.
	if got, err := s.Notes.Get(note.ID); err != nil || got.Title != "Stays" {
		t.Errorf("note = %+v, %v", got, err)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM links WHERE source_id = ? AND target_id = ?;`, note.ID, task.ID); n != 1 {
		t.Errorf("note's link to the task = %d, want 1", n)
	}
}

func TestClearCanvasesTakesBoardsAndTheirImages(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	img, _ := s.Documents.Create(CreateDocumentInput{Filename: "photo.jpg", SHA256: fakeSHA("c")})
	board, _ := s.Canvases.Create(CreateCanvasInput{Name: "Plans"})
	refType := "document"
	nodes, err := s.CanvasNodes.UpsertMany(board.ID, []CanvasNodeInput{
		{Kind: domain.CanvasNodeText, Width: 200, Height: 100, Data: json.RawMessage(`{"text":"private"}`)},
		{Kind: domain.CanvasNodeImage, Width: 200, Height: 100, RefType: &refType, RefID: &img.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CanvasEdges.UpsertMany(board.ID, []CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[1].ID, FromEnd: "none", ToEnd: "arrow", Style: "curved", Label: "because"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Canvases.SetView(board.ID, CanvasView{X: 1, Y: 2, Zoom: 1}); err != nil {
		t.Fatal(err)
	}

	rep := mustClear(t, s, DataCanvases)

	if rep.Cleared[DataCanvases] != 1 {
		t.Errorf("cleared canvases = %d", rep.Cleared[DataCanvases])
	}
	if got := clearRow(t, s, `SELECT name, deleted_at IS NOT NULL, dirty FROM canvases WHERE id = ?;`, board.ID); got[0] != "" || got[1] != "1" || got[2] != "1" {
		t.Errorf("board = %v", got)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM canvas_nodes WHERE deleted_at IS NULL OR data_json <> '{}';`); n != 0 {
		t.Errorf("nodes left with content = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM canvas_edges WHERE deleted_at IS NULL OR label <> '';`); n != 0 {
		t.Errorf("edges left with content = %d", n)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM canvas_views;`); n != 0 {
		t.Errorf("viewports = %d", n)
	}
	if got := clearRow(t, s, `SELECT deleted_at IS NOT NULL FROM documents WHERE id = ?;`, img.ID)[0]; got != "1" {
		t.Error("the board's image should go with it")
	}
	if n := clearCount(t, s, `SELECT count(*) FROM links WHERE source_type = 'canvas';`); n != 0 {
		t.Errorf("canvas links = %d", n)
	}
}

func TestClearChatsBlanksMessages(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	chat, _ := s.Chats.Create("Taxes", nil)
	if _, err := s.ChatMessages.Append(chat.ID, "user", "my income is...", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChatMessages.Append(chat.ID, "assistant", "", json.RawMessage(`[{"id":"1"}]`), nil); err != nil {
		t.Fatal(err)
	}
	rep := mustClear(t, s, DataChats)
	if rep.Cleared[DataChats] != 1 {
		t.Errorf("cleared chats = %d", rep.Cleared[DataChats])
	}
	if got := clearRow(t, s, `SELECT title, deleted_at IS NOT NULL, dirty FROM chats WHERE id = ?;`, chat.ID); got[0] != "" || got[1] != "1" || got[2] != "1" {
		t.Errorf("chat = %v", got)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM chat_messages WHERE deleted_at IS NULL OR text <> '' OR tool_calls IS NOT NULL;`); n != 0 {
		t.Errorf("messages left with content = %d", n)
	}
}

func TestClearCalendarNeverQueuesProviderWrites(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	ref := "caldav/secret-1"
	acct, err := s.CalendarAccounts.Create(CreateAccountInput{Name: "iCloud", ServerURL: "https://caldav.icloud.com", Username: "me", CredentialRef: &ref})
	if err != nil {
		t.Fatal(err)
	}
	cal, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Home", URL: "https://caldav.icloud.com/123/calendars/home/", Kind: domain.FeedKindCalDAV, AccountID: &acct.ID})
	if err != nil {
		t.Fatal(err)
	}
	ics, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Holidays", URL: "https://example.com/private-token.ics"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	if err := s.CalendarObjects.Put(&domain.CalendarObject{ID: "obj-1", FeedID: cal.ID, UID: "u1", ICS: "BEGIN:VCALENDAR", PushState: domain.PushPendingUpdate, CreatedAt: now, UpdatedAt: now, Dirty: true}); err != nil {
		t.Fatal(err)
	}
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Home"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Family"})
	if _, err := s.ProjectMembers.Add(proj.ID, domain.MemberCalendar, ics.ID); err != nil {
		t.Fatal(err)
	}

	rep := mustClear(t, s, DataCalendar)

	if rep.Cleared[DataCalendar] != 2 {
		t.Errorf("cleared calendars = %d, want 2", rep.Cleared[DataCalendar])
	}
	if len(rep.SecretRefs) != 1 || rep.SecretRefs[0] != ref {
		t.Errorf("secret refs = %v", rep.SecretRefs)
	}
	if got := clearRow(t, s, `SELECT name, server_url, username, credential_ref, deleted_at IS NOT NULL, dirty FROM calendar_accounts WHERE id = ?;`, acct.ID); got[0] != "" || got[1] != "" || got[2] != "" || got[3] != "NULL" || got[4] != "1" || got[5] != "1" {
		t.Errorf("account = %v", got)
	}
	if got := clearRow(t, s, `SELECT url, name, deleted_at IS NOT NULL FROM calendar_feeds WHERE id = ?;`, ics.ID); got[0] != "" || got[1] != "" || got[2] != "1" {
		t.Errorf("subscription = %v", got)
	}
	// A pending edit must not turn into a DELETE (or anything else) on the provider.
	if got := clearRow(t, s, `SELECT ics, push_state, deleted_at IS NOT NULL FROM calendar_objects WHERE id = 'obj-1';`); got[0] != "" || got[1] != "synced" || got[2] != "1" {
		t.Errorf("calendar object = %v", got)
	}
	if n := clearCount(t, s, `SELECT count(*) FROM project_members WHERE deleted_at IS NULL;`); n != 0 {
		t.Errorf("calendar memberships left = %d", n)
	}
}

func TestClearAreasUnfilesContent(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	cover, _ := s.Documents.Create(CreateDocumentInput{Filename: "cover.png", SHA256: fakeSHA("d")})
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Health", DescriptionMd: "private goals", CoverDocumentID: &cover.ID})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Marathon"})
	list, _ := s.Lists.Create(CreateListInput{ProjectID: proj.ID, Name: "Training"})
	if _, err := s.ListItems.AddHeading(list.ID, "Week 1"); err != nil {
		t.Fatal(err)
	}
	note, _ := s.Notes.Create(CreateNoteInput{Title: "Plan", ContentMD: "run"})
	if _, err := s.ProjectMembers.Add(proj.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatal(err)
	}

	rep := mustClear(t, s, DataAreas)

	if rep.Cleared[DataAreas] != 2 {
		t.Errorf("cleared = %d, want 2 (an area and a project)", rep.Cleared[DataAreas])
	}
	for _, q := range []string{
		`SELECT count(*) FROM areas WHERE deleted_at IS NULL OR name <> '' OR description_md <> '';`,
		`SELECT count(*) FROM projects WHERE deleted_at IS NULL OR name <> '';`,
		`SELECT count(*) FROM lists WHERE deleted_at IS NULL OR name <> '';`,
		`SELECT count(*) FROM list_items WHERE deleted_at IS NULL OR title <> '';`,
		`SELECT count(*) FROM project_members WHERE deleted_at IS NULL;`,
		`SELECT count(*) FROM links WHERE kind = 'member';`,
	} {
		if n := clearCount(t, s, q); n != 0 {
			t.Errorf("%s = %d, want 0", q, n)
		}
	}
	if got, err := s.Notes.Get(note.ID); err != nil || got.ContentMD != "run" {
		t.Errorf("filed note = %+v, %v; want untouched", got, err)
	}
	if got := clearRow(t, s, `SELECT deleted_at IS NOT NULL FROM documents WHERE id = ?;`, cover.ID)[0]; got != "1" {
		t.Error("the area's cover should go with it")
	}
}

func TestClearAllEmptiesTheSummary(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	if _, err := s.Documents.Create(CreateDocumentInput{Filename: "loose.txt", SHA256: fakeSHA("e")}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "t"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Canvases.Create(CreateCanvasInput{Name: "c"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Chats.Create("chat", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "f", URL: "https://example.com/a.ics"}); err != nil {
		t.Fatal(err)
	}
	area, _ := s.Areas.Create(CreateAreaInput{Name: "a"})
	if _, err := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "p"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ObjectTypes.Create(CreateObjectTypeInput{Name: "Book", SchemaJSON: json.RawMessage(`{"fields":[]}`)}); err != nil {
		t.Fatal(err)
	}
	keyRef := "agent/key-1"
	if _, err := s.Agents.Create(CreateAgentInput{Name: "Claude", Runtime: domain.RuntimeAnthropicAPI, APIKeyRef: &keyRef}); err != nil {
		t.Fatal(err)
	}
	dest := &ExportDestination{Kind: ExportKindGit, Name: "backup", Config: json.RawMessage(`{}`), Schedule: "manual", Enabled: true}
	if err := s.Exports.Save(dest); err != nil {
		t.Fatal(err)
	}

	before, err := s.DataSummary()
	if err != nil {
		t.Fatal(err)
	}
	if before.Notes != 1 || before.Tasks != 1 || before.Canvases != 1 || before.Chats != 1 || before.Calendars != 1 ||
		before.Areas != 1 || before.Projects != 1 || before.Files != 1 || before.ObjectTypes != 1 || before.Agents != 1 || before.Exports != 1 {
		t.Fatalf("summary before = %+v", before)
	}

	rep := mustClear(t, s, AllDataKinds...)

	after, err := s.DataSummary()
	if err != nil {
		t.Fatal(err)
	}
	if *after != (DataSummary{}) {
		t.Errorf("summary after clearing everything = %+v, want all zero", after)
	}
	if len(rep.OrphanBlobs) != 1 || rep.OrphanBlobs[0] != fakeSHA("e") {
		t.Errorf("orphan blobs = %v", rep.OrphanBlobs)
	}
	wantRefs := map[string]bool{keyRef: true, "export/" + dest.ID: true}
	if len(rep.SecretRefs) != len(wantRefs) {
		t.Errorf("secret refs = %v", rep.SecretRefs)
	}
	for _, r := range rep.SecretRefs {
		if !wantRefs[r] {
			t.Errorf("unexpected secret ref %q", r)
		}
	}
	if len(rep.GitExports) != 1 || rep.GitExports[0] != dest.ID {
		t.Errorf("git exports = %v", rep.GitExports)
	}
	if got := clearRow(t, s, `SELECT api_key_ref, dirty FROM llm_configs;`); got[0] != "NULL" || got[1] != "1" {
		t.Errorf("agent after clear = %v", got)
	}
	// Every change rides the next push.
	for _, table := range []string{"notes", "tasks", "canvases", "chats", "calendar_feeds", "areas", "projects", "documents", "object_types", "llm_configs", "export_destinations"} {
		if n := clearCount(t, s, `SELECT count(*) FROM `+table+` WHERE dirty = 0;`); n != 0 {
			t.Errorf("%s has %d clean rows after a clear", table, n)
		}
	}
}

func TestClearRejectsUnknownKinds(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	note, _ := s.Notes.Create(CreateNoteInput{Title: "safe"})
	if _, err := s.ClearData([]DataKind{DataNotes, "everything"}); err == nil {
		t.Fatal("expected an error for an unknown kind")
	}
	if _, err := s.Notes.Get(note.ID); err != nil {
		t.Errorf("a rejected clear must not touch anything: %v", err)
	}
}

