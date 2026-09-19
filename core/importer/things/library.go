package things

import (
	"errors"
	"regexp"
	"sort"
	"strconv"

	"companion/core/importer/sqlitefile"
)

// The Things schema (PLAN §6.12; things.py and the things-api atlas are the references):
// to-dos, projects and headings share TMTask; areas, checklist items and tags have their own
// tables. Columns are read by name, so additive schema changes don't break the import.

// Item kinds (TMTask.type).
const (
	kindTodo    = 0
	kindProject = 1
	kindHeading = 2
)

// Item statuses (TMTask.status, TMChecklistItem.status).
const (
	statusOpen      = 0
	statusCanceled  = 2
	statusCompleted = 3
)

// Where an item lives in Things' lists (TMTask.start).
const (
	startInbox   = 0
	startAnytime = 1
	startSomeday = 2 // also scheduled (Upcoming), when it has a start date
)

// minVersion is the first database layout this reads: April 2023 (Things 3.15.16+) packed
// dates into integers and renamed columns; things.py draws the same line.
const minVersion = 22

// ErrNotThings means the file is SQLite but not a Things database.
var ErrNotThings = errors.New("that database isn’t from Things 3")

// ErrOldDatabase means the database predates the layout this reads.
var ErrOldDatabase = errors.New("this Things database is from before April 2023 — update Things, then export it again")

type library struct {
	version   int
	areas     []*area // in Things' order
	areaByID  map[string]*area
	items     map[string]*item // to-dos, projects and headings by uuid
	ordered   []*item          // every item, in index order (ties by rowid)
	checklist map[string][]*checkItem
	taskTags  map[string][]string // item uuid → tag titles, in Things' tag order
	areaTags  map[string][]string
	tagCount  int
}

type area struct {
	id, title string
	index     int64
}

type item struct {
	id                  string
	kind, status, start int
	trashed, evening    bool
	title, notes        string
	startDate, deadline int64 // packed dates, 0 when unset
	reminderTime        int64 // packed time, -1 when unset
	stopDate            float64
	index               int64
	rowid               int64
	area, project       string
	heading             string
	// Repeats: a template carries the rule; its instances point back at it.
	rule          []byte
	template      string
	nextStart     int64 // packed date of the template's next instance
	instanceCount int64
	paused        bool
}

type checkItem struct {
	title  string
	status int
	index  int64
}

// readLibrary reads a Things database into memory. Libraries are small (tens of thousands of
// rows at most), so everything is loaded and joined in Go.
func readLibrary(db *sqlitefile.DB) (*library, error) {
	tasks, areas := db.Table("TMTask"), db.Table("TMArea")
	if tasks == nil || areas == nil || !tasks.HasColumn("uuid") || !tasks.HasColumn("type") {
		return nil, ErrNotThings
	}
	lib := &library{
		version:   metaVersion(db),
		areaByID:  map[string]*area{},
		items:     map[string]*item{},
		checklist: map[string][]*checkItem{},
		taskTags:  map[string][]string{},
		areaTags:  map[string][]string{},
	}
	if lib.version > 0 && lib.version < minVersion {
		return nil, ErrOldDatabase
	}
	col := func(names ...string) string {
		for _, n := range names {
			if tasks.HasColumn(n) {
				return n
			}
		}
		return ""
	}
	headingCol := col("heading", "actionGroup")
	deadlineCol := col("deadline", "dueDate")
	ruleCol := col("rt1_recurrenceRule", "recurrenceRule")
	templateCol := col("rt1_repeatingTemplate", "repeatingTemplate")
	nextCol := col("rt1_nextInstanceStartDate", "nextInstanceStartDate")
	countCol := col("rt1_instanceCreationCount", "instanceCreationCount")
	pausedCol := col("rt1_instanceCreationPaused", "instanceCreationPaused")

	if err := db.Scan("TMArea", func(r sqlitefile.Row) error {
		a := &area{id: r.String("uuid"), title: r.String("title"), index: r.Int("index")}
		lib.areas = append(lib.areas, a)
		lib.areaByID[a.id] = a
		return nil
	}); err != nil {
		return nil, err
	}
	sort.SliceStable(lib.areas, func(i, j int) bool { return lib.areas[i].index < lib.areas[j].index })

	if err := db.Scan("TMTask", func(r sqlitefile.Row) error {
		it := &item{
			id:           r.String("uuid"),
			kind:         int(r.Int("type")),
			status:       int(r.Int("status")),
			start:        int(r.Int("start")),
			trashed:      r.Int("trashed") != 0,
			evening:      r.Int("startBucket") == 1,
			title:        r.String("title"),
			notes:        r.String("notes"),
			startDate:    packedDate(r, "startDate"),
			deadline:     packedDate(r, deadlineCol),
			reminderTime: -1,
			stopDate:     r.Float("stopDate"),
			index:        r.Int("index"),
			rowid:        r.RowID,
			area:         r.String("area"),
			project:      r.String("project"),
			heading:      r.String(headingCol),
			rule:         r.Bytes(ruleCol),
			template:     r.String(templateCol),
			nextStart:    packedDate(r, nextCol),
			instanceCount: r.Int(countCol),
			paused:       r.Int(pausedCol) != 0,
		}
		if !r.Null("reminderTime") {
			it.reminderTime = r.Int("reminderTime")
		}
		lib.items[it.id] = it
		lib.ordered = append(lib.ordered, it)
		return nil
	}); err != nil {
		return nil, err
	}
	sort.SliceStable(lib.ordered, func(i, j int) bool {
		a, b := lib.ordered[i], lib.ordered[j]
		if a.index != b.index {
			return a.index < b.index
		}
		return a.rowid < b.rowid
	})

	if db.Table("TMChecklistItem") != nil {
		if err := db.Scan("TMChecklistItem", func(r sqlitefile.Row) error {
			task := r.String("task")
			lib.checklist[task] = append(lib.checklist[task], &checkItem{title: r.String("title"), status: int(r.Int("status")), index: r.Int("index")})
			return nil
		}); err != nil {
			return nil, err
		}
		for _, items := range lib.checklist {
			sort.SliceStable(items, func(i, j int) bool { return items[i].index < items[j].index })
		}
	}

	if err := readTags(db, lib); err != nil {
		return nil, err
	}
	return lib, nil
}

// readTags joins tag assignments to tag titles, in Things' tag order.
func readTags(db *sqlitefile.DB, lib *library) error {
	if db.Table("TMTag") == nil {
		return nil
	}
	type tag struct {
		title string
		index int64
	}
	tags := map[string]tag{}
	if err := db.Scan("TMTag", func(r sqlitefile.Row) error {
		tags[r.String("uuid")] = tag{title: r.String("title"), index: r.Int("index")}
		return nil
	}); err != nil {
		return err
	}
	used := map[string]bool{}
	join := func(table, owner string, into map[string][]string) error {
		if db.Table(table) == nil {
			return nil
		}
		type pair struct {
			owner string
			tag   tag
		}
		var pairs []pair
		if err := db.Scan(table, func(r sqlitefile.Row) error {
			if t, ok := tags[r.String("tags")]; ok && t.title != "" {
				pairs = append(pairs, pair{owner: r.String(owner), tag: t})
				used[t.title] = true
			}
			return nil
		}); err != nil {
			return err
		}
		sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].tag.index < pairs[j].tag.index })
		for _, p := range pairs {
			into[p.owner] = append(into[p.owner], p.tag.title)
		}
		return nil
	}
	if err := join("TMTaskTag", "tasks", lib.taskTags); err != nil {
		return err
	}
	if err := join("TMAreaTag", "areas", lib.areaTags); err != nil {
		return err
	}
	lib.tagCount = len(used)
	return nil
}

// packedDate reads a date column: the packed integer current databases use. Anything else
// (NULL, or a pre-2023 REAL timestamp) reads as unset.
func packedDate(r sqlitefile.Row, col string) int64 {
	if col == "" {
		return 0
	}
	if v, ok := r.Value(col).(int64); ok {
		return v
	}
	return 0
}

// metaIntegerRe pulls the integer out of Meta.databaseVersion, an XML property list.
var metaIntegerRe = regexp.MustCompile(`<integer>\s*(-?\d+)\s*</integer>`)

// metaVersion reads the database layout version, or 0 when it can't be read (then the
// columns decide whether the import works).
func metaVersion(db *sqlitefile.DB) int {
	if db.Table("Meta") == nil {
		return 0
	}
	version := 0
	_ = db.Scan("Meta", func(r sqlitefile.Row) error {
		if r.String("key") != "databaseVersion" {
			return nil
		}
		v := r.String("value")
		if m := metaIntegerRe.FindStringSubmatch(v); m != nil {
			v = m[1]
		}
		version, _ = strconv.Atoi(v)
		return nil
	})
	return version
}
