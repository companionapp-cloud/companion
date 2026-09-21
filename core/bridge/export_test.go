//go:build !js && !ios && !android

package bridge

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"companion/core/blob"
	"companion/core/crypto"
	"companion/core/store"
	"companion/core/sync/protocol"
)

func call[T any](t *testing.T, c *Core, method, payload string) T {
	t.Helper()
	out, err := c.Invoke(method, []byte(payload))
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	var v T
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("%s: decode %s: %v", method, out, err)
	}
	return v
}

type idOnly struct {
	ID string `json:"id"`
}

// tree lists every file under root, slash-separated and sorted.
func tree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestFolderExport(t *testing.T) {
	c, h := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	c.SetExportDir(t.TempDir())
	root := t.TempDir()
	// Something of the user's own in the folder: an export must never touch it.
	if err := os.WriteFile(filepath.Join(root, "mine.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	target := call[idOnly](t, c, "notes.create", `{"title":"Target","contentMd":"I am linked to."}`)
	note := call[idOnly](t, c, "notes.create", `{"title":"Plan: Q4 / \"draft\"","contentMd":"See [[note:`+target.ID+`]] and [[note:`+target.ID+`|that one]].\n\nGone: [[note:nope]]"}`)
	call[idOnly](t, c, "notes.create", `{"title":"Target","contentMd":"Same title, second note."}`)
	task := call[idOnly](t, c, "tasks.create", `{"title":"Yes","notesMd":"Do it.","repeatRule":"FREQ=WEEKLY","reminders":[{"before":"P1D"}]}`)
	area := call[idOnly](t, c, "areas.create", `{"name":"Work"}`)
	project := call[idOnly](t, c, "projects.create", `{"areaId":"`+area.ID+`","name":"Launch"}`)
	canvas := call[idOnly](t, c, "canvases.create", `{"name":"Board"}`)
	if _, err := c.Invoke("canvases.nodes.upsert", []byte(`{"canvasId":"`+canvas.ID+`","nodes":[{"kind":"note","x":0,"y":0,"width":200,"height":80,"refType":"note","refId":"`+note.ID+`"},{"kind":"text","x":300,"y":0,"width":100,"height":50,"data":{"text":"sticky"}}]}`)); err != nil {
		t.Fatal(err)
	}

	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"folder","path":`+quote(root)+`,"schedule":"manual"}`)
	if dest.Name != filepath.Base(root) || dest.Schedule != "manual" {
		t.Fatalf("saved destination = %+v", dest.ExportDestination)
	}
	c.runExport(dest.ID, false)

	want := []string{"Canvases/Board.json", "Notes/Plan Q4 draft.md", "Notes/Target 2.md", "Notes/Target.md", "Tasks/Yes.md", "mine.txt"}
	if got := tree(t, root); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("tree = %v\nwant   %v", got, want)
	}
	plan, _ := os.ReadFile(filepath.Join(root, "Notes/Plan Q4 draft.md"))
	for _, s := range []string{"---\ntitle: \"Plan: Q4 / \\\"draft\\\"\"\n", "\ncreated: 20", "See [[Notes/Target|Target]] and [[Notes/Target|that one]].", "Gone: [[note:nope]]"} {
		if !strings.Contains(string(plan), s) {
			t.Errorf("note is missing %q:\n%s", s, plan)
		}
	}
	yes, _ := os.ReadFile(filepath.Join(root, "Tasks/Yes.md"))
	for _, s := range []string{"title: \"Yes\"\n", "status: open\n", "repeat: \"FREQ=WEEKLY\"\n", "reminders:\n  - P1D\n", "kind: task\n", "id: \"" + task.ID + "\"\n", "---\n\nDo it.\n"} {
		if !strings.Contains(string(yes), s) {
			t.Errorf("task is missing %q:\n%s", s, yes)
		}
	}
	board, _ := os.ReadFile(filepath.Join(root, "Canvases/Board.json"))
	if !strings.Contains(string(board), `"file": "Notes/Plan Q4 draft.md"`) || !strings.Contains(string(board), `"text": "sticky"`) {
		t.Errorf("canvas = %s", board)
	}

	// A second run with nothing changed writes nothing (the file keeps its mtime).
	before, _ := os.Stat(filepath.Join(root, "Tasks/Yes.md"))
	c.runExport(dest.ID, false)
	after, _ := os.Stat(filepath.Join(root, "Tasks/Yes.md"))
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("an unchanged file was rewritten")
	}

	// Rename a note, file the task in a project, trash another note: the old paths go, the
	// emptied Tasks folder is pruned, and the canvas follows the renamed note.
	call[idOnly](t, c, "notes.update", `{"id":"`+note.ID+`","title":"Plan"}`)
	if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+project.ID+`","entityType":"task","entityId":"`+task.ID+`"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Invoke("notes.delete", []byte(`{"id":"`+target.ID+`"}`)); err != nil {
		t.Fatal(err)
	}
	c.runExport(dest.ID, false)
	want = []string{"Areas/Work/Launch/Tasks/Yes.md", "Canvases/Board.json", "Notes/Plan.md", "Notes/Target.md", "mine.txt"}
	if got := tree(t, root); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("after changes, tree = %v\nwant %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(root, "Tasks")); !os.IsNotExist(err) {
		t.Error("the emptied Tasks folder should be pruned")
	}
	yes, _ = os.ReadFile(filepath.Join(root, "Areas/Work/Launch/Tasks/Yes.md"))
	if !strings.Contains(string(yes), "filed_in: Launch\n") {
		t.Errorf("task should say where it's filed:\n%s", yes)
	}
	board, _ = os.ReadFile(filepath.Join(root, "Canvases/Board.json"))
	if !strings.Contains(string(board), `"file": "Notes/Plan.md"`) {
		t.Errorf("canvas should follow the rename: %s", board)
	}

	got := call[[]exportView](t, c, "export.destinations.list", "")
	if len(got) != 1 || got[0].LastError != "" || got[0].LastSuccessAt == nil || !strings.Contains(string(got[0].LastSummary), `"removed":3`) {
		t.Errorf("status = %+v summary=%s", got[0].ExportDestination, got[0].LastSummary)
	}
	if h.count(exportChangedEvent) == 0 {
		t.Error("expected export.changed events")
	}

	// A missing folder is an error to show, not a folder to recreate.
	os.RemoveAll(root)
	c.runExport(dest.ID, false)
	got = call[[]exportView](t, c, "export.destinations.list", "")
	if !strings.Contains(got[0].LastError, "isn't there anymore") {
		t.Errorf("lastError = %q", got[0].LastError)
	}
}

func TestGitSync(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Someone", "-c", "user.email=someone@example.com"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	c, _ := newTestCore(t)
	secrets := mapSecrets{}
	c.SetSecretStore(secrets)
	data := t.TempDir()
	c.SetExportDir(data)
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(filepath.Dir(remote), "init", "--bare", "--initial-branch=main", remote)
	status := func() exportView { t.Helper(); return call[[]exportView](t, c, "export.destinations.list", "")[0] }
	sync := func() exportView {
		t.Helper()
		c.runExport(status().ID, false)
		return status()
	}
	noteByTitle := func(title string) *noteRow {
		t.Helper()
		for _, n := range call[[]noteRow](t, c, "notes.list", "") {
			if n.Title == title {
				return &n
			}
		}
		return nil
	}

	// ---- out ----
	note := call[idOnly](t, c, "notes.create", `{"title":"Hello","contentMd":"First."}`)
	keep := call[idOnly](t, c, "notes.create", `{"title":"Keep","contentMd":"Untouched."}`)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","remoteUrl":`+quote(remote)+`,"token":"s3cret","schedule":"manual"}`)
	if !dest.HasCredential || secrets["export/"+dest.ID] != "s3cret" {
		t.Fatalf("credential = %+v", dest)
	}
	if raw, _ := json.Marshal(dest); strings.Contains(string(raw), "s3cret") {
		t.Fatalf("the credential crossed the bridge: %s", raw)
	}
	if st := sync(); st.LastError != "" {
		t.Fatalf("first sync: %s", st.LastError)
	}
	if got := git(remote, "ls-tree", "-r", "--name-only", "main"); got != "Notes/Hello.md\nNotes/Keep.md" {
		t.Fatalf("remote tree = %q", got)
	}
	call[idOnly](t, c, "notes.update", `{"id":"`+note.ID+`","title":"Hello again"}`)
	sync()
	if got := git(remote, "log", "--format=%s", "main"); got != "Companion: 1 added, 1 removed\nCompanion: 2 added" {
		t.Errorf("log = %q", got)
	}

	// ---- in: someone edits the repository ----
	clone := filepath.Join(t.TempDir(), "clone")
	git(filepath.Dir(clone), "clone", remote, clone)
	hello, _ := os.ReadFile(filepath.Join(clone, "Notes/Hello again.md"))
	os.WriteFile(filepath.Join(clone, "Notes/Hello again.md"), []byte(strings.Replace(string(hello), "First.", "First, edited in the repository.", 1)), 0o644)
	os.WriteFile(filepath.Join(clone, "Notes/From git.md"), []byte("Written in a text editor. See [[Keep]].\n"), 0o644)
	os.MkdirAll(filepath.Join(clone, "Areas/Home/Tasks"), 0o755)
	os.WriteFile(filepath.Join(clone, "Areas/Home/Tasks/Buy milk.md"), []byte("---\nstatus: open\ndeadline: 2026-10-01\n---\n\nTwo litres.\n"), 0o644)
	os.WriteFile(filepath.Join(clone, "README.md"), []byte("# My notes\n"), 0o644)
	git(clone, "add", "-A")
	git(clone, "commit", "-m", "edits by hand")
	git(clone, "push", "origin", "main")

	st := sync()
	if st.LastError != "" || !strings.Contains(string(st.LastSummary), `"pulled":3`) {
		t.Fatalf("sync after remote edits: error %q, summary %s", st.LastError, st.LastSummary)
	}
	if n := noteByTitle("Hello again"); n == nil || n.ID != note.ID || n.ContentMd != "First, edited in the repository." {
		t.Errorf("the edited note = %+v", n)
	}
	fromGit := noteByTitle("From git")
	if fromGit == nil || fromGit.ContentMd != "Written in a text editor. See [[note:"+keep.ID+"]]." {
		t.Fatalf("a file written by hand should become a note, links resolved: %+v", fromGit)
	}
	var milk *taskRow
	for _, tk := range call[[]taskRow](t, c, "tasks.list", "") {
		if tk.Title == "Buy milk" {
			milk = &tk
		}
	}
	if milk == nil || milk.DueAt == nil || milk.NotesMd != "Two litres." {
		t.Fatalf("a task written by hand = %+v", milk)
	}
	if areas := call[[]idOnly](t, c, "areas.list", ""); len(areas) != 1 {
		t.Errorf("its folder should have made the area: %d areas", len(areas))
	}
	// Companion gave the hand-written files their ids, on top of the other commit; the README
	// is none of its business.
	git(clone, "pull", "origin", "main")
	written, _ := os.ReadFile(filepath.Join(clone, "Notes/From git.md"))
	if !strings.Contains(string(written), `id: "`+fromGit.ID+`"`) || !strings.Contains(string(written), "See [[Keep]].") {
		t.Errorf("the file should come back with its id:\n%s", written)
	}
	if readme, _ := os.ReadFile(filepath.Join(clone, "README.md")); string(readme) != "# My notes\n" {
		t.Errorf("README = %q", readme)
	}
	if got := git(remote, "log", "--format=%s", "-2", "main"); !strings.HasSuffix(got, "edits by hand") {
		t.Errorf("history should be linear, ours on top of theirs:\n%s", got)
	}

	// ---- a quiet sync changes nothing ----
	before := git(remote, "rev-parse", "main")
	sync()
	if after := git(remote, "rev-parse", "main"); after != before {
		t.Errorf("a sync with nothing to do made a commit: %s", git(remote, "log", "-1", "--format=%B", "main"))
	}

	// ---- both sides change one note: the repository's version wins, ours is kept as a copy ----
	call[idOnly](t, c, "notes.update", `{"id":"`+keep.ID+`","contentMd":"Edited in Companion."}`)
	kept, _ := os.ReadFile(filepath.Join(clone, "Notes/Keep.md"))
	os.WriteFile(filepath.Join(clone, "Notes/Keep.md"), []byte(strings.Replace(string(kept), "Untouched.", "Edited in the repository.", 1)), 0o644)
	git(clone, "commit", "-am", "conflicting edit")
	git(clone, "push", "origin", "main")
	if st := sync(); !strings.Contains(string(st.LastSummary), `"conflicts":1`) {
		t.Errorf("summary = %s", st.LastSummary)
	}
	if n := noteByTitle("Keep"); n == nil || n.ContentMd != "Edited in the repository." {
		t.Errorf("the note should take the repository's version: %+v", n)
	}
	copyFound := false
	for _, n := range call[[]noteRow](t, c, "notes.list", "") {
		copyFound = copyFound || (strings.Contains(n.Title, "conflicted copy") && n.ContentMd == "Edited in Companion.")
	}
	if !copyFound {
		t.Error("Companion's version should survive as a conflicted copy")
	}

	// ---- a deleted file sends its item to the Trash; a broken one is left alone ----
	git(clone, "pull", "origin", "main")
	os.Remove(filepath.Join(clone, "Notes/From git.md"))
	os.WriteFile(filepath.Join(clone, "Notes/Hello again.md"), []byte("---\ntitle: [broken\n---\nOops"), 0o644)
	git(clone, "commit", "-am", "delete one, break one")
	git(clone, "push", "origin", "main")
	st = sync()
	if !strings.Contains(string(st.LastSummary), `"trashed":1`) || !strings.Contains(string(st.LastSummary), `"unread":1`) {
		t.Errorf("summary = %s", st.LastSummary)
	}
	if noteByTitle("From git") != nil {
		t.Error("the deleted file's note should be in the Trash")
	}
	if trash := call[[]noteRow](t, c, "trash.list", ""); len(trash) == 0 {
		t.Error("…and recoverable from it")
	}
	if got := git(remote, "show", "main:Notes/Hello again.md"); !strings.Contains(got, "[broken") {
		t.Errorf("an unreadable file must be left as it is, not overwritten:\n%s", got)
	}
	if n := noteByTitle("Hello again"); n == nil || n.ContentMd != "First, edited in the repository." {
		t.Errorf("…and its note untouched: %+v", n)
	}

	// ---- unreachable remote: nothing is lost, and it recovers ----
	os.Rename(remote, remote+".away")
	call[idOnly](t, c, "notes.create", `{"title":"Offline","contentMd":"Written offline."}`)
	if st := sync(); st.LastError == "" {
		t.Error("an unreachable remote should be reported")
	}
	os.Rename(remote+".away", remote)
	if st := sync(); st.LastError != "" {
		t.Fatalf("after reconnecting: %s", st.LastError)
	}
	if got := git(remote, "ls-tree", "-r", "--name-only", "main"); !strings.Contains(got, "Notes/Offline.md") {
		t.Errorf("remote tree after reconnecting = %q", got)
	}
	git(remote, "fsck", "--strict")

	// ---- deleting the destination takes its local repository and credential with it ----
	if _, err := c.Invoke("export.destinations.delete", []byte(`{"id":"`+dest.ID+`"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, "export", dest.ID+".git")); !os.IsNotExist(err) {
		t.Error("local repository should be removed")
	}
	if _, ok := secrets["export/"+dest.ID]; ok {
		t.Error("credential should be removed")
	}
}

type noteRow struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	ContentMd string `json:"contentMd"`
}

type taskRow struct {
	ID      string     `json:"id"`
	Title   string     `json:"title"`
	NotesMd string     `json:"notesMd"`
	DueAt   *time.Time `json:"dueAt"`
}

// A repository that suddenly lost most of its files pauses the sync instead of binning the
// workspace; "Sync anyway" goes ahead, into the Trash.
func TestGitSyncDeletionGuard(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Someone", "-c", "user.email=someone@example.com"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	c, _ := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	c.SetExportDir(t.TempDir())
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(filepath.Dir(remote), "init", "--bare", "--initial-branch=main", remote)
	for i := 0; i < 30; i++ {
		call[idOnly](t, c, "notes.create", fmt.Sprintf(`{"title":"Note %02d","contentMd":"x"}`, i))
	}
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","remoteUrl":`+quote(remote)+`,"token":"t","schedule":"manual"}`)
	c.runExport(dest.ID, false)

	clone := filepath.Join(t.TempDir(), "clone")
	git(filepath.Dir(clone), "clone", remote, clone)
	git(clone, "rm", "-r", "-q", "Notes")
	git(clone, "commit", "-m", "oops")
	git(clone, "push", "origin", "main")

	c.runExport(dest.ID, false)
	st := call[[]exportView](t, c, "export.destinations.list", "")[0]
	if !strings.Contains(st.LastError, "were deleted there") {
		t.Fatalf("lastError = %q", st.LastError)
	}
	if notes := call[[]noteRow](t, c, "notes.list", ""); len(notes) != 30 {
		t.Fatalf("nothing should have been touched, have %d notes", len(notes))
	}
	c.runExport(dest.ID, true)
	if notes := call[[]noteRow](t, c, "notes.list", ""); len(notes) != 0 {
		t.Errorf("confirmed, they go to the Trash: %d left", len(notes))
	}
	if trash := call[[]noteRow](t, c, "trash.list", ""); len(trash) != 30 {
		t.Errorf("…all recoverable: %d in the Trash", len(trash))
	}
}

func TestExportSaveValidation(t *testing.T) {
	c, _ := newTestCore(t)
	if _, err := c.Invoke("export.destinations.save", []byte(`{"kind":"folder","path":"/tmp"}`)); err == nil {
		t.Error("exports should be off until the shell enables them")
	}
	if caps := call[map[string]bool](t, c, "export.capabilities", ""); caps["folder"] || caps["git"] {
		t.Errorf("capabilities = %v", caps)
	}
	c.SetExportDir(t.TempDir())
	c.SetSecretStore(mapSecrets{})
	for _, payload := range []string{
		`{"kind":"folder","path":"relative/path"}`,
		`{"kind":"folder","path":"/definitely/not/here"}`,
		`{"kind":"git","remoteUrl":"git@github.com:me/notes.git"}`,
		`{"kind":"git","remoteUrl":"https://github.com/me/notes.git","branch":"bad branch"}`,
		`{"kind":"ftp"}`,
	} {
		if _, err := c.Invoke("export.destinations.save", []byte(payload)); err == nil {
			t.Errorf("save %s should fail", payload)
		}
	}
	// A pasted credential is lifted out of the URL.
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","remoteUrl":"https://me:s3cr3t@example.com/me/notes.git","schedule":"manual","enabled":false}`)
	if strings.Contains(string(dest.Config), "s3cr3t") || !dest.HasCredential || dest.Name != "notes" {
		t.Errorf("config = %s, hasCredential = %v, name = %q", dest.Config, dest.HasCredential, dest.Name)
	}
}

func TestExportDue(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	cases := []struct {
		name      string
		d         store.ExportDestination
		changedAt time.Time
		startup   bool
		want      bool
	}{
		{"disabled", store.ExportDestination{Schedule: store.ExportHourly}, time.Time{}, false, false},
		{"never run", store.ExportDestination{Enabled: true, Schedule: store.ExportDaily}, time.Time{}, false, true},
		{"manual never runs itself", store.ExportDestination{Enabled: true, Schedule: store.ExportManual}, time.Time{}, true, false},
		{"hourly, not yet", store.ExportDestination{Enabled: true, Schedule: store.ExportHourly, LastRunAt: ago(30 * time.Minute)}, time.Time{}, false, false},
		{"hourly, due", store.ExportDestination{Enabled: true, Schedule: store.ExportHourly, LastRunAt: ago(61 * time.Minute)}, time.Time{}, false, true},
		{"changes, nothing changed", store.ExportDestination{Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(time.Hour)}, time.Time{}, false, false},
		{"changes, still typing", store.ExportDestination{Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(time.Hour)}, now.Add(-5 * time.Second), false, false},
		{"changes, settled", store.ExportDestination{Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(time.Hour)}, now.Add(-time.Minute), false, true},
		{"changes, already exported", store.ExportDestination{Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(time.Minute)}, now.Add(-2 * time.Minute), false, false},
		{"changes, on startup", store.ExportDestination{Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(time.Hour)}, time.Time{}, true, true},
		{"failed, too soon to retry", store.ExportDestination{Enabled: true, Schedule: store.ExportDaily, LastRunAt: ago(time.Minute), LastError: "x"}, time.Time{}, false, false},
		{"git polls for changes made in the repository", store.ExportDestination{Kind: store.ExportKindGit, Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(6 * time.Minute)}, time.Time{}, false, true},
		{"a folder has nothing to poll", store.ExportDestination{Kind: store.ExportKindFolder, Enabled: true, Schedule: store.ExportOnChanges, LastRunAt: ago(6 * time.Minute)}, time.Time{}, false, false},
		{"failed, retry", store.ExportDestination{Enabled: true, Schedule: store.ExportDaily, LastRunAt: ago(11 * time.Minute), LastError: "x"}, time.Time{}, false, true},
		{"push pending, retry", store.ExportDestination{Enabled: true, Schedule: store.ExportWeekly, LastRunAt: ago(11 * time.Minute), PushPending: true}, time.Time{}, false, true},
	}
	for _, tc := range cases {
		if got := exportDue(&tc.d, now, tc.changedAt, tc.startup); got != tc.want {
			t.Errorf("%s: due = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// With end-to-end encryption unlocked a Git export's credential rides in the synced row — sealed
// on the wire — instead of this device's secret store; without it, the other way round.
func TestGitExportCredentialSyncsEncrypted(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := mapSecrets{}
	c.SetSecretStore(secrets)
	c.SetExportDir(t.TempDir())
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	c.masterKey = key

	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","provider":"github","auth":"token","remoteUrl":"https://github.com/me/notes.git","token":"ghs_secret","schedule":"manual"}`)
	if !dest.HasCredential || !dest.ThisDevice || dest.DeviceID == "" {
		t.Fatalf("view = %+v", dest)
	}
	if len(secrets) != 0 {
		t.Errorf("with E2EE the credential belongs in the row, not the secret store: %v", secrets)
	}
	dirty, err := c.store.Exports.Git().Dirty()
	if err != nil || len(dirty) != 1 || dirty[0].CredentialEnc == nil || *dirty[0].CredentialEnc != "ghs_secret" {
		t.Fatalf("dirty rows = %+v, %v", dirty, err)
	}
	// What the engine pushes: every protected field is an envelope, nothing readable is left.
	raw, _ := json.Marshal(dirty[0])
	sealed, err := crypto.EncryptRow(key, protocol.EntityGitExport, raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"ghs_secret", "github.com/me/notes", dest.Name} {
		if strings.Contains(string(sealed), leak) {
			t.Errorf("%q is readable on the wire: %s", leak, sealed)
		}
	}
	if !strings.Contains(string(sealed), `"schedule":"manual"`) || !strings.Contains(string(sealed), `"deviceId":"`+dest.DeviceID+`"`) {
		t.Errorf("routing fields should stay plaintext: %s", sealed)
	}
	// And it round-trips onto another device's store.
	opened, err := crypto.DecryptRow(key, protocol.EntityGitExport, sealed)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := newTestCore(t)
	other.SetExportDir(t.TempDir())
	row, err := other.store.Exports.Git().Decode(opened)
	if err != nil {
		t.Fatal(err)
	}
	if err := other.store.Exports.Git().Apply(row); err != nil {
		t.Fatal(err)
	}
	views := call[[]exportView](t, other, "export.destinations.list", "")
	if len(views) != 1 || !views[0].HasCredential || views[0].ThisDevice || views[0].DeviceName == "" {
		t.Fatalf("on the other device = %+v", views)
	}
	// It has the settings and the credential, but it isn't the exporter: it never runs it…
	if exportsHere := other.exportsHere(views[0].ExportDestination); exportsHere {
		t.Error("the other device must not run the export")
	}
	if _, err := other.Invoke("export.destinations.run", []byte(`{"id":"`+dest.ID+`"}`)); err == nil || !strings.Contains(err.Error(), "runs on") {
		t.Errorf("run on a non-exporter: %v", err)
	}
	// …until it takes over, which the first device then learns through sync.
	took := call[exportView](t, other, "export.destinations.takeOver", `{"id":"`+dest.ID+`"}`)
	if !took.ThisDevice || took.DeviceID == dest.DeviceID {
		t.Errorf("after take over = %+v", took)
	}
}

// Without end-to-end encryption the credential must not sync at all.
func TestGitExportCredentialStaysLocalWithoutE2EE(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := mapSecrets{}
	c.SetSecretStore(secrets)
	c.SetExportDir(t.TempDir())
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","provider":"gitlab","auth":"https","remoteUrl":"https://gitlab.com/me/notes.git","username":"me","token":"hunter2","schedule":"manual"}`)
	if secrets["export/"+dest.ID] != "hunter2" {
		t.Fatalf("secret store = %v", secrets)
	}
	dirty, _ := c.store.Exports.Git().Dirty()
	if len(dirty) != 1 || dirty[0].CredentialEnc != nil {
		t.Fatalf("the credential must not be in the synced row: %+v", dirty[0])
	}
	if raw, _ := json.Marshal(dirty[0]); strings.Contains(string(raw), "hunter2") {
		t.Fatalf("credential in the wire body: %s", raw)
	}
	// A folder export syncs as its own kind of row, so the other devices know of it.
	call[exportView](t, c, "export.destinations.save", `{"kind":"folder","path":`+quote(t.TempDir())+`,"schedule":"manual"}`)
	if dirty, _ := c.store.Exports.Git().Dirty(); len(dirty) != 1 {
		t.Errorf("the git export alone should sync as a git export, got %d rows", len(dirty))
	}
	if dirty, _ := c.store.Exports.Folder().Dirty(); len(dirty) != 1 || dirty[0].DeviceID != dest.DeviceID {
		t.Errorf("the folder export should sync as a folder export, from this device: %+v", dirty)
	}
}

// A pulled row updates the settings and leaves this device's run state alone; a tombstone hides
// the export and clears what this device recorded for it.
func TestGitExportApplyKeepsLocalState(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	c.SetExportDir(t.TempDir())
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","auth":"token","remoteUrl":"https://example.com/me/notes.git","token":"t","schedule":"manual"}`)
	now := time.Now()
	if err := c.store.Exports.RecordRun(dest.ID, dest.DeviceID, store.ExportRun{RanAt: now, Success: &now, Summary: json.RawMessage(`{"added":2,"updated":0,"removed":0}`), PushPending: true}); err != nil {
		t.Fatal(err)
	}
	if err := c.store.Exports.ApplyToManifest(dest.ID, []store.ExportManifestRow{{Path: "Notes/A.md", EntityType: "note", EntityID: "1", SHA: "x"}}, nil); err != nil {
		t.Fatal(err)
	}
	row, err := c.store.Exports.Git().GetAny(dest.ID)
	if err != nil {
		t.Fatal(err)
	}
	row.Name, row.Schedule, row.Version = "Renamed elsewhere", "daily", 7
	if err := c.store.Exports.Git().Apply(row); err != nil {
		t.Fatal(err)
	}
	got, _ := c.store.Exports.Get(dest.ID)
	if got.Name != "Renamed elsewhere" || got.Schedule != "daily" || got.LastSuccessAt == nil || !got.PushPending || !strings.Contains(string(got.LastSummary), `"added":2`) {
		t.Errorf("after apply = %+v", got)
	}
	if got.CredentialRef == "" {
		t.Error("a pulled row without a credential must not drop this device's own")
	}
	if dirty, _ := c.store.Exports.Git().Dirty(); len(dirty) != 0 {
		t.Error("an applied row isn't dirty")
	}

	deleted := time.Now()
	row.DeletedAt = &deleted
	if err := c.store.Exports.Git().Apply(row); err != nil {
		t.Fatal(err)
	}
	if got, _ := c.store.Exports.Get(dest.ID); got != nil {
		t.Error("a tombstoned export should be gone from the list")
	}
	if m, _ := c.store.Exports.Manifest(dest.ID); len(m) != 0 {
		t.Error("its manifest should go with it")
	}
}

// An SSH export signs in with a key Companion generates; the user only ever sees the public half.
func TestGitExportSSHKeyFlow(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := mapSecrets{}
	c.SetSecretStore(secrets)
	c.SetExportDir(t.TempDir())

	if _, err := c.Invoke("export.destinations.save", []byte(`{"kind":"git","provider":"github","auth":"ssh","remoteUrl":"git@github.com:me/notes.git","schedule":"manual"}`)); err == nil {
		t.Error("an SSH export needs a key first")
	}
	if _, err := c.Invoke("export.destinations.save", []byte(`{"kind":"git","provider":"github","auth":"ssh","remoteUrl":"https://github.com/me/notes.git","sshKeyId":"x","schedule":"manual"}`)); err == nil {
		t.Error("an SSH export needs an SSH address")
	}
	if _, err := c.Invoke("export.destinations.save", []byte(`{"kind":"git","provider":"github","auth":"token","remoteUrl":"git@github.com:me/notes.git","token":"t","schedule":"manual"}`)); err == nil {
		t.Error("a token export needs an https address")
	}

	key := call[struct{ KeyID, PublicKey string }](t, c, "export.sshKey.generate", "")
	if !strings.HasPrefix(key.PublicKey, "ssh-ed25519 ") || secrets["export-key/"+key.KeyID] == "" {
		t.Fatalf("generated key = %+v, secrets = %d", key, len(secrets))
	}
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","provider":"github","auth":"ssh","remoteUrl":"git@github.com:me/notes.git","sshKeyId":"`+key.KeyID+`","schedule":"manual"}`)
	var cfg gitConfig
	json.Unmarshal(dest.Config, &cfg)
	if cfg.PublicKey != key.PublicKey || cfg.Auth != "ssh" || !dest.HasCredential {
		t.Errorf("config = %+v", cfg)
	}
	if _, pending := secrets["export-key/"+key.KeyID]; pending || !strings.Contains(secrets["export/"+dest.ID], "OPENSSH PRIVATE KEY") {
		t.Errorf("the key should move from its pending slot to the destination's: %v", len(secrets))
	}
	if raw, _ := json.Marshal(dest); strings.Contains(string(raw), "PRIVATE KEY") {
		t.Error("the private key crossed the bridge")
	}
	// Editing other settings keeps the key; a cancelled dialog discards its unused one.
	edited := call[exportView](t, c, "export.destinations.save", `{"id":"`+dest.ID+`","kind":"git","provider":"github","auth":"ssh","remoteUrl":"git@github.com:me/notes.git","branch":"exports","schedule":"manual"}`)
	json.Unmarshal(edited.Config, &cfg)
	if cfg.PublicKey != key.PublicKey || cfg.Branch != "exports" {
		t.Errorf("after edit = %+v", cfg)
	}
	unused := call[struct{ KeyID string }](t, c, "export.sshKey.generate", "")
	if _, err := c.Invoke("export.sshKey.discard", []byte(`{"keyId":"`+unused.KeyID+`"}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := secrets["export-key/"+unused.KeyID]; ok {
		t.Error("a discarded key should be gone")
	}
}

func TestGitTokenUsernames(t *testing.T) {
	cases := []struct {
		cfg  gitConfig
		want string
	}{
		{gitConfig{Provider: "github", Auth: "token"}, "x-access-token"},
		{gitConfig{Provider: "gitlab", Auth: "token"}, "oauth2"},
		{gitConfig{Provider: "bitbucket", Auth: "token"}, "x-token-auth"},
		{gitConfig{Provider: "other", Auth: "token"}, "git"},
		{gitConfig{Provider: "bitbucket", Auth: "https", Username: "me"}, "me"},
		{gitConfig{Provider: "other", Auth: "token", Username: "deploy"}, "deploy"},
	}
	for _, tc := range cases {
		if got := tc.cfg.httpUsername(); got != tc.want {
			t.Errorf("%+v → %q, want %q", tc.cfg, got, tc.want)
		}
	}
}

// pngBytes is a recognisable stand-in for an image.
func pngBytes(tag string) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), []byte(tag)...) }

func withBlobs(t *testing.T, c *Core) {
	t.Helper()
	fs, err := blob.NewFSStore(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetBlobStore(fs)
}

func ingest(t *testing.T, c *Core, filename string, content []byte) idOnly {
	t.Helper()
	return call[idOnly](t, c, "documents.ingestBytes", `{"filename":`+quote(filename)+`,"mime":"image/png","data":"`+base64.StdEncoding.EncodeToString(content)+`"}`)
}

// Attachments go out to a folder beside the notes that embed them, named by their file.
func TestFolderExportAttachments(t *testing.T) {
	c, _ := newTestCore(t)
	withBlobs(t, c)
	c.SetExportDir(t.TempDir())
	root := t.TempDir()

	photo := ingest(t, c, "Photo: beach.png", pngBytes("beach"))
	twin := ingest(t, c, "Photo: beach.png", pngBytes("another beach"))
	call[idOnly](t, c, "notes.create", `{"title":"Holiday","contentMd":"![[doc:`+photo.ID+`]] and ![[doc:`+twin.ID+`|the other]]"}`)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"folder","path":`+quote(root)+`,"schedule":"manual"}`)
	c.runExport(dest.ID, false)

	want := []string{"Attachments/Photo beach 2.png", "Attachments/Photo beach.png", "Notes/Holiday.md"}
	if got := tree(t, root); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("tree = %v\nwant   %v", got, want)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "Attachments/Photo beach.png")); string(got) != string(pngBytes("beach")) {
		t.Errorf("attachment bytes = %q", got)
	}
	note, _ := os.ReadFile(filepath.Join(root, "Notes/Holiday.md"))
	if !strings.Contains(string(note), "![[Attachments/Photo beach.png]] and ![[Attachments/Photo beach 2.png|the other]]") {
		t.Errorf("embeds should name the exported files:\n%s", note)
	}

	// Unchanged attachments are never read again, let alone rewritten.
	before, _ := os.Stat(filepath.Join(root, "Attachments/Photo beach.png"))
	c.runExport(dest.ID, false)
	after, _ := os.Stat(filepath.Join(root, "Attachments/Photo beach.png"))
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("an unchanged attachment was rewritten")
	}

	// Bytes that aren't on this device yet wait for a later run instead of failing this one.
	ghost, err := c.store.Documents.Create(store.CreateDocumentInput{Filename: "elsewhere.png", Mime: "image/png", Size: 3, SHA256: strings.Repeat("ab", 32)})
	if err != nil {
		t.Fatal(err)
	}
	c.runExport(dest.ID, false)
	st := call[[]exportView](t, c, "export.destinations.list", "")[0]
	if st.LastError != "" || !strings.Contains(string(st.LastSummary), `"waiting":1`) {
		t.Errorf("a missing blob should wait, not fail: error %q summary %s (doc %s)", st.LastError, st.LastSummary, ghost.ID)
	}
	if _, err := os.Stat(filepath.Join(root, "Attachments/elsewhere.png")); !os.IsNotExist(err) {
		t.Error("nothing should be written for bytes we don't have")
	}
}

// Attachments travel both ways through Git, and replacing one re-points what embedded it.
func TestGitSyncAttachments(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Someone", "-c", "user.email=someone@example.com"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	c, _ := newTestCore(t)
	withBlobs(t, c)
	c.SetSecretStore(mapSecrets{})
	c.SetExportDir(t.TempDir())
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(filepath.Dir(remote), "init", "--bare", "--initial-branch=main", remote)

	photo := ingest(t, c, "beach.png", pngBytes("beach"))
	note := call[idOnly](t, c, "notes.create", `{"title":"Holiday","contentMd":"![[doc:`+photo.ID+`]]"}`)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","remoteUrl":`+quote(remote)+`,"token":"t","schedule":"manual"}`)
	c.runExport(dest.ID, false)
	if got := git(remote, "ls-tree", "-r", "--name-only", "main"); got != "Attachments/beach.png\nNotes/Holiday.md" {
		t.Fatalf("remote tree = %q", got)
	}

	// In the repository: a new picture embedded by a new note, and the old picture replaced.
	clone := filepath.Join(t.TempDir(), "clone")
	git(filepath.Dir(clone), "clone", remote, clone)
	os.WriteFile(filepath.Join(clone, "Attachments/sunset.png"), pngBytes("sunset"), 0o644)
	os.WriteFile(filepath.Join(clone, "Notes/Evening.md"), []byte("Look: ![[Attachments/sunset.png]] and ![old](../Attachments/beach.png)\n"), 0o644)
	os.WriteFile(filepath.Join(clone, "Attachments/beach.png"), pngBytes("a better beach"), 0o644)
	git(clone, "add", "-A")
	git(clone, "commit", "-m", "pictures")
	git(clone, "push", "origin", "main")
	c.runExport(dest.ID, false)
	st := call[[]exportView](t, c, "export.destinations.list", "")[0]
	if st.LastError != "" {
		t.Fatalf("sync: %s", st.LastError)
	}

	type docRow struct{ ID, Filename, Sha256 string }
	docs := call[[]docRow](t, c, "documents.list", "")
	byName := map[string]docRow{}
	for _, d := range docs {
		byName[d.Filename] = d
	}
	if len(docs) != 2 || byName["sunset.png"].ID == "" || byName["beach.png"].ID == photo.ID {
		t.Fatalf("documents after sync = %+v (the old beach was %s)", docs, photo.ID)
	}
	var evening, holiday string
	for _, n := range call[[]noteRow](t, c, "notes.list", "") {
		switch n.Title {
		case "Evening":
			evening = n.ContentMd
		case "Holiday":
			holiday = n.ContentMd
		}
	}
	if want := "Look: ![[doc:" + byName["sunset.png"].ID + "]] and ![[doc:" + byName["beach.png"].ID + "]]"; evening != want {
		t.Errorf("the new note's embeds = %q\nwant %q", evening, want)
	}
	if holiday != "![[doc:"+byName["beach.png"].ID+"]]" {
		t.Errorf("the note that embedded the old picture should embed its replacement: %q (note %s)", holiday, note.ID)
	}
	if got := git(remote, "show", "main:Attachments/beach.png"); !strings.Contains(got, "a better beach") {
		t.Errorf("the replacement must not be reverted: %q", got)
	}
	if got := git(remote, "ls-tree", "-r", "--name-only", "main"); got != "Attachments/beach.png\nAttachments/sunset.png\nNotes/Evening.md\nNotes/Holiday.md" {
		t.Errorf("remote tree = %q", got)
	}
	git(remote, "fsck", "--strict")
}

// A device that takes a Git sync over has no base of its own. It must work out where it stands
// from the repository itself — not import the lot over newer work, and not fork conflicts.
func TestGitSyncTakeOverAdoptsTheRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Someone", "-c", "user.email=someone@example.com"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	c, _ := newTestCore(t)
	withBlobs(t, c)
	c.SetSecretStore(mapSecrets{})
	c.SetExportDir(t.TempDir())
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(filepath.Dir(remote), "init", "--bare", "--initial-branch=main", remote)

	renamed := call[idOnly](t, c, "notes.create", `{"title":"Old name","contentMd":"Renamed later."}`)
	trashed := call[idOnly](t, c, "notes.create", `{"title":"Doomed","contentMd":"Trashed later."}`)
	movedOn := call[idOnly](t, c, "notes.create", `{"title":"Moved on","contentMd":"Version one."}`)
	task := call[idOnly](t, c, "tasks.create", `{"title":"Edited by hand","notesMd":"Original."}`)
	call[idOnly](t, c, "notes.create", `{"title":"Quiet","contentMd":"Never touched."}`)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"git","remoteUrl":`+quote(remote)+`,"token":"t","schedule":"manual"}`)
	c.runExport(dest.ID, false)

	// While nobody is syncing to Git: things change in Companion (as they would arrive on the
	// new device through the server)…
	time.Sleep(5 * time.Millisecond)
	call[idOnly](t, c, "notes.update", `{"id":"`+renamed.ID+`","title":"New name"}`)
	call[idOnly](t, c, "notes.update", `{"id":"`+movedOn.ID+`","contentMd":"Version two."}`)
	if _, err := c.Invoke("notes.delete", []byte(`{"id":"`+trashed.ID+`"}`)); err != nil {
		t.Fatal(err)
	}
	// …and in the repository.
	clone := filepath.Join(t.TempDir(), "clone")
	git(filepath.Dir(clone), "clone", remote, clone)
	byHand, _ := os.ReadFile(filepath.Join(clone, "Tasks/Edited by hand.md"))
	os.WriteFile(filepath.Join(clone, "Tasks/Edited by hand.md"), []byte(strings.Replace(string(byHand), "Original.", "Changed in the repository.", 1)), 0o644)
	os.WriteFile(filepath.Join(clone, "Notes/Brand new.md"), []byte("Written in the repository.\n"), 0o644)
	os.WriteFile(filepath.Join(clone, "README.md"), []byte("# Notes\n"), 0o644)
	git(clone, "add", "-A")
	git(clone, "commit", "-m", "by hand")
	git(clone, "push", "origin", "main")

	// The takeover: same workspace, no manifest, no base, no local repository.
	taken := call[exportView](t, c, "export.destinations.takeOver", `{"id":"`+dest.ID+`"}`)
	if !taken.ThisDevice {
		t.Fatalf("takeOver = %+v", taken)
	}
	c.runExport(dest.ID, false)
	st := call[[]exportView](t, c, "export.destinations.list", "")[0]
	if st.LastError != "" {
		t.Fatalf("first sync after taking over: %s", st.LastError)
	}
	if strings.Contains(string(st.LastSummary), `"conflicts":1`) || !strings.Contains(string(st.LastSummary), `"conflicts":0`) {
		t.Errorf("a takeover must not fork conflicts: %s", st.LastSummary)
	}

	want := "Notes/Brand new.md\nNotes/Moved on.md\nNotes/New name.md\nNotes/Quiet.md\nREADME.md\nTasks/Edited by hand.md"
	if got := git(remote, "ls-tree", "-r", "--name-only", "main"); got != want {
		t.Errorf("repository after takeover =\n%s\nwant\n%s", got, want)
	}
	if got := git(remote, "show", "main:Notes/Moved on.md"); !strings.Contains(got, "Version two.") {
		t.Errorf("the newer item should win over its stale file:\n%s", got)
	}
	titles := map[string]string{}
	for _, n := range call[[]noteRow](t, c, "notes.list", "") {
		titles[n.Title] = n.ContentMd
		if strings.Contains(n.Title, "conflicted copy") {
			t.Errorf("unexpected conflicted copy: %q", n.Title)
		}
	}
	if titles["Moved on"] != "Version two." {
		t.Errorf("stale repository content overwrote newer work: %q", titles["Moved on"])
	}
	if _, resurrected := titles["Doomed"]; resurrected {
		t.Error("a trashed note's leftover file must not bring it back")
	}
	if titles["Brand new"] != "Written in the repository." {
		t.Errorf("a file written in the repository should come in: %v", titles)
	}
	for _, tk := range call[[]taskRow](t, c, "tasks.list", "") {
		if tk.ID == task.ID && tk.NotesMd != "Changed in the repository." {
			t.Errorf("an edit made in the repository should come in: %q", tk.NotesMd)
		}
	}
	git(remote, "fsck", "--strict")
}

// Importing a vault brings along the images its notes embed — however they're written, wherever
// they sit — and leaves behind the files no note uses.
func TestImportFilesWithAttachments(t *testing.T) {
	c, _ := newTestCore(t)
	withBlobs(t, c)
	vault := t.TempDir()
	write := func(rel string, content []byte) {
		t.Helper()
		full := filepath.Join(vault, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Journal/Monday.md", []byte("Obsidian style: ![[diagram.png]]\n\nPlain markdown: ![a chart](../assets/chart%20v2.png)\n\nOn the web: ![logo](https://example.com/logo.png)\n"))
	write("assets/diagram.png", pngBytes("diagram"))
	write("assets/chart v2.png", pngBytes("chart"))
	write("assets/unused.png", pngBytes("nobody embeds me"))
	write("Attachments/exported.pdf", []byte("%PDF- from a Companion export"))
	write(".obsidian/workspace.json", []byte(`{}`))

	type report struct {
		Files   int
		Summary struct{ Notes, Attachments, Created, Skipped, Failed int }
	}
	scan := call[report](t, c, "imports.files.scan", `{"path":`+quote(vault)+`}`)
	if scan.Files != 4 || scan.Summary.Notes != 1 || scan.Summary.Attachments != 3 || scan.Summary.Skipped != 0 {
		t.Fatalf("scan = %+v", scan)
	}
	if docs := call[[]idOnly](t, c, "documents.list", ""); len(docs) != 0 {
		t.Fatal("a scan must not write anything")
	}

	done := call[report](t, c, "imports.files.run", `{"path":`+quote(vault)+`}`)
	if done.Summary.Created != 4 || done.Summary.Failed != 0 {
		t.Fatalf("run = %+v", done)
	}
	type docRow struct{ ID, Filename string }
	ids := map[string]string{}
	for _, d := range call[[]docRow](t, c, "documents.list", "") {
		ids[d.Filename] = d.ID
	}
	if len(ids) != 3 || ids["unused.png"] != "" {
		t.Fatalf("documents = %v", ids)
	}
	notes := call[[]noteRow](t, c, "notes.list", "")
	want := "Obsidian style: ![[doc:" + ids["diagram.png"] + "]]\n\nPlain markdown: ![[doc:" + ids["chart v2.png"] + "]]\n\nOn the web: ![logo](https://example.com/logo.png)"
	if len(notes) != 1 || notes[0].ContentMd != want {
		t.Errorf("imported note =\n%q\nwant\n%q", notes[0].ContentMd, want)
	}

	// Importing the same folder again makes no second copy of anything.
	again := call[report](t, c, "imports.files.run", `{"path":`+quote(vault)+`}`)
	if docs := call[[]docRow](t, c, "documents.list", ""); len(docs) != 3 {
		t.Errorf("a re-import duplicated attachments: %d (%+v)", len(docs), again)
	}
}
