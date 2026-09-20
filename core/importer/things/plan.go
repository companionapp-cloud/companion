package things

import (
	"encoding/xml"
	"fmt"
	"strings"
	"time"

	"companion/core/domain"
)

// The mapping (PLAN §6.12) runs entirely in memory: the whole library is laid out as a plan —
// every area, project, list and task, in order — alongside an outline of what's there (the
// Inbox, each area and its projects, with counts) for the user to choose from. A scan returns
// the outline; a run prunes the plan to the user's selection and writes it.

// Names given to things Companion needs that Things doesn't have.
const (
	// catchAllArea holds projects that have no area in Things: Companion projects need one.
	catchAllArea = "Things"
	// listName is each project's list, which keeps Things' order of headings and to-dos (tasks
	// have no manual order outside lists).
	listName = "To-dos"
)

type plan struct {
	areas    []*planArea
	unfiled  []*planTask // the Inbox, and to-dos in no area or project
	warnings []warning
	outline  Preview
}

// warning is a note for the user about one container (an area, a project, or the Inbox —
// "" for the whole library), so a run only reports those about what it imported.
type warning struct {
	container string
	text      string
}

const inboxContainer = "inbox"

type planArea struct {
	thingsID string // "" for the catch-all area
	name     string
	projects []*planProject
	// own are the area's own to-dos — the ones in the area but in none of its projects. They
	// are filed directly in the area (PLAN-areas.md §2): open, completed and repeating alike.
	// An area holds no lists, so unlike a project's they keep no manual order.
	own    []*planTask
	counts Counts // what a scan found of them, before the Logbook option and the selection
	id     string // set once written
}

type planProject struct {
	thingsID string
	name     string
	archived bool
	// Its schedule (PLAN-scheduling.md §2): when it starts, its deadline, Someday, and — for a
	// finished project — when it was completed, so it lands in the Logbook on the right day.
	startAt   *time.Time
	dueAt     *time.Time
	someday   bool
	completed *time.Time
	note      string      // its notes and tags, kept as a note in the project
	members   []*planTask // every task in the project: open, completed and repeating
	list      []listEntry // the "To-dos" list: headings and open to-dos, in Things' order
	outline   *ProjectOutline
	id        string
	noteID    string
}

// listEntry is one row of a project's list: a heading, or a task.
type listEntry struct {
	heading string
	task    *planTask
}

type planTask struct {
	thingsID   string
	title      string
	notes      string
	status     string
	startAt    *time.Time
	someday    bool // filed under Someday in Things, with no start date (PLAN-scheduling.md §1)
	dueAt      *time.Time
	completed  *time.Time
	reminders  []domain.Reminder
	repeatRule *string
	id         string
}

type builder struct {
	lib  *library
	opts Options
	loc  *time.Location
	now  time.Time
	p    *plan

	areas    map[string]*planArea    // Things area → its plan
	projects map[string]*planProject // Things project → its plan
	catchAll *planArea
}

func buildPlan(lib *library, opts Options, loc *time.Location, now time.Time) *plan {
	b := &builder{
		lib: lib, opts: opts, loc: loc, now: now, p: &plan{},
		areas: map[string]*planArea{}, projects: map[string]*planProject{},
	}
	b.build()
	b.prune()
	return b.p
}

func (b *builder) warn(container, format string, args ...any) {
	b.p.warnings = append(b.p.warnings, warning{container: container, text: fmt.Sprintf(format, args...)})
}

func (b *builder) build() {
	lib, out := b.lib, &b.p.outline
	out.Version = lib.version
	out.Tags = lib.tagCount

	for _, a := range lib.areas {
		pa := &planArea{thingsID: a.id, name: orDefault(a.title, "Untitled area")}
		b.p.areas = append(b.p.areas, pa)
		b.areas[a.id] = pa
	}
	if n := len(lib.areaTags); n > 0 {
		b.warn("", "Tags on %d %s weren’t kept: Companion areas have no tags.", n, plural(n, "area", "areas"))
	}

	// Projects, in Things' order. Finished ones are listed either way, and imported only with
	// the Logbook.
	for _, it := range lib.ordered {
		if it.kind != kindProject || it.trashed {
			continue
		}
		if it.rule != nil {
			b.warn(it.id, "“%s” repeats in Things; repeating projects aren’t imported yet — only its current copy is.", orDefault(it.title, "Untitled project"))
			continue
		}
		pp := &planProject{
			thingsID: it.id,
			name:     orDefault(it.title, "Untitled project"),
			archived: it.status != statusOpen,
			startAt:  at(it.startDate, startHour, 0, b.loc),
			someday:  it.start == startSomeday && at(it.startDate, startHour, 0, b.loc) == nil,
			note:     b.projectNote(it),
			outline:  &ProjectOutline{ID: it.id, Name: orDefault(it.title, "Untitled project"), Finished: it.status != statusOpen},
		}
		if !isSentinelDate(it.deadline) {
			pp.dueAt = at(it.deadline, dueHour, 0, b.loc)
		}
		if pp.archived {
			pp.completed = fromUnix(it.stopDate)
		}
		b.projects[it.id] = pp
		pa := b.areas[it.area]
		if pa == nil {
			pa = b.catchAllArea()
		}
		pa.projects = append(pa.projects, pp)
	}

	// To-dos, in Things' order (index order is each container's order), then the lists.
	direct := map[*planProject][]*planTask{} // open to-dos in a project, under no heading
	underHeading := map[string][]*planTask{} // open to-dos under a heading
	headings := map[*planProject][]*item{}   // a project's headings, in order
	for _, it := range lib.ordered {
		if it.kind == kindHeading && !it.trashed {
			if pp := b.projects[it.project]; pp != nil {
				headings[pp] = append(headings[pp], it)
			}
		}
	}
	for _, it := range lib.ordered {
		if it.kind != kindTodo || it.trashed {
			continue
		}
		pp, pa, ok := b.placement(it)
		if !ok {
			continue
		}
		counts, container := &out.Inbox, inboxContainer
		switch {
		case pp != nil:
			counts, container = &pp.outline.Counts, pp.thingsID
		case pa != nil:
			counts, container = &pa.counts, pa.thingsID
		}
		if it.rule != nil {
			if t := b.seed(it, container); t != nil {
				counts.Repeating++
				b.place(t, pp, pa)
			}
			continue
		}
		if it.status != statusOpen {
			counts.Completed++
			if !b.opts.IncludeCompleted {
				continue
			}
		} else {
			counts.Tasks++
		}
		t := b.task(it)
		b.place(t, pp, pa)
		if it.status == statusOpen {
			switch {
			case pp != nil && it.heading != "":
				underHeading[it.heading] = append(underHeading[it.heading], t)
			case pp != nil:
				direct[pp] = append(direct[pp], t)
			}
		}
	}

	// Each project's list: its loose to-dos first (Things shows them above the first heading),
	// then each heading with its to-dos. A heading stays when it's open (even empty — it's
	// structure) or still has open to-dos; archived, finished ones are left out.
	for _, pa := range b.p.areas {
		for _, pp := range pa.projects {
			for _, t := range direct[pp] {
				pp.list = append(pp.list, listEntry{task: t})
			}
			for _, h := range headings[pp] {
				tasks := underHeading[h.id]
				if h.status != statusOpen && len(tasks) == 0 {
					continue
				}
				pp.list = append(pp.list, listEntry{heading: orDefault(h.title, "Untitled heading")})
				pp.outline.Headings++
				for _, t := range tasks {
					pp.list = append(pp.list, listEntry{task: t})
				}
			}
		}
	}

	// The outline: every area with its own to-dos and its projects, then the projects in no area.
	for _, pa := range b.p.areas {
		if pa == b.catchAll {
			for _, pp := range pa.projects {
				out.NoArea = append(out.NoArea, *pp.outline)
			}
			continue
		}
		ao := AreaOutline{ID: pa.thingsID, Name: pa.name, Counts: pa.counts, Projects: []ProjectOutline{}}
		for _, pp := range pa.projects {
			ao.Projects = append(ao.Projects, *pp.outline)
		}
		out.Areas = append(out.Areas, ao)
	}
	if out.Areas == nil {
		out.Areas = []AreaOutline{}
	}
	if out.NoArea == nil {
		out.NoArea = []ProjectOutline{}
	}
	out.Warnings = make([]string, 0, len(b.p.warnings))
	for _, w := range b.p.warnings {
		out.Warnings = append(out.Warnings, w.text)
	}
}

// prune keeps what the selection asks for (everything, when there is none): the Inbox, each
// chosen area with its own to-dos, and each chosen project — whose area comes too, even if
// unchosen, since Companion projects need one. Finished projects stay only with the Logbook.
func (b *builder) prune() {
	sel := b.opts.Selection
	areaOn := func(id string) bool { return sel == nil || contains(sel.Areas, id) }
	projectOn := func(pp *planProject) bool {
		return (sel == nil || contains(sel.Projects, pp.thingsID)) && (!pp.archived || b.opts.IncludeCompleted)
	}
	kept := map[string]bool{"": true}
	if sel == nil || sel.Inbox {
		kept[inboxContainer] = true
	} else {
		b.p.unfiled = nil
	}
	var areas []*planArea
	for _, pa := range b.p.areas {
		var projects []*planProject
		for _, pp := range pa.projects {
			if projectOn(pp) {
				projects = append(projects, pp)
				kept[pp.thingsID] = true
			}
		}
		chosen := pa.thingsID != "" && areaOn(pa.thingsID)
		// The area's own to-dos come with it. An area brought along only because one of its
		// projects was chosen leaves them behind.
		if chosen {
			kept[pa.thingsID] = true
		} else {
			pa.own = nil
		}
		if !chosen && len(projects) == 0 {
			continue
		}
		pa.projects = projects
		areas = append(areas, pa)
	}
	b.p.areas = areas
	var warnings []warning
	for _, w := range b.p.warnings {
		if kept[w.container] {
			warnings = append(warnings, w)
		}
	}
	b.p.warnings = warnings
}

// placement finds where a to-do goes: its project (directly, or through its heading), else its
// area, else nowhere (the Inbox, or a to-do in no area). ok is false when it shouldn't be
// imported at all: its project or heading is in the Trash, or it's inside a repeating project's
// template. A reference to a heading or project that doesn't exist is ignored rather than
// losing the to-do: it files by what it does have (its project, its area, or nothing).
func (b *builder) placement(it *item) (pp *planProject, pa *planArea, ok bool) {
	projectID := it.project
	if h := b.lib.items[it.heading]; it.heading != "" && h != nil {
		if h.trashed {
			return nil, nil, false
		}
		if projectID == "" {
			projectID = h.project
		}
	}
	if p := b.lib.items[projectID]; projectID != "" && p != nil {
		if p.trashed || p.rule != nil {
			return nil, nil, false
		}
		if pp = b.projects[projectID]; pp != nil {
			return pp, nil, true
		}
	}
	if pa = b.areas[it.area]; it.area != "" && pa != nil {
		return nil, pa, true
	}
	return nil, nil, true
}

func (b *builder) place(t *planTask, pp *planProject, pa *planArea) {
	switch {
	case pp != nil:
		pp.members = append(pp.members, t)
	case pa != nil:
		pa.own = append(pa.own, t)
	default:
		b.p.unfiled = append(b.p.unfiled, t)
	}
}

// task converts a to-do.
func (b *builder) task(it *item) *planTask {
	t := &planTask{
		thingsID:  it.id,
		title:     it.title,
		notes:     composeNotes(cleanNotes(it.notes), b.lib.checklist[it.id], b.lib.taskTags[it.id]),
		status:    domain.TaskOpen,
		reminders: []domain.Reminder{},
	}
	switch it.status {
	case statusCompleted:
		t.status = domain.TaskDone
		t.completed = fromUnix(it.stopDate)
	case statusCanceled:
		t.status = domain.TaskCancelled
	}
	hour := startHour
	if it.evening {
		hour = eveningHour
	}
	t.startAt = at(it.startDate, hour, 0, b.loc)
	t.someday = it.start == startSomeday && t.startAt == nil
	if !isSentinelDate(it.deadline) {
		t.dueAt = at(it.deadline, dueHour, 0, b.loc)
	}
	// A Things reminder is a time on the When date.
	if h, m, ok := unpackTime(it.reminderTime); ok {
		if r := at(it.startDate, h, m, b.loc); r != nil {
			t.reminders = append(t.reminders, domain.Reminder{At: r})
		}
	}
	return t
}

// seed converts a repeating to-do's template into a Companion repeat seed, anchored on the
// template's next instance so the server never regenerates one Things already made (those
// import as ordinary to-dos). Its deadline is the occurrence when the series has deadlines;
// otherwise the repeat is start-anchored (PLAN §6.4). Nil, with a warning, when it can't be.
func (b *builder) seed(it *item, container string) *planTask {
	title := orDefault(it.title, "Untitled to-do")
	if it.status != statusOpen {
		return nil // a finished series
	}
	if it.paused {
		b.warn(container, "“%s” is paused in Things, so it wasn’t imported as a repeating task.", title)
		return nil
	}
	r, reason, ok := convertRule(it.rule, it.instanceCount, b.loc, b.now)
	if !ok {
		b.warn(container, "“%s”: %s, so it wasn’t imported as a repeating task.", title, reason)
		return nil
	}
	y, m, d, ok := unpackDate(it.nextStart)
	if !ok {
		b.warn(container, "“%s” has no next date in Things, so it wasn’t imported as a repeating task.", title)
		return nil
	}
	startDay := time.Date(y, m, d, 0, 0, 0, 0, b.loc)
	occurrence := startDay.AddDate(0, 0, -r.startOffset) // ts ≤ 0: the date the instance is for
	t := b.task(it)
	t.status, t.completed, t.someday = domain.TaskOpen, nil, false
	rule := r.rule
	t.repeatRule = &rule
	hour := startHour
	if it.evening {
		hour = eveningHour
	}
	start := time.Date(y, m, d, hour, 0, 0, 0, b.loc)
	t.startAt, t.dueAt = &start, nil
	if it.deadline != 0 {
		due := time.Date(occurrence.Year(), occurrence.Month(), occurrence.Day(), dueHour, 0, 0, 0, b.loc)
		t.dueAt = &due
	}
	t.reminders = []domain.Reminder{}
	if h, mi, ok := unpackTime(it.reminderTime); ok {
		at := time.Date(y, m, d, h, mi, 0, 0, b.loc)
		t.reminders = append(t.reminders, domain.Reminder{At: &at})
	}
	if r.afterCompletion {
		b.warn(container, "“%s” repeats after completion in Things; Companion repeats it on a fixed schedule instead.", title)
	}
	return t
}

func (b *builder) catchAllArea() *planArea {
	if b.catchAll == nil {
		b.catchAll = &planArea{name: catchAllArea}
		b.p.areas = append(b.p.areas, b.catchAll)
	}
	return b.catchAll
}

// projectNote keeps what a Companion project can't hold — notes and tags — as a note in
// it. Empty when there's nothing to keep.
func (b *builder) projectNote(it *item) string {
	var meta []string
	if tags := b.lib.taskTags[it.id]; len(tags) > 0 {
		meta = append(meta, "Tags: "+strings.Join(tags, ", "))
	}
	notes := strings.TrimSpace(cleanNotes(it.notes))
	switch {
	case notes == "" && len(meta) == 0:
		return ""
	case notes == "":
		return strings.Join(meta, "\n\n")
	case len(meta) == 0:
		return notes
	default:
		return notes + "\n\n" + strings.Join(meta, "\n\n")
	}
}

// composeNotes appends a to-do's checklist, as a markdown task list (canceled items struck
// through), and its tags to its notes.
func composeNotes(notes string, checklist []*checkItem, tags []string) string {
	var parts []string
	if n := strings.TrimRight(notes, " \t\n"); n != "" {
		parts = append(parts, n)
	}
	if len(checklist) > 0 {
		lines := make([]string, 0, len(checklist))
		for _, c := range checklist {
			switch c.status {
			case statusCompleted:
				lines = append(lines, "- [x] "+c.title)
			case statusCanceled:
				lines = append(lines, "- [x] ~~"+c.title+"~~")
			default:
				lines = append(lines, "- [ ] "+c.title)
			}
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	if len(tags) > 0 {
		parts = append(parts, "Tags: "+strings.Join(tags, ", "))
	}
	return strings.Join(parts, "\n\n")
}

// cleanNotes strips the <note xml:space="preserve"> wrapper older Things versions stored notes
// in; current notes are plain Markdown and pass through.
func cleanNotes(s string) string {
	if !strings.HasPrefix(strings.TrimSpace(s), "<note") {
		return s
	}
	dec := xml.NewDecoder(strings.NewReader(strings.TrimSpace(s)))
	dec.Strict = false
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		if cd, ok := tok.(xml.CharData); ok {
			b.Write(cd)
		}
	}
	return b.String()
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
