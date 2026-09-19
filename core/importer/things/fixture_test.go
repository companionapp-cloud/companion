//go:build !js

package things

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// A synthetic Things database built with real SQLite from Things' own DDL — copied verbatim from
// a Things 3.24 library (DB v29), comments and ALTER-appended columns included, since those are
// what a hand-written schema gets wrong — covering every row of the mapping table (PLAN §6.12).
// Part of it stays in the write-ahead log, as a running Things leaves it.

const thingsDDL = `
CREATE TABLE TMTask (

        "uuid"                              TEXT PRIMARY KEY,
        "leavesTombstone"                   INTEGER,

        "creationDate"                      REAL,
        "userModificationDate"              REAL,

        "type"                              INTEGER,

        "status"                            INTEGER,
        "stopDate"                          REAL,

        "trashed"                           INTEGER,

        "title"                             TEXT,
        "notes"                             TEXT,
        "notesSync"                         INTEGER,

        "cachedTags"                        BLOB,

        "start"                             INTEGER,
        "startDate"                         INTEGER,   -- REAL -> INTEGER
        "startBucket"                       INTEGER,
        "reminderTime"                      INTEGER,
        "lastReminderInteractionDate"       REAL,      -- Renamed from "lastAlarmInteractionDate"

        "deadline"                          INTEGER,   -- Renamed from "dueDate", REAL -> INTEGER
        "deadlineSuppressionDate"           INTEGER,   -- Renamed from "dueDateSuppressionDate", REAL -> INTEGER
        "t2_deadlineOffset"                 INTEGER,   -- Renamed from "dueDateOffset"

        "index"                             INTEGER,
        "todayIndex"                        INTEGER,
        "todayIndexReferenceDate"           INTEGER,   -- REAL -> INTEGER

        "area"                              TEXT,
        "project"                           TEXT,
        "heading"                           TEXT,      -- Renamed from "actionGroup"
        "contact"                           TEXT,      -- Renamed from "delegate"

        "untrashedLeafActionsCount"         INTEGER,
        "openUntrashedLeafActionsCount"     INTEGER,

        "checklistItemsCount"               INTEGER,
        "openChecklistItemsCount"           INTEGER,

        "rt1_repeatingTemplate"             TEXT,      -- Renamed from "repeatingTemplate"
        "rt1_recurrenceRule"                BLOB,      -- Renamed from "recurrenceRule"
        "rt1_instanceCreationStartDate"     INTEGER,   -- Renamed from "instanceCreationStartDate", REAL -> INTEGER
        "rt1_instanceCreationPaused"        INTEGER,   -- Renamed from "instanceCreationPaused"
        "rt1_instanceCreationCount"         INTEGER,   -- Renamed from "instanceCreationCount"
        "rt1_afterCompletionReferenceDate"  INTEGER,   -- Renamed from "afterCompletionReferenceDate", REAL -> INTEGER
        "rt1_nextInstanceStartDate"         INTEGER,   -- Renamed from "nextInstanceStartDate", REAL -> INTEGER

        "experimental"                      BLOB,

        "repeater"                          BLOB,
        "repeaterMigrationDate"             REAL
    );
CREATE TABLE 'TMArea' (
    'uuid'                 TEXT PRIMARY KEY,
    'title'                TEXT,
    'visible'              INTEGER,
    'index'                INTEGER
, 'cachedTags' BLOB, experimental BLOB);
CREATE TABLE 'TMChecklistItem' (
    'uuid'                 TEXT PRIMARY KEY,
    'userModificationDate' REAL,
    'creationDate'         REAL,
    'title'                TEXT,
    'status'               INTEGER,
    'stopDate'             REAL,
    'index'                INTEGER,
    'task'                 TEXT
, 'leavesTombstone' INTEGER, experimental BLOB);
CREATE TABLE 'TMTag' (
    'uuid'                 TEXT PRIMARY KEY,
    'title'                TEXT,
    'shortcut'             TEXT,
    'usedDate'             REAL,
    'parent'               TEXT,
    'index'                INTEGER
, experimental BLOB);
CREATE TABLE 'TMTaskTag' (
    'tasks'                TEXT NOT NULL,
    'tags'                 TEXT NOT NULL
);
CREATE TABLE 'TMAreaTag' (
    'areas'                TEXT NOT NULL,
    'tags'                 TEXT NOT NULL
);
CREATE TABLE 'Meta' (
    'key'                 TEXT PRIMARY KEY,
    'value'               TEXT
);
CREATE INDEX index_TMTask_project ON TMTask(project);
CREATE INDEX index_TMTask_area ON TMTask(area);
CREATE INDEX index_TMTaskTag_tasks ON TMTaskTag(tasks);
`

func pd(y, m, d int) int64 { return int64(y)<<16 | int64(m)<<12 | int64(d)<<7 }
func pt(h, m int) int64    { return int64(h)<<26 | int64(m)<<20 }

const plistHead = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">`

func rule(body string) []byte { return []byte(plistHead + "<dict>" + body + "</dict></plist>") }

// Rules used by the fixture.
var (
	weeklyFriday = rule(`<key>ed</key><real>64092211200</real><key>fa</key><integer>1</integer><key>fu</key><integer>256</integer><key>of</key><array><dict><key>wd</key><integer>5</integer></dict></array><key>rc</key><integer>0</integer><key>rrv</key><integer>4</integer><key>tp</key><integer>0</integer><key>ts</key><integer>-2</integer>`)
	every3DaysAfter = rule(`<key>ed</key><real>64092211200</real><key>fa</key><integer>3</integer><key>fu</key><integer>16</integer><key>rc</key><integer>0</integer><key>rrv</key><integer>4</integer><key>tp</key><integer>1</integer><key>ts</key><integer>0</integer>`)
	monthlyFirst    = rule(`<key>fa</key><integer>1</integer><key>fu</key><integer>8</integer><key>of</key><array><dict><key>dy</key><integer>0</integer></dict></array><key>rc</key><integer>5</integer><key>tp</key><integer>0</integer><key>ts</key><integer>0</integer>`)
)

type taskRow struct {
	uuid, title, notes              string
	kind, status, start             int
	trashed                         bool
	startDate, deadline             int64
	evening                         bool
	reminder                        int64 // -1 none
	stopDate                        float64
	index                           int64
	area, project, heading          string
	rule                            []byte
	template                        string
	nextStart, instanceCount        int64
	paused                          bool
}

// Fixture ids, so tests can select and look things up.
const (
	areaHome   = "AreaHome"
	areaWork   = "AreaWork"
	projLaunch = "ProjLaunch"
	projGarden = "ProjGarden" // completed
	projSide   = "ProjSide"   // no area
	projTrash  = "ProjTrash"  // trashed
	projClose  = "ProjClose"  // a repeating project template
	headMkt    = "HeadMarketing"
	headOld    = "HeadOld" // archived, only finished to-dos
)

var fixtureTasks = []taskRow{
	// Work › Launch: notes, a deadline and tags (kept as a project note), two headings.
	{uuid: projLaunch, kind: kindProject, title: "Launch", notes: "Ship the thing.", area: areaWork, deadline: pd(2026, 10, 30), index: 1, reminder: -1},
	{uuid: headMkt, kind: kindHeading, title: "Marketing", project: projLaunch, index: 10, reminder: -1},
	{uuid: headOld, kind: kindHeading, title: "Old", project: projLaunch, index: 11, status: statusCompleted, reminder: -1},
	{uuid: "TodoKickoff", kind: kindTodo, title: "Kickoff", project: projLaunch, start: startAnytime, index: 5, reminder: -1},
	{uuid: "TodoBudget", kind: kindTodo, title: "Budget", project: projLaunch, start: startAnytime, index: 2, reminder: -1,
		notes: "See [the plan](things:///show?id=ProjLaunch) and things:///show?id=TodoKickoff&x=1, not things:///show?id=Nowhere."},
	{uuid: "TodoPost", kind: kindTodo, title: "Write post", heading: headMkt, start: startSomeday, startDate: pd(2026, 10, 5), evening: true, reminder: pt(19, 30), deadline: pd(2026, 10, 7), index: 1},
	{uuid: "TodoLegacy", kind: kindTodo, title: "Legacy", heading: headOld, status: statusCompleted, stopDate: 1757000000, index: 1, reminder: -1},
	{uuid: "TodoShip", kind: kindTodo, title: "Ship v1", project: projLaunch, status: statusCompleted, stopDate: 1758000000.5, index: 3, reminder: -1},
	{uuid: "TodoDropped", kind: kindTodo, title: "Dropped idea", project: projLaunch, status: statusCanceled, stopDate: 1758000100, index: 4, reminder: -1},
	// A repeating to-do in Launch: the template (weekly on Friday, starting 2 days early, with
	// deadlines) and the instance Things already made.
	{uuid: "TplReview", kind: kindTodo, title: "Weekly review", project: projLaunch, start: startSomeday, deadline: pd(4001, 1, 1), reminder: pt(9, 0), rule: weeklyFriday, nextStart: pd(2026, 9, 23), index: 20},
	{uuid: "TodoReviewNow", kind: kindTodo, title: "Weekly review", project: projLaunch, start: startAnytime, startDate: pd(2026, 9, 16), deadline: pd(2026, 9, 18), template: "TplReview", index: 3, reminder: -1},

	// Home › Garden (finished), and Home's own to-dos.
	{uuid: projGarden, kind: kindProject, title: "Garden", area: areaHome, status: statusCompleted, stopDate: 1750000000, index: 1, reminder: -1},
	{uuid: "TodoPrune", kind: kindTodo, title: "Prune roses", project: projGarden, status: statusCompleted, stopDate: 1750000000, index: 1, reminder: -1},
	{uuid: "TodoCallMom", kind: kindTodo, title: "Call mom", area: areaHome, start: startSomeday, index: 1, reminder: -1,
		notes: "<note xml:space=\"preserve\">Ask about &lt;the&gt; trip</note>"},
	{uuid: "TodoDonePaint", kind: kindTodo, title: "Paint fence", area: areaHome, status: statusCompleted, stopDate: 1751000000, index: 2, reminder: -1},

	// A project with no area; a trashed project with a to-do; a repeating project template
	// with its content.
	{uuid: projSide, kind: kindProject, title: "Side quest", index: 5, reminder: -1},
	{uuid: "TodoSide", kind: kindTodo, title: "Find the map", project: projSide, start: startAnytime, index: 1, reminder: -1},
	{uuid: projTrash, kind: kindProject, title: "Abandoned", trashed: true, index: 6, reminder: -1},
	{uuid: "TodoInTrash", kind: kindTodo, title: "In a trashed project", project: projTrash, index: 1, reminder: -1},
	{uuid: projClose, kind: kindProject, title: "Monthly close", rule: monthlyFirst, index: 7, reminder: -1},
	{uuid: "TodoCloseStep", kind: kindTodo, title: "Reconcile", project: projClose, index: 1, reminder: -1},

	// References to things that no longer exist don't lose the to-do: it files by what it has.
	{uuid: "TodoLostHeading", kind: kindTodo, title: "Lost heading", heading: "HeadGone", start: startAnytime, index: 7, reminder: -1},
	{uuid: "TodoLostProject", kind: kindTodo, title: "Lost project", project: "ProjGone", area: areaHome, start: startAnytime, index: 3, reminder: -1},

	// The Inbox and a to-do in no area; a trashed to-do.
	{uuid: "TodoMilk", kind: kindTodo, title: "Buy milk", start: startInbox, index: 1, reminder: -1},
	{uuid: "TodoRead", kind: kindTodo, title: "Read book", start: startAnytime, startDate: pd(2026, 9, 1), index: 2, reminder: -1},
	{uuid: "TodoGone", kind: kindTodo, title: "Gone", start: startInbox, trashed: true, index: 3, reminder: -1},
	// Repeating to-dos in no area: after completion (approximated), paused, and ended.
	{uuid: "TplWater", kind: kindTodo, title: "Water plants", start: startSomeday, rule: every3DaysAfter, nextStart: pd(2026, 9, 20), index: 4, reminder: -1},
	{uuid: "TplPaused", kind: kindTodo, title: "Stretch", start: startSomeday, rule: weeklyFriday, nextStart: pd(2026, 9, 23), paused: true, index: 5, reminder: -1},
	{uuid: "TplEnded", kind: kindTodo, title: "Pay installment", start: startSomeday, rule: monthlyFirst, instanceCount: 5, nextStart: pd(2026, 10, 1), index: 6, reminder: -1},
}

// writeFixture creates the database under dir/Things Database.thingsdatabase and returns the
// path of its main.sqlite. The last part of the data is committed to the WAL only.
func writeFixture(t *testing.T, dir string) string {
	t.Helper()
	pkg := filepath.Join(dir, "Things Database.thingsdatabase")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(pkg, "main.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	run := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	run("PRAGMA journal_mode=WAL")
	run("PRAGMA wal_autocheckpoint=0")
	run(thingsDDL)
	run(`INSERT INTO Meta VALUES ('databaseVersion', ?)`, plistHead+"<integer>26</integer></plist>")
	run(`INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, 'Work', 1, 2), (?, 'Home', 1, 1)`, areaWork, areaHome)
	insert := func(r taskRow) {
		var startDate, deadline, reminder, nextStart any
		if r.startDate != 0 {
			startDate = r.startDate
		}
		if r.deadline != 0 {
			deadline = r.deadline
		}
		if r.reminder >= 0 {
			reminder = r.reminder
		}
		if r.nextStart != 0 {
			nextStart = r.nextStart
		}
		nullable := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		bucket := 0
		if r.evening {
			bucket = 1
		}
		var rule any
		if r.rule != nil {
			rule = r.rule
		}
		run(`INSERT INTO TMTask (uuid, type, status, trashed, title, notes, start, startDate, startBucket, reminderTime,
			deadline, stopDate, "index", area, project, heading, rt1_recurrenceRule, rt1_repeatingTemplate,
			rt1_nextInstanceStartDate, rt1_instanceCreationCount, rt1_instanceCreationPaused, creationDate)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1700000000)`,
			r.uuid, r.kind, r.status, boolInt(r.trashed), r.title, r.notes, r.start, startDate, bucket, reminder,
			deadline, r.stopDate, r.index, nullable(r.area), nullable(r.project), nullable(r.heading), rule,
			nullable(r.template), nextStart, r.instanceCount, boolInt(r.paused))
	}
	half := len(fixtureTasks) / 2
	for _, r := range fixtureTasks[:half] {
		insert(r)
	}
	run("PRAGMA wal_checkpoint(TRUNCATE)") // the first half is in main.sqlite...
	for _, r := range fixtureTasks[half:] {
		insert(r) // ...the rest only in main.sqlite-wal
	}
	run(`INSERT INTO TMChecklistItem (uuid, title, status, "index", task) VALUES
		('C1', 'Get quotes', 3, 1, 'TodoBudget'), ('C2', 'Cut costs', 2, 2, 'TodoBudget'), ('C3', 'Sign off', 0, 3, 'TodoBudget')`)
	run(`INSERT INTO TMTag (uuid, title, "index") VALUES ('TagErrand', 'Errand', 2), ('TagWait', 'Waiting For', 1), ('TagHome', 'Home stuff', 3)`)
	run(`INSERT INTO TMTaskTag VALUES ('TodoBudget', 'TagErrand'), ('TodoBudget', 'TagWait'), (?, 'TagErrand')`, projLaunch)
	run(`INSERT INTO TMAreaTag VALUES (?, 'TagHome')`, areaHome)
	if fi, err := os.Stat(path + "-wal"); err != nil || fi.Size() == 0 {
		t.Fatalf("the fixture should leave data in the WAL: %v", err)
	}
	return path
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// snapshot copies the live database files into a new package folder, as a user copying the
// package (with Things running) would.
func snapshot(t *testing.T, mainPath string) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "copy", "Things Database.thingsdatabase")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"main.sqlite", "main.sqlite-wal"} {
		b, err := os.ReadFile(filepath.Join(filepath.Dir(mainPath), name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(fmt.Errorf("read %s: %w", p, err))
	}
	return b
}
