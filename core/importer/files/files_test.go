package files

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/export"
	"companion/core/store"
)

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func asFiles(rendered []export.File) []File {
	out := make([]File, len(rendered))
	for i, f := range rendered {
		out[i] = File{Path: f.Path, Content: f.Content}
	}
	return out
}

// stable strips what legitimately differs between two workspaces holding the same things: ids
// and timestamps.
func stable(content string) string {
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "id:") || strings.HasPrefix(trimmed, "created:") || strings.HasPrefix(trimmed, "updated:") || strings.HasPrefix(trimmed, "completed:") ||
			strings.HasPrefix(trimmed, `"id":`) || strings.HasPrefix(trimmed, `"refId":`) || strings.HasPrefix(trimmed, `"fromNode":`) || strings.HasPrefix(trimmed, `"toNode":`) {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// A workspace rendered to files and imported into an empty workspace renders to the same files.
func TestRoundTripIntoAnEmptyWorkspace(t *testing.T) {
	loc := time.FixedZone("ADT", -3*3600)
	a := newStore(t)
	area := must(a.Areas.Create(store.CreateAreaInput{Name: "Work"}))
	project := must(a.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Launch: v2"}))
	person := must(a.ObjectTypes.Create(store.CreateObjectTypeInput{Name: "Person", SchemaJSON: json.RawMessage(`{"fields":[{"key":"email","type":"text"},{"key":"tags","type":"multi_select","options":["friend","work"]},{"key":"vip","type":"checkbox"},{"key":"age","type":"number"},{"key":"knows","type":"reference","to":"note"}]}`)}))

	target := must(a.Notes.Create(store.CreateNoteInput{Title: "Target", ContentMD: "I am linked to."}))
	twin := must(a.Notes.Create(store.CreateNoteInput{Title: "Target", ContentMD: "Same title, another note."}))
	date := "2026-09-21"
	props := json.RawMessage(`{"email":"ada@example.com","tags":["friend","work"],"vip":true,"age":36,"knows":"` + target.ID + `"}`)
	brief := must(a.Notes.Create(store.CreateNoteInput{Title: "Brief", Date: &date, ObjectTypeID: &person.ID, Props: props,
		ContentMD: "See [[note:" + target.ID + "]], its twin [[note:" + twin.ID + "|the other one]], and [[nothing here]].\n\n- [ ] a todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"}))
	must(a.ProjectMembers.Add(project.ID, "note", brief.ID))
	must(a.ProjectMembers.AddToArea(area.ID, "note", twin.ID))

	start := time.Date(2026, 9, 28, 9, 30, 0, 0, loc)
	due := time.Date(2026, 10, 1, 0, 0, 0, 0, loc)
	at := time.Date(2026, 9, 30, 8, 0, 0, 0, loc)
	rule := "FREQ=WEEKLY;BYDAY=MO,FR"
	task := must(a.Tasks.Create(store.CreateTaskInput{Title: "Ship it", NotesMD: "Depends on [[note:" + brief.ID + "]].", StartAt: &start, DueAt: &due,
		Reminders: []domain.Reminder{{Before: "P1D"}, {At: &at}}}))
	must(a.ProjectMembers.Add(project.ID, "task", task.ID))
	must(a.Tasks.Create(store.CreateTaskInput{Title: "Water plants", RepeatRule: &rule}))
	must(a.Tasks.Create(store.CreateTaskInput{Title: "Learn Go", Someday: true, Status: "done"}))

	board := must(a.Canvases.Create(store.CreateCanvasInput{Name: "Plan"}))
	purple := "#8b5cf6"
	noteType := "note"
	nodes := must(a.CanvasNodes.UpsertMany(board.ID, []store.CanvasNodeInput{
		{Kind: "group", X: -40, Y: -60, Width: 600, Height: 300, Data: json.RawMessage(`{"label":"Phase 1"}`)},
		{Kind: "text", X: 0, Y: 0, Width: 200, Height: 90, Z: 1, Color: &purple, Data: json.RawMessage(`{"text":"sticky"}`)},
		{Kind: "note", X: 300, Y: 0, Width: 220, Height: 90, Z: 2, RefType: &noteType, RefID: &brief.ID},
		{Kind: "link", X: 300, Y: 200, Width: 220, Height: 90, Z: 3, Data: json.RawMessage(`{"url":"https://example.com","title":"Example","description":"A site"}`)},
	}))
	left := "right"
	must(a.CanvasEdges.UpsertMany(board.ID, []store.CanvasEdgeInput{
		{FromNodeID: nodes[1].ID, ToNodeID: nodes[2].ID, FromSide: &left, FromEnd: "dotFilled", ToEnd: "arrowFilled", Style: "step", Label: "informs", Color: &purple},
	}))

	rendered := must(export.Render(a, loc, nil))
	b := newStore(t)
	outcomes := Apply(b, asFiles(rendered), Options{Loc: loc})
	for _, o := range outcomes {
		if o.Action != Created {
			t.Errorf("%s: %s (%s)", o.Path, o.Action, o.Reason)
		}
	}
	if s := Summarize(outcomes); s.Notes != 3 || s.Tasks != 3 || s.Canvases != 1 || s.Created != 7 {
		t.Errorf("summary = %+v", s)
	}

	again := must(export.Render(b, loc, nil))
	if len(again) != len(rendered) {
		t.Fatalf("rendered %d files, came back as %d", len(rendered), len(again))
	}
	for i := range rendered {
		if rendered[i].Path != again[i].Path {
			t.Errorf("path %q came back as %q", rendered[i].Path, again[i].Path)
		}
		// The object type doesn't exist in the new workspace, so its properties can't either.
		want := stable(string(rendered[i].Content))
		if strings.Contains(want, "type: Person") {
			for _, drop := range []string{"type: Person\n", "email: \"ada@example.com\"\n", "tags:\n  - friend\n  - work\n", "vip: true\n", "age: 36\n", "knows: Target\n"} {
				want = strings.Replace(want, drop, "", 1)
			}
			// …and "Target" is ambiguous there, which is fine: the link is path-qualified.
		}
		if got := stable(string(again[i].Content)); got != want {
			t.Errorf("%s came back different:\n--- wrote\n%s\n--- read back\n%s", rendered[i].Path, want, got)
		}
	}

	// Links resolved to the new workspace's own ids — including the ambiguous title, by path.
	var briefB *domain.Note
	for _, n := range must(b.Notes.List()) {
		if n.Title == "Brief" {
			briefB = n
		}
	}
	if briefB == nil || strings.Contains(briefB.ContentMD, "[[Target") || strings.Contains(briefB.ContentMD, target.ID) || !strings.Contains(briefB.ContentMD, "[[note:") || !strings.Contains(briefB.ContentMD, "[[nothing here]]") {
		t.Errorf("links in the imported note: %q", briefB.ContentMD)
	}
	if members := must(b.ProjectMembers.ListForEntity("note", briefB.ID)); len(members) != 1 {
		t.Errorf("the note should be filed in its project: %+v", members)
	}
}

// Importing over the same workspace updates in place — and only what the file says.
func TestApplyIsAPatch(t *testing.T) {
	loc := time.UTC
	st := newStore(t)
	due := time.Date(2026, 10, 1, 0, 0, 0, 0, loc)
	task := must(st.Tasks.Create(store.CreateTaskInput{Title: "Ship it", NotesMD: "Old notes.", DueAt: &due, Reminders: []domain.Reminder{{Before: "P1D"}}}))

	file := func(frontMatter, body string) File {
		return File{Path: "Tasks/Ship it.md", Content: []byte("---\n" + frontMatter + "---\n\n" + body + "\n")}
	}
	skipped := Apply(st, []File{file("id: "+task.ID+"\nkind: task\ntitle: Renamed\n", "New notes.")}, Options{Loc: loc})
	if skipped[0].Action != Skipped {
		t.Fatalf("without UpdateExisting an existing item is left alone: %+v", skipped[0])
	}

	base := file("id: "+task.ID+"\nkind: task\ntitle: Ship it\ndeadline: 2026-10-01\nreminders:\n  - P1D\n", "Old notes.")
	// Title, status and body change; the deadline line is simply not mentioned.
	out := Apply(st, []File{file("id: "+task.ID+"\nkind: task\ntitle: Renamed\nstatus: done\n", "New notes.")}, Options{Loc: loc, UpdateExisting: true})
	got := must(st.Tasks.Get(task.ID))
	if out[0].Action != Updated || got.Title != "Renamed" || got.Status != "done" || got.NotesMD != "New notes." {
		t.Fatalf("outcome %+v, task %+v", out[0], got)
	}
	if got.DueAt == nil || len(got.Reminders) != 1 {
		t.Errorf("what the file doesn't mention must survive: due %v, reminders %v", got.DueAt, got.Reminders)
	}
	// With a base to compare against, removing the line is what clears it.
	edited := file("id: "+task.ID+"\nkind: task\ntitle: Renamed\n", "New notes.")
	edited.Base = base.Content
	Apply(st, []File{edited}, Options{Loc: loc, UpdateExisting: true})
	got = must(st.Tasks.Get(task.ID))
	if got.DueAt != nil || len(got.Reminders) != 0 {
		t.Errorf("a removed key clears the field: due %v, reminders %v", got.DueAt, got.Reminders)
	}
	// An empty value clears it too, base or no base.
	start := time.Date(2026, 9, 1, 0, 0, 0, 0, loc)
	must(st.Tasks.Update(task.ID, store.UpdateTaskInput{StartAt: &start}))
	Apply(st, []File{file("id: "+task.ID+"\nkind: task\ntitle: Renamed\nstart:\n", "New notes.")}, Options{Loc: loc, UpdateExisting: true})
	if got = must(st.Tasks.Get(task.ID)); got.StartAt != nil {
		t.Errorf("an empty key clears the field: start %v", got.StartAt)
	}
}

// A file's id is only honoured for an item that exists here and is of that kind.
func TestIdentityIsNotTakenOnTrust(t *testing.T) {
	st := newStore(t)
	note := must(st.Notes.Create(store.CreateNoteInput{Title: "Mine", ContentMD: "Keep me."}))
	out := Apply(st, []File{
		{Path: "a.md", Content: []byte("---\nid: 00000000-0000-7000-8000-000000000000\ntitle: From elsewhere\n---\nHello.")},
		{Path: "b.md", Content: []byte("---\nid: " + note.ID + "\nkind: task\ntitle: Wrong kind\n---\nI claim to be a task with a note's id.")},
		{Path: "plain.md", Content: []byte("# Just markdown\n\nNo front matter at all.")},
		{Path: "broken.md", Content: []byte("---\ntitle: [unclosed\n---\nBody")},
		{Path: "data.json", Content: []byte(`{"some":"other json"}`)},
	}, Options{UpdateExisting: true})
	actions := map[string]string{}
	for _, o := range out {
		actions[o.Path] = o.Action
		if o.Path == "a.md" && o.ID == "00000000-0000-7000-8000-000000000000" {
			t.Error("an unknown id must not be adopted")
		}
	}
	if actions["a.md"] != Created || actions["b.md"] != Created || actions["plain.md"] != Created || actions["broken.md"] != Failed || actions["data.json"] != Skipped {
		t.Errorf("actions = %v", actions)
	}
	if got := must(st.Notes.Get(note.ID)); got.Title != "Mine" || got.ContentMD != "Keep me." {
		t.Errorf("a file naming a note's id as a task must not touch the note: %+v", got)
	}
	plain := must(st.Notes.List())
	found := false
	for _, n := range plain {
		found = found || (n.Title == "plain" && strings.Contains(n.ContentMD, "No front matter"))
	}
	if !found {
		t.Error("a bare markdown file should import as a note titled after its filename")
	}
}

func TestImportableAndTrash(t *testing.T) {
	for path, want := range map[string]bool{"Notes/A.md": true, "a/b/c.markdown": true, "Board.canvas": true, "x.json": true,
		".git/config.md": false, "vault/.obsidian/workspace.json": false, "image.png": false, ".trash/Old.md": false} {
		if got := Importable(path); got != want {
			t.Errorf("Importable(%q) = %v", path, got)
		}
	}
	st := newStore(t)
	note := must(st.Notes.Create(store.CreateNoteInput{Title: "Going"}))
	if err := Trash(st, Ref{Type: "note", ID: note.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Notes.Get(note.ID); err == nil {
		t.Error("a trashed note isn't live")
	}
	if trash := must(st.Notes.ListTrash()); len(trash) != 1 {
		t.Errorf("it should be in the Trash, recoverable: %d", len(trash))
	}
	if err := Trash(st, Ref{Type: "note", ID: note.ID}); err != nil {
		t.Errorf("trashing twice is fine: %v", err)
	}
}
