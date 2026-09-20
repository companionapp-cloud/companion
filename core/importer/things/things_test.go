//go:build !js

package things

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

const zone = "America/Halifax" // UTC−3 in September and October (ADT)

func halifax(t *testing.T, y int, m time.Month, d, h, min int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatal(err)
	}
	return time.Date(y, m, d, h, min, 0, 0, loc)
}

func fixtureSource(t *testing.T) Source {
	t.Helper()
	return Source{Path: snapshot(t, writeFixture(t, t.TempDir()))}
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestScanOutline(t *testing.T) {
	pv, err := Scan(fixtureSource(t), Options{TimeZone: zone})
	if err != nil {
		t.Fatal(err)
	}
	if pv.Version != 26 || pv.Tags != 3 {
		t.Errorf("version %d tags %d, want 26 and 3", pv.Version, pv.Tags)
	}
	if want := (Counts{Tasks: 3, Repeating: 1}); pv.Inbox != want {
		t.Errorf("inbox = %+v, want %+v (milk, book and the lost heading's to-do, and the watering repeat)", pv.Inbox, want)
	}
	want := []AreaOutline{
		{ID: areaHome, Name: "Home", Counts: Counts{Tasks: 2, Completed: 1}, Projects: []ProjectOutline{
			{ID: projGarden, Name: "Garden", Finished: true, Counts: Counts{Completed: 1}},
		}},
		{ID: areaWork, Name: "Work", Projects: []ProjectOutline{
			{ID: projLaunch, Name: "Launch", Headings: 1, Counts: Counts{Tasks: 4, Completed: 3, Repeating: 1}},
			{ID: "ProjSprintOld", Name: "Sprint (old)"},
			{ID: projSprint, Name: "Sprint", Repeats: true, Counts: Counts{Tasks: 1}},
		}},
	}
	if !reflect.DeepEqual(pv.Areas, want) {
		got, _ := json.MarshalIndent(pv.Areas, "", " ")
		t.Errorf("areas =\n%s", got)
	}
	// The wire shape keeps every count alongside the finished flag.
	if b, _ := json.Marshal(pv.Areas[0].Projects[0]); string(b) != `{"id":"ProjGarden","name":"Garden","finished":true,"repeats":false,"headings":0,"tasks":0,"completed":1,"repeating":0}` {
		t.Errorf("project outline JSON = %s", b)
	}
	// A repeating project with no open copy is listed by its template, which stands in for the
	// next one.
	wantNoArea := []ProjectOutline{
		{ID: projSide, Name: "Side quest", Counts: Counts{Tasks: 1}},
		{ID: projClose, Name: "Monthly close", Repeats: true, Counts: Counts{Tasks: 1}},
	}
	if !reflect.DeepEqual(pv.NoArea, wantNoArea) {
		t.Errorf("projects in no area = %+v, want %+v", pv.NoArea, wantNoArea)
	}
	for _, w := range []string{"Tags on 1 area", "“Water plants” repeats after completion", "“Stretch” is paused", "“Pay installment”: its repeat has already ended"} {
		if !containsText(pv.Warnings, w) {
			t.Errorf("warnings %q lack %q", pv.Warnings, w)
		}
	}
}

func TestRunImportsTheLibrary(t *testing.T) {
	st := newStore(t)
	var stages []string
	sum, err := Run(context.Background(), st, fixtureSource(t), Options{TimeZone: zone}, func(stage string, done, total int) {
		stages = append(stages, stage)
		if done > total {
			t.Errorf("progress %d/%d", done, total)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Summary{Areas: 3, Projects: 5, RepeatingProjects: 2, Lists: 4, Headings: 1, Tasks: 12, Repeating: 2, Notes: 1}
	got := *sum
	got.Warnings = nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("summary = %+v, want %+v", got, want)
	}
	if len(stages) == 0 {
		t.Error("no progress reported")
	}

	// Areas in Things' order, then the catch-all for projects with no area.
	areas, _ := st.Areas.List()
	if names := areaNames(areas); !reflect.DeepEqual(names, []string{"Home", "Work", "Things"}) {
		t.Fatalf("areas = %v", names)
	}
	projects := projectsByName(t, st)
	for name, area := range map[string]string{"Launch": "Work", "Side quest": "Things"} {
		p := projects[name]
		if p == nil || areaName(areas, p.AreaID) != area {
			t.Errorf("project %q should be in area %q", name, area)
		}
	}
	if projects["Garden"] != nil {
		t.Error("a finished project shouldn't import without the Logbook")
	}

	// Launch keeps Things' order in its list: loose to-dos, then each heading with its own.
	launch := projects["Launch"]
	if launch == nil {
		t.Fatalf("Launch wasn't imported (projects %v)", keys(projects))
	}
	if got := listRows(t, st, launch.ID); !reflect.DeepEqual(got, []string{"Budget", "Weekly review", "Kickoff", "# Marketing", "Write post"}) {
		t.Errorf("Launch list = %v", got)
	}
	// An area's own to-dos are filed directly in the area — no project is generated to hold
	// them (PLAN-areas.md §2). A to-do whose project is gone files by its area the same way.
	if projects["Home"] != nil {
		t.Error("an area's own to-dos shouldn't generate a project named after the area")
	}
	if got := areaTasks(t, st, areas, "Home"); !reflect.DeepEqual(got, []string{"Call mom", "Lost project"}) {
		t.Errorf("Home's own to-dos = %v, want them filed in the area", got)
	}

	// What a project can't hold becomes a note in it; its deadline is the project's own.
	note := projectNote(t, st, launch.ID)
	if note.Title != "Launch" || note.ContentMD != "Ship the thing.\n\nTags: Errand" {
		t.Errorf("Launch note = %q / %q", note.Title, note.ContentMD)
	}
	if launch.DueAt == nil || !launch.DueAt.Equal(halifax(t, 2026, 10, 30, dueHour, 0)) {
		t.Errorf("Launch deadline = %v, want Oct 30 2026", launch.DueAt)
	}

	tasks := tasksByTitle(t, st)
	budget := tasks["Budget"]
	wantNotes := "See [[project:" + launch.ID + "|the plan]] and [[task:" + tasks["Kickoff"].ID + "|Kickoff]], not things:///show?id=Nowhere.\n\n" +
		"- [x] Get quotes\n- [x] ~~Cut costs~~\n- [ ] Sign off\n\nTags: Waiting For, Errand"
	if budget.NotesMD != wantNotes {
		t.Errorf("Budget notes =\n%q\nwant\n%q", budget.NotesMD, wantNotes)
	}
	if got := tasks["Call mom"].NotesMD; got != "Ask about <the> trip" {
		t.Errorf("legacy XML notes = %q", got)
	}

	// Dates are wall-clock times where the user is: an evening start at 6pm, a deadline at
	// 5pm, and a reminder at its time on the When date.
	post := tasks["Write post"]
	sameTime(t, "Write post start", post.StartAt, halifax(t, 2026, 10, 5, 18, 0))
	sameTime(t, "Write post deadline", post.DueAt, halifax(t, 2026, 10, 7, 17, 0))
	if len(post.Reminders) != 1 || post.Reminders[0].At == nil || !post.Reminders[0].At.Equal(halifax(t, 2026, 10, 5, 19, 30)) {
		t.Errorf("Write post reminders = %+v", post.Reminders)
	}
	sameTime(t, "Read book start", tasks["Read book"].StartAt, halifax(t, 2026, 9, 1, 0, 0))
	if m := tasks["Buy milk"]; m.StartAt != nil || m.DueAt != nil {
		t.Errorf("an Inbox to-do has no dates: %+v", m)
	}
	// Things' current instance of a repeat imports as an ordinary task.
	instance := tasks["Weekly review"]
	sameTime(t, "review instance deadline", instance.DueAt, halifax(t, 2026, 9, 18, 17, 0))
	if instance.RepeatRule != nil {
		t.Error("an instance isn't a seed")
	}

	// Inbox to-dos are in no project.
	for _, title := range []string{"Buy milk", "Read book"} {
		if members, _ := st.ProjectMembers.ListForEntity(domain.NodeTask, tasks[title].ID); len(members) != 0 {
			t.Errorf("%q should be in no project", title)
		}
	}
	for _, title := range []string{"Gone", "In a trashed project", "Plan sprint (template)", "Prune roses", "Paint fence", "Ship v1"} {
		if tasks[title] != nil {
			t.Errorf("%q shouldn't be imported", title)
		}
	}

	// Repeating to-dos become seeds anchored on their next instance.
	seeds := seedsByTitle(t, st)
	review := seeds["Weekly review"]
	if review == nil || *review.RepeatRule != "FREQ=WEEKLY;BYDAY=FR" {
		t.Fatalf("weekly review seed = %+v", review)
	}
	sameTime(t, "review seed deadline", review.DueAt, halifax(t, 2026, 9, 25, 17, 0)) // Friday
	sameTime(t, "review seed start", review.StartAt, halifax(t, 2026, 9, 23, 0, 0))   // 2 days early
	if len(review.Reminders) != 1 || !review.Reminders[0].At.Equal(halifax(t, 2026, 9, 23, 9, 0)) {
		t.Errorf("review seed reminders = %+v", review.Reminders)
	}
	if members, _ := st.ProjectMembers.ListForEntity(domain.NodeTask, review.ID); len(members) != 1 || members[0].ProjectID != launch.ID {
		t.Error("the review seed should be in Launch")
	}
	water := seeds["Water plants"]
	if water == nil || *water.RepeatRule != "FREQ=DAILY;INTERVAL=3" || water.DueAt != nil {
		t.Fatalf("watering seed = %+v (start-anchored, no deadline)", water)
	}
	sameTime(t, "watering seed start", water.StartAt, halifax(t, 2026, 9, 20, 0, 0))
	if len(seeds) != 2 {
		t.Errorf("seeds = %v, want only the review and the watering", keys(seeds))
	}

	// A repeating project's newest open copy carries the repeat on — after completion, as in
	// Things; an older copy is an ordinary project, and the template's own to-dos stay behind.
	sprint := projects["Sprint"]
	if sprint == nil || sprint.RepeatAfter == nil || *sprint.RepeatAfter != "P2W" || sprint.RepeatRule != nil {
		t.Fatalf("Sprint = %+v, want it to repeat 2 weeks after completion", sprint)
	}
	sameTime(t, "Sprint start", sprint.StartAt, halifax(t, 2026, 9, 14, 0, 0))
	if got := listRows(t, st, sprint.ID); !reflect.DeepEqual(got, []string{"Plan sprint"}) {
		t.Errorf("Sprint list = %v", got)
	}
	if old := projects["Sprint (old)"]; old == nil || old.Repeats() {
		t.Errorf("Sprint (old) = %+v, want an ordinary project", old)
	}
	// With no open copy, the template is the next one: it starts on the series' next date with
	// the template's to-dos, and "five times" (two made) ends on the day of the last — the
	// server reads the rule in UTC, where Dec 1 comes an hour early once the clocks go back.
	monthly := projects["Monthly close"]
	if monthly == nil || monthly.RepeatRule == nil || *monthly.RepeatRule != "FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20261201T035959Z" {
		t.Fatalf("Monthly close = %+v", monthly)
	}
	sameTime(t, "Monthly close start", monthly.StartAt, halifax(t, 2026, 10, 1, 0, 0))
	if got := listRows(t, st, monthly.ID); !reflect.DeepEqual(got, []string{"Reconcile"}) {
		t.Errorf("Monthly close list = %v", got)
	}
}


func TestRunWithTheLogbook(t *testing.T) {
	st := newStore(t)
	sum, err := Run(context.Background(), st, fixtureSource(t), Options{TimeZone: zone, IncludeCompleted: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Projects != 6 || sum.Tasks != 17 {
		t.Errorf("summary = %+v, want 6 projects and 17 tasks", sum)
	}
	projects := projectsByName(t, st)
	if g := projects["Garden"]; g == nil || g.ArchivedAt == nil {
		t.Errorf("a finished project imports archived: %+v", g)
	}
	tasks := tasksByTitle(t, st)
	ship := tasks["Ship v1"]
	if ship == nil || ship.Status != domain.TaskDone || ship.CompletedAt == nil || ship.CompletedAt.Unix() != 1758000000 {
		t.Errorf("Ship v1 = %+v, want done with its completion date", ship)
	}
	if d := tasks["Dropped idea"]; d == nil || d.Status != domain.TaskCancelled {
		t.Errorf("a canceled to-do imports cancelled: %+v", d)
	}
	// An area's finished to-dos are filed in it with the rest.
	areas, _ := st.Areas.List()
	if got := areaTasks(t, st, areas, "Home"); !reflect.DeepEqual(got, []string{"Call mom", "Lost project", "Paint fence"}) {
		t.Errorf("Home's own to-dos with the Logbook = %v", got)
	}
	// Finished to-dos are project members but stay out of the list, like Things' Logbook.
	if got := listRows(t, st, projects["Launch"].ID); !reflect.DeepEqual(got, []string{"Budget", "Weekly review", "Kickoff", "# Marketing", "Write post"}) {
		t.Errorf("Launch list = %v", got)
	}
}

func TestRunSelection(t *testing.T) {
	src := fixtureSource(t)

	// An area with none of its projects, and a project in no area; no Inbox.
	st := newStore(t)
	sum, err := Run(context.Background(), st, src, Options{TimeZone: zone, Selection: &Selection{Areas: []string{areaWork}, Projects: []string{projSide}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	areas, _ := st.Areas.List()
	if names := areaNames(areas); !reflect.DeepEqual(names, []string{"Work", "Things"}) {
		t.Errorf("areas = %v", names)
	}
	if sum.Projects != 1 || sum.Tasks != 1 || sum.Repeating != 0 {
		t.Errorf("summary = %+v, want only Side quest's one to-do", sum)
	}
	for _, w := range sum.Warnings {
		if strings.Contains(w, "Water plants") || strings.Contains(w, "Monthly close") {
			t.Errorf("a warning about something not imported: %q", w)
		}
	}

	// A project on its own brings its area; the area's own to-dos stay behind.
	st = newStore(t)
	if _, err := Run(context.Background(), st, src, Options{TimeZone: zone, Selection: &Selection{Inbox: true, Projects: []string{projGarden}}, IncludeCompleted: true}, nil); err != nil {
		t.Fatal(err)
	}
	areas, _ = st.Areas.List()
	projects := projectsByName(t, st)
	if names := areaNames(areas); !reflect.DeepEqual(names, []string{"Home"}) || projects["Garden"] == nil || projects["Home"] != nil {
		t.Errorf("areas %v projects %v, want Home with only Garden", names, keys(projects))
	}
	tasks := tasksByTitle(t, st)
	if tasks["Buy milk"] == nil || tasks["Call mom"] != nil {
		t.Error("the Inbox came, Home's own to-dos didn't")
	}

	// Nothing chosen: nothing written.
	st = newStore(t)
	sum, err = Run(context.Background(), st, src, Options{TimeZone: zone, Selection: &Selection{}}, nil)
	if err != nil || sum.Areas+sum.Projects+sum.Tasks != 0 {
		t.Errorf("an empty selection wrote %+v (%v)", sum, err)
	}
}

func TestRunCancel(t *testing.T) {
	defer func(n int) { batchSize = n }(batchSize)
	batchSize = 2
	st := newStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after the first batch: it stays written, nothing after it is.
	sum, err := Run(ctx, st, fixtureSource(t), Options{TimeZone: zone}, func(string, int, int) { cancel() })
	if err != nil {
		t.Fatal(err)
	}
	// The first batch of two: the Home area, then the first of its own to-dos.
	if !sum.Cancelled || sum.Areas != 1 || sum.Projects != 0 || sum.Tasks != 1 {
		t.Errorf("summary = %+v, want cancelled after one area and its first to-do", sum)
	}
	if areas, _ := st.Areas.List(); len(areas) != 1 {
		t.Errorf("areas written = %d, want 1", len(areas))
	}
}

func TestSources(t *testing.T) {
	dir := t.TempDir()
	mainPath := writeFixture(t, dir)
	pkg := snapshot(t, mainPath)
	full, err := Scan(Source{Path: pkg}, Options{})
	if err != nil {
		t.Fatal(err)
	}

	// A folder above the package: Things' own Backups (an older copy) are skipped.
	parent := filepath.Dir(pkg)
	backup := filepath.Join(parent, "Backups", "old.thingsdatabase")
	if err := os.MkdirAll(backup, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(backup, "main.sqlite"), mustRead(t, filepath.Join(pkg, "main.sqlite")), 0o644)
	future := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(backup, "main.sqlite"), future, future)
	fromParent, err := Scan(Source{Path: parent}, Options{})
	if err != nil || !reflect.DeepEqual(fromParent, full) {
		t.Errorf("scanning the folder above the package = %+v, %v", fromParent, err)
	}

	// main.sqlite itself (with its -wal beside it).
	if pv, err := Scan(Source{Path: filepath.Join(pkg, "main.sqlite")}, Options{}); err != nil || !reflect.DeepEqual(pv, full) {
		t.Errorf("scanning main.sqlite = %v", err)
	}

	// Uploads: main.sqlite + -wal, as the browser sends them...
	mainBytes, walBytes := mustRead(t, filepath.Join(pkg, "main.sqlite")), mustRead(t, filepath.Join(pkg, "main.sqlite-wal"))
	if pv, err := Scan(Source{Files: []File{{Name: "main.sqlite-wal", Data: walBytes}, {Name: "main.sqlite", Data: mainBytes}}}, Options{}); err != nil || !reflect.DeepEqual(pv, full) {
		t.Errorf("uploaded files = %v", err)
	}
	// ...and without the log, the half of the library still only in it is missing.
	if pv, err := Scan(Source{Files: []File{{Name: "main.sqlite", Data: mainBytes}}}, Options{}); err != nil || reflect.DeepEqual(pv, full) {
		t.Errorf("without the WAL the scan should differ (err %v)", err)
	}

	// A zip of the package, as Safari uploads it, with Finder's __MACOSX entries and a backup.
	zipped := zipOf(t, map[string][]byte{
		"Things Database.thingsdatabase/main.sqlite":            mainBytes,
		"Things Database.thingsdatabase/main.sqlite-wal":        walBytes,
		"__MACOSX/Things Database.thingsdatabase/._main.sqlite": []byte("junk"),
		"Backups/2026-09-01.thingsdatabase/main.sqlite":         []byte("not this one"),
	})
	if pv, err := Scan(Source{Files: []File{{Name: "Things Database.thingsdatabase.zip", Data: zipped}}}, Options{}); err != nil || !reflect.DeepEqual(pv, full) {
		t.Errorf("uploaded zip = %v", err)
	}
	zipPath := filepath.Join(dir, "export.zip")
	os.WriteFile(zipPath, zipped, 0o644)
	if pv, err := Scan(Source{Path: zipPath}, Options{}); err != nil || !reflect.DeepEqual(pv, full) {
		t.Errorf("zip by path = %v", err)
	}

	// What can't be read says why.
	if _, err := Scan(Source{Files: []File{{Name: "Things Database.aar", Data: []byte("AA01")}}}, Options{}); !errors.Is(err, ErrAppleArchive) {
		t.Errorf("an .aar = %v", err)
	}
	if _, err := Scan(Source{Files: []File{{Name: "notes.txt", Data: []byte("hi")}}}, Options{}); !errors.Is(err, ErrNoDatabase) {
		t.Errorf("no database = %v", err)
	}
	if _, err := Scan(Source{Path: t.TempDir()}, Options{}); !errors.Is(err, ErrNoDatabase) {
		t.Errorf("an empty folder = %v", err)
	}
	other := filepath.Join(t.TempDir(), "other.sqlite")
	db, _ := sql.Open("sqlite", other)
	db.Exec(`CREATE TABLE notes (body TEXT)`)
	db.Close()
	if _, err := Scan(Source{Path: other}, Options{}); !errors.Is(err, ErrNotThings) {
		t.Errorf("a non-Things database = %v", err)
	}
}

func TestOldDatabaseRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "main.sqlite")
	db, _ := sql.Open("sqlite", path)
	db.Exec(thingsDDL)
	db.Exec(`INSERT INTO Meta VALUES ('databaseVersion', ?)`, plistHead+"<integer>21</integer></plist>")
	db.Close()
	if _, err := Scan(Source{Path: path}, Options{}); !errors.Is(err, ErrOldDatabase) {
		t.Errorf("a pre-2023 database = %v", err)
	}
}

func TestPackedDates(t *testing.T) {
	if y, m, d, ok := unpackDate(pd(2026, 9, 19)); !ok || y != 2026 || m != time.September || d != 19 {
		t.Errorf("unpackDate = %d %v %d %v", y, m, d, ok)
	}
	if y, m, d, ok := unpackDate(132464128); !ok || y != 2021 || m != time.March || d != 28 {
		t.Errorf("things.py's example decodes to %d-%d-%d", y, m, d) // 2021-03-28
	}
	for _, v := range []int64{0, -1, pd(4001, 1, 1), pd(2026, 13, 1)} {
		if _, _, _, ok := unpackDate(v); ok {
			t.Errorf("unpackDate(%d) should be unset", v)
		}
	}
	if h, m, ok := unpackTime(840957952); !ok || h != 12 || m != 34 {
		t.Errorf("things.py's 12:34 decodes to %d:%d", h, m)
	}
	if !isSentinelDate(262213760) {
		t.Error("4001-01-01 is the template sentinel")
	}
}

func TestConvertRule(t *testing.T) {
	loc, _ := time.LoadLocation(zone)
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name, body, want string
		created          int64
	}{
		{"weekdays", `<key>fu</key><integer>256</integer><key>fa</key><integer>1</integer><key>of</key><array><dict><key>wd</key><integer>5</integer></dict><dict><key>wd</key><integer>1</integer></dict><dict><key>wd</key><integer>3</integer></dict></array>`, "FREQ=WEEKLY;BYDAY=MO,WE,FR", 0},
		{"every other week", `<key>fu</key><integer>256</integer><key>fa</key><integer>2</integer><key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>`, "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU", 0},
		{"last tuesday", `<key>fu</key><integer>8</integer><key>of</key><array><dict><key>wd</key><integer>2</integer><key>wdo</key><integer>-1</integer></dict></array>`, "FREQ=MONTHLY;BYDAY=-1TU", 0},
		{"last day", `<key>fu</key><integer>8</integer><key>of</key><array><dict><key>dy</key><integer>-1</integer></dict></array>`, "FREQ=MONTHLY;BYMONTHDAY=-1", 0},
		{"1st and 15th", `<key>fu</key><integer>8</integer><key>of</key><array><dict><key>dy</key><integer>0</integer></dict><dict><key>dy</key><integer>14</integer></dict></array>`, "FREQ=MONTHLY;BYMONTHDAY=1,15", 0},
		{"christmas", `<key>fu</key><integer>4</integer><key>of</key><array><dict><key>mo</key><integer>11</integer><key>dy</key><integer>24</integer></dict></array>`, "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25", 0},
		{"count left", `<key>fu</key><integer>16</integer><key>rc</key><integer>10</integer>`, "FREQ=DAILY;COUNT=7", 3},
		{"until", `<key>fu</key><integer>16</integer><key>ed</key><real>1798761600</real>`, "FREQ=DAILY;UNTIL=20270102T035959Z", 0}, // Jan 1, 2027, end of day in Halifax
	}
	for _, c := range cases {
		r, reason, ok := convertRule(rule(c.body), c.created, loc, now)
		if !ok || r.rule != c.want {
			t.Errorf("%s: %q (%s), want %q", c.name, r.rule, reason, c.want)
		}
	}
	for name, body := range map[string]string{
		"unknown unit":   `<key>fu</key><integer>2</integer>`,
		"ended by count": `<key>fu</key><integer>16</integer><key>rc</key><integer>2</integer>`,
		"ended by date":  `<key>fu</key><integer>16</integer><key>ed</key><real>1700000000</real>`,
	} {
		if _, _, ok := convertRule(rule(body), 2, loc, now); ok {
			t.Errorf("%s should not convert", name)
		}
	}
	if _, _, ok := convertRule([]byte("bplist00..."), 0, loc, now); ok {
		t.Error("a binary plist should not convert")
	}
	if r, _, _ := convertRule(every3DaysAfter, 0, loc, now); !r.afterCompletion {
		t.Error("tp=1 is after completion")
	}
}

func TestShiftRule(t *testing.T) {
	cases := []struct {
		rule string
		days int
		want string // "" when it can't be moved
	}{
		{"FREQ=DAILY;INTERVAL=3", -2, "FREQ=DAILY;INTERVAL=3"},
		{"FREQ=WEEKLY;BYDAY=MO,FR", -2, "FREQ=WEEKLY;BYDAY=WE,SA"},
		{"FREQ=WEEKLY;BYDAY=SU", 1, "FREQ=WEEKLY;BYDAY=MO"},
		{"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", -3, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"},
		{"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR", -3, ""}, // Friday and Tuesday: different weeks
		{"FREQ=MONTHLY;BYMONTHDAY=1,15", -3, "FREQ=MONTHLY;BYMONTHDAY=-3,12"},
		{"FREQ=MONTHLY;BYMONTHDAY=-1", -1, "FREQ=MONTHLY;BYMONTHDAY=-2"},
		{"FREQ=MONTHLY;BYMONTHDAY=-1", 1, "FREQ=MONTHLY;BYMONTHDAY=1"},
		{"FREQ=MONTHLY;BYMONTHDAY=28", 1, ""}, // the 29th isn't in every month
		{"FREQ=MONTHLY;BYDAY=1MO", -1, ""},
		{"FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25", -5, "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=20"},
		{"FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1", -1, ""}, // into December
	}
	for _, c := range cases {
		got, ok := shiftRule(strings.Split(c.rule, ";"), c.days)
		if joined := strings.Join(got, ";"); ok != (c.want != "") || joined != c.want {
			t.Errorf("%s by %d = %q (%v), want %q", c.rule, c.days, joined, ok, c.want)
		}
	}
}

func TestProjectRepeat(t *testing.T) {
	halifaxLoc, _ := time.LoadLocation(zone)
	berlin, _ := time.LoadLocation("Europe/Berlin")
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	convert := func(body string, created int64, loc *time.Location) repeat {
		t.Helper()
		r, reason, ok := convertRule(rule(body), created, loc, now)
		if !ok {
			t.Fatal(reason)
		}
		return r
	}
	const fridays = `<key>fu</key><integer>256</integer><key>of</key><array><dict><key>wd</key><integer>5</integer></dict></array>`

	// A copy that starts two days before each Friday repeats on Wednesdays, where its start is —
	// and its last day moves with it.
	start := time.Date(2026, 9, 23, 0, 0, 0, 0, halifaxLoc) // a Wednesday
	r := convert(fridays+`<key>ts</key><integer>-2</integer><key>ed</key><real>1798761600</real>`, 0, halifaxLoc)
	pr, reason, ok := projectRepeatFor(r, start, true, true, halifaxLoc)
	if !ok || pr.rule == nil || *pr.rule != "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T035959Z" {
		t.Errorf("start-anchored = %v (%s)", pr.rule, reason)
	}
	// Hung off its deadline instead, the rule names the Fridays themselves.
	due := time.Date(2026, 9, 25, dueHour, 0, 0, 0, halifaxLoc)
	if pr, _, ok = projectRepeatFor(r, due, false, true, halifaxLoc); !ok || *pr.rule != "FREQ=WEEKLY;BYDAY=FR;UNTIL=20270102T035959Z" {
		t.Errorf("deadline-anchored = %v", pr.rule)
	}
	// East of UTC, local midnight is the evening before in UTC, where the server reads the rule.
	r = convert(fridays, 0, berlin)
	friday := time.Date(2026, 9, 25, 0, 0, 0, 0, berlin)
	if pr, _, ok = projectRepeatFor(r, friday, true, true, berlin); !ok || *pr.rule != "FREQ=WEEKLY;BYDAY=TH" {
		t.Errorf("Berlin = %v", pr.rule)
	}
	if next, err := domain.NextOccurrence(*pr.rule, friday, friday); err != nil || next == nil || !next.Equal(time.Date(2026, 10, 2, 0, 0, 0, 0, berlin)) {
		t.Errorf("the next Berlin copy = %v (%v), want Friday Oct 2 at midnight there", next, err)
	}
	// What can't be moved isn't repeated, with the reason.
	r = convert(`<key>fu</key><integer>8</integer><key>of</key><array><dict><key>wd</key><integer>1</integer><key>wdo</key><integer>1</integer></dict></array><key>ts</key><integer>-3</integer>`, 0, halifaxLoc)
	if _, reason, ok = projectRepeatFor(r, start, true, true, halifaxLoc); ok || !strings.Contains(reason, "3 days before") {
		t.Errorf("first Monday less 3 days: ok %v, %q", ok, reason)
	}

	// "Ends after N": a copy Things made has been counted already; the template standing in
	// for the next one is itself one of those left. The last of them carries no repeat.
	const daily4 = `<key>fu</key><integer>16</integer><key>rc</key><integer>4</integer>`
	r = convert(daily4, 2, halifaxLoc)
	if pr, _, ok = projectRepeatFor(r, start, true, true, halifaxLoc); !ok || *pr.rule != "FREQ=DAILY;UNTIL=20260926T025959Z" {
		t.Errorf("two more after a made copy = %v", pr.rule)
	}
	if pr, _, ok = projectRepeatFor(r, start, true, false, halifaxLoc); !ok || *pr.rule != "FREQ=DAILY;UNTIL=20260925T025959Z" {
		t.Errorf("one more after the upcoming copy = %v", pr.rule)
	}
	r = convert(daily4, 3, halifaxLoc)
	if pr, _, ok = projectRepeatFor(r, start, true, false, halifaxLoc); !ok || pr.rule != nil || pr.after != nil {
		t.Errorf("the last copy = %+v, want no repeat", pr)
	}

	// After completion is an interval, which has no end in Companion.
	r = convert(`<key>fu</key><integer>8</integer><key>fa</key><integer>3</integer><key>tp</key><integer>1</integer><key>rc</key><integer>9</integer>`, 0, halifaxLoc)
	if pr, _, ok = projectRepeatFor(r, start, true, true, halifaxLoc); !ok || pr.after == nil || *pr.after != "P3M" || !pr.endless {
		t.Errorf("after completion = %+v", pr)
	}
}

// --- helpers ---------------------------------------------------------------

func containsText(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func sameTime(t *testing.T, what string, got *time.Time, want time.Time) {
	t.Helper()
	if got == nil || !got.Equal(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func areaNames(areas []*domain.Area) []string {
	sort.SliceStable(areas, func(i, j int) bool { return areas[i].SortOrder < areas[j].SortOrder })
	var out []string
	for _, a := range areas {
		out = append(out, a.Name)
	}
	return out
}

func areaName(areas []*domain.Area, id string) string {
	for _, a := range areas {
		if a.ID == id {
			return a.Name
		}
	}
	return ""
}

// areaTasks returns the titles of the tasks filed directly in the named area, sorted.
func areaTasks(t *testing.T, st *store.Store, areas []*domain.Area, name string) []string {
	t.Helper()
	var areaID string
	for _, a := range areas {
		if a.Name == name {
			areaID = a.ID
		}
	}
	members, err := st.ProjectMembers.ListForArea(areaID)
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, m := range members {
		if m.EntityType != domain.NodeTask || !m.InArea() {
			t.Errorf("area member %+v, want a task filed in the area", m)
			continue
		}
		task, err := st.Tasks.GetAny(m.EntityID)
		if err != nil {
			t.Fatal(err)
		}
		titles = append(titles, task.Title)
	}
	sort.Strings(titles)
	return titles
}

func projectsByName(t *testing.T, st *store.Store) map[string]*domain.Project {
	t.Helper()
	list, err := st.Projects.List()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*domain.Project{}
	for _, p := range list {
		out[p.Name] = p
	}
	return out
}

func tasksByTitle(t *testing.T, st *store.Store) map[string]*domain.Task {
	t.Helper()
	list, err := st.Tasks.List()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*domain.Task{}
	for _, task := range list {
		out[task.Title] = task
	}
	return out
}

func seedsByTitle(t *testing.T, st *store.Store) map[string]*domain.Task {
	t.Helper()
	list, err := st.Tasks.ListSeeds()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*domain.Task{}
	for _, task := range list {
		out[task.Title] = task
	}
	return out
}

// listRows renders a project's only list as its rows: task titles, and "# heading".
func listRows(t *testing.T, st *store.Store, projectID string) []string {
	t.Helper()
	lists, err := st.Lists.ListForProject(projectID)
	if err != nil || len(lists) != 1 || lists[0].Name != listName {
		t.Fatalf("project lists = %+v, %v", lists, err)
	}
	items, err := st.ListItems.ListForList(lists[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, it := range items {
		if it.Kind == domain.ListItemHeading {
			out = append(out, "# "+it.Title)
			continue
		}
		task, err := st.Tasks.Get(*it.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, task.Title)
	}
	return out
}

func projectNote(t *testing.T, st *store.Store, projectID string) *domain.Note {
	t.Helper()
	members, err := st.ProjectMembers.ListForProject(projectID)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range members {
		if m.EntityType == domain.NodeNote {
			n, err := st.Notes.Get(m.EntityID)
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
	}
	t.Fatal("no note in the project")
	return nil
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	names := keys(files)
	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(files[name])
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
