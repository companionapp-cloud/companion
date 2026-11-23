package term

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

// `companion tui`: today's note, the calendar, notes, tasks, canvases and the link graph, in a
// terminal. Everything goes through the app's /invoke route (client.go), and the /events stream
// refreshes what's on screen when the app or another device changes something.

// --- wire shapes (mirror packages/core-bridge/src/types.ts) ------------------

type note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	ContentMD string    `json:"contentMd"`
	Date      *string   `json:"date"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type task struct {
	ID      string     `json:"id"`
	Title   string     `json:"title"`
	NotesMD string     `json:"notesMd"`
	Status  string     `json:"status"`
	StartAt *time.Time `json:"startAt"`
	DueAt   *time.Time `json:"dueAt"`
	Someday bool       `json:"someday"`
}

type calItem struct {
	ID       string     `json:"id"`
	Kind     string     `json:"kind"`
	Title    string     `json:"title"`
	StartsAt time.Time  `json:"startsAt"`
	EndsAt   *time.Time `json:"endsAt"`
	AllDay   bool       `json:"allDay"`
	Span     bool       `json:"span"`
	Location *string    `json:"location"`
}

type canvas struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type canvasDoc struct {
	Canvas canvas `json:"canvas"`
	Nodes  []struct {
		ID      string         `json:"id"`
		Kind    string         `json:"kind"`
		RefType *string        `json:"refType"`
		RefID   *string        `json:"refId"`
		Data    map[string]any `json:"data"`
	} `json:"nodes"`
	Edges []struct {
		From  string `json:"fromNodeId"`
		To    string `json:"toNodeId"`
		Label string `json:"label"`
	} `json:"edges"`
	Refs struct {
		Notes map[string]struct{ Title string } `json:"notes"`
		Tasks map[string]struct {
			Title  string `json:"title"`
			Status string `json:"status"`
		} `json:"tasks"`
		Events    map[string]struct{ Title string }    `json:"events"`
		Documents map[string]struct{ Filename string } `json:"documents"`
	} `json:"refs"`
}

type gnode struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

type graph struct {
	Nodes []gnode `json:"nodes"`
	Edges []struct {
		SourceType string `json:"sourceType"`
		SourceID   string `json:"sourceId"`
		TargetType string `json:"targetType"`
		TargetID   string `json:"targetId"`
		Kind       string `json:"kind"`
	} `json:"edges"`
}

// gnodeLink is a neighbor of the current graph node, and which way the link points.
type gnodeLink struct {
	gnode
	kind     string
	incoming bool
}

// --- model ------------------------------------------------------------------

type tab int

const (
	tabToday tab = iota
	tabCalendar
	tabNotes
	tabTasks
	tabCanvases
	tabGraph
)

var tabNames = []string{"Today", "Calendar", "Notes", "Tasks", "Canvases", "Graph"}

// StartTab maps `companion tui [tab]` to a tab; unknown names start on Today.
func StartTab(name string) tab {
	for i, n := range tabNames {
		if strings.EqualFold(n, name) {
			return tab(i)
		}
	}
	return tabToday
}

type model struct {
	c      *Client
	ctx    context.Context
	events <-chan string
	w, h   int
	tab    tab
	status string

	// Today
	todayDate  string
	todayNote  *note
	todayEd    textarea.Model
	todayDirty bool
	todaySeq   int
	todayReady bool

	// Calendar
	calDay   time.Time
	calWeek  bool
	calItems []calItem

	// Notes
	notes     []note
	noteQuery textinput.Model
	noteSel   int
	editing   *note
	noteEd    textarea.Model
	preview   map[string]string

	// Tasks
	tasks    []task
	taskSel  int
	showDone bool
	prompt   textinput.Model
	asking   string // "", "due", "new"

	// Canvases
	canvases  []canvas
	canvasSel int
	canvasDoc *canvasDoc

	// Graph
	graphCur   *gnode
	graphLinks []gnodeLink
	graphSel   int
	graphHist  []gnode
	graphQuery textinput.Model
	graphHits  []gnode
}

func newModel(ctx context.Context, c *Client, start tab) model {
	ed := textarea.New()
	ed.ShowLineNumbers = false
	ed.Placeholder = "Write today's note…"
	ed.CharLimit = 0
	ed.MaxHeight = 0
	ned := textarea.New()
	ned.ShowLineNumbers = false
	ned.CharLimit = 0
	ned.MaxHeight = 0
	nq := textinput.New()
	nq.Placeholder = "search notes"
	nq.Prompt = "/ "
	gq := textinput.New()
	gq.Placeholder = "find a note, task, project or canvas"
	gq.Prompt = "› "
	pr := textinput.New()
	now := time.Now()
	m := model{
		c: c, ctx: ctx, events: c.Events(ctx), tab: start,
		todayDate: now.Format("2006-01-02"), todayEd: ed,
		calDay: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local),
		noteEd: ned, noteQuery: nq, graphQuery: gq, prompt: pr,
		preview: map[string]string{},
	}
	if start == tabToday {
		m.todayEd.Focus()
	}
	if start == tabGraph {
		m.graphQuery.Focus()
	}
	return m
}

// RunTUI runs the TUI until the user quits.
func RunTUI(c *Client, start tab) error {
	// Fail before taking over the screen when the app can't be reached at all.
	if err := c.Invoke("core.version", nil, nil); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := tea.NewProgram(newModel(ctx, c, start), tea.WithAltScreen()).Run()
	return err
}

// --- messages ---------------------------------------------------------------

type (
	errMsg      struct{ err error }
	statusMsg   string
	changedMsg  string
	todayMsg    struct{ n *note }
	todaySaved  struct{ n *note }
	saveTick    int
	calMsg      []calItem
	notesMsg    []note
	tasksMsg    []task
	canvasesMsg []canvas
	canvasMsg   *canvasDoc
	graphMsg    struct {
		cur   gnode
		links []gnodeLink
	}
	graphHitsMsg []gnode
)

func (m model) Init() tea.Cmd {
	return tea.Batch(m.waitEvent(), m.loadToday(), m.loadTab(m.tab))
}

func (m model) waitEvent() tea.Cmd {
	ch := m.events
	return func() tea.Msg {
		name, ok := <-ch
		if !ok {
			return nil
		}
		return changedMsg(name)
	}
}

func fail(err error) tea.Msg { return errMsg{err} }

func (m model) loadToday() tea.Cmd {
	c, date := m.c, m.todayDate
	return func() tea.Msg {
		var all []note
		if err := c.Invoke("notes.list", nil, &all); err != nil {
			return fail(err)
		}
		for i := range all {
			if all[i].Date != nil && *all[i].Date == date {
				return todayMsg{&all[i]}
			}
		}
		return todayMsg{nil}
	}
}

func (m model) loadTab(t tab) tea.Cmd {
	c := m.c
	switch t {
	case tabCalendar:
		from, to := m.calDay, m.calDay.AddDate(0, 0, 1)
		if m.calWeek {
			from = m.calDay.AddDate(0, 0, -int((m.calDay.Weekday()+6)%7)) // weeks start Monday
			to = from.AddDate(0, 0, 7)
		}
		return func() tea.Msg {
			var items []calItem
			err := c.Invoke("calendar.range", map[string]string{
				"from": from.Format(time.RFC3339), "to": to.Format(time.RFC3339),
				"fromDate": from.Format("2006-01-02"), "toDate": to.Format("2006-01-02"),
			}, &items)
			if err != nil {
				return fail(err)
			}
			return calMsg(items)
		}
	case tabNotes:
		return func() tea.Msg {
			var all []note
			if err := c.Invoke("notes.list", nil, &all); err != nil {
				return fail(err)
			}
			sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedAt.After(all[j].UpdatedAt) })
			return notesMsg(all)
		}
	case tabTasks:
		return func() tea.Msg {
			var all []task
			if err := c.Invoke("tasks.list", nil, &all); err != nil {
				return fail(err)
			}
			sort.SliceStable(all, func(i, j int) bool {
				a, b := all[i].DueAt, all[j].DueAt
				switch {
				case a == nil:
					return false
				case b == nil:
					return true
				}
				return a.Before(*b)
			})
			return tasksMsg(all)
		}
	case tabCanvases:
		return func() tea.Msg {
			var all []canvas
			if err := c.Invoke("canvases.list", nil, &all); err != nil {
				return fail(err)
			}
			return canvasesMsg(all)
		}
	case tabGraph:
		if m.graphCur != nil {
			return m.openGraph(*m.graphCur)
		}
	}
	return nil
}

func (m model) openCanvas(id string) tea.Cmd {
	c := m.c
	return func() tea.Msg {
		var doc canvasDoc
		if err := c.Invoke("canvases.get", map[string]string{"id": id}, &doc); err != nil {
			return fail(err)
		}
		return canvasMsg(&doc)
	}
}

func (m model) openGraph(n gnode) tea.Cmd {
	c := m.c
	return func() tea.Msg {
		var g graph
		if err := c.Invoke("graph.neighborhood", map[string]any{"type": n.Type, "id": n.ID, "depth": 1}, &g); err != nil {
			return fail(err)
		}
		byID := map[string]gnode{}
		for _, gn := range g.Nodes {
			byID[gn.ID] = gn
		}
		if cur, ok := byID[n.ID]; ok {
			n = cur
		}
		var links []gnodeLink
		seen := map[string]bool{}
		for _, e := range g.Edges {
			var other string
			in := false
			switch {
			case e.SourceID == n.ID && e.TargetID != n.ID:
				other = e.TargetID
			case e.TargetID == n.ID && e.SourceID != n.ID:
				other, in = e.SourceID, true
			default:
				continue
			}
			key := fmt.Sprint(other, in, e.Kind)
			if seen[key] {
				continue
			}
			seen[key] = true
			on, ok := byID[other]
			if !ok {
				continue
			}
			links = append(links, gnodeLink{gnode: on, kind: e.Kind, incoming: in})
		}
		sort.SliceStable(links, func(i, j int) bool {
			if links[i].incoming != links[j].incoming {
				return !links[i].incoming
			}
			return strings.ToLower(links[i].Title) < strings.ToLower(links[j].Title)
		})
		return graphMsg{cur: n, links: links}
	}
}

func (m model) searchGraph(q string) tea.Cmd {
	c := m.c
	return func() tea.Msg {
		var hits []gnode
		if err := c.Invoke("graph.search", map[string]any{"query": q, "limit": 30}, &hits); err != nil {
			return fail(err)
		}
		return graphHitsMsg(hits)
	}
}

// saveToday writes the editor to today's note, creating it on the first non-empty save.
func (m model) saveToday() tea.Cmd {
	c, body, date, existing := m.c, m.todayEd.Value(), m.todayDate, m.todayNote
	return func() tea.Msg {
		var n note
		var err error
		if existing != nil {
			err = c.Invoke("notes.update", map[string]any{"id": existing.ID, "contentMd": body}, &n)
		} else {
			if strings.TrimSpace(body) == "" {
				return todaySaved{nil}
			}
			err = c.Invoke("notes.create", map[string]any{"title": fullDate(date), "contentMd": body, "date": date}, &n)
		}
		if err != nil {
			return fail(err)
		}
		return todaySaved{&n}
	}
}

func (m model) invokeThen(method string, payload any, ok string, reload tab) tea.Cmd {
	c := m.c
	return func() tea.Msg {
		if err := c.Invoke(method, payload, nil); err != nil {
			return fail(err)
		}
		return tea.Batch(func() tea.Msg { return statusMsg(ok) }, m.loadTab(reload))()
	}
}

// --- update -----------------------------------------------------------------

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.todayEd.SetWidth(m.w - 4)
		m.todayEd.SetHeight(m.bodyHeight() - 2)
		m.noteEd.SetWidth(m.w - 4)
		m.noteEd.SetHeight(m.bodyHeight() - 2)
		m.preview = map[string]string{}
		m.noteQuery.Width = min(42, m.w/3) - 4
		m.graphQuery.Width = m.w - 8
		m.prompt.Width = m.w - 20
		return m, nil
	case tea.BatchMsg:
		return m, tea.Batch(msg...)
	case errMsg:
		m.status = "⚠ " + msg.err.Error()
		return m, nil
	case statusMsg:
		m.status = string(msg)
		return m, nil
	case changedMsg:
		cmds := []tea.Cmd{m.waitEvent(), m.loadTab(m.tab)}
		if !m.todayDirty && !m.todayEd.Focused() {
			cmds = append(cmds, m.loadToday())
		}
		return m, tea.Batch(cmds...)
	case todayMsg:
		m.todayNote = msg.n
		if !m.todayDirty {
			body := ""
			if msg.n != nil {
				body = msg.n.ContentMD
			}
			if !m.todayReady || body != m.todayEd.Value() {
				m.todayEd.SetValue(body)
			}
		}
		m.todayReady = true
		return m, nil
	case todaySaved:
		if msg.n != nil {
			m.todayNote = msg.n
			m.status = "Saved " + time.Now().Format("15:04:05")
		}
		return m, nil
	case saveTick:
		if int(msg) == m.todaySeq && m.todayDirty {
			m.todayDirty = false
			return m, m.saveToday()
		}
		return m, nil
	case calMsg:
		m.calItems = msg
		return m, nil
	case notesMsg:
		m.notes = msg
		m.preview = map[string]string{}
		m.noteSel = clamp(m.noteSel, len(m.filteredNotes()))
		return m, nil
	case tasksMsg:
		m.tasks = msg
		m.taskSel = clamp(m.taskSel, len(m.visibleTasks()))
		return m, nil
	case canvasesMsg:
		m.canvases = msg
		m.canvasSel = clamp(m.canvasSel, len(m.canvases))
		return m, nil
	case canvasMsg:
		m.canvasDoc = msg
		return m, nil
	case graphMsg:
		cur := msg.cur
		m.graphCur, m.graphLinks, m.graphSel = &cur, msg.links, 0
		return m, nil
	case graphHitsMsg:
		m.graphHits = msg
		m.graphSel = 0
		return m, nil
	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

// typing reports whether a text field has the keyboard, so letters type instead of acting.
func (m model) typing() bool {
	return m.todayEd.Focused() || m.editing != nil || m.noteQuery.Focused() || m.asking != "" || m.graphQuery.Focused()
}

func (m model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.String() == "ctrl+c" {
		if m.todayDirty {
			m.todayDirty = false
			if msg := m.saveToday()(); msg != nil {
				if e, ok := msg.(errMsg); ok {
					m.status = "⚠ " + e.err.Error()
				}
			}
		}
		return m, tea.Quit
	}
	if !m.typing() {
		switch k.String() {
		case "q":
			if m.todayDirty {
				m.todayDirty = false
				_ = m.saveToday()()
			}
			return m, tea.Quit
		case "tab", "right", "l":
			if m.tab != tabCalendar || k.String() == "tab" {
				return m.switchTab((m.tab + 1) % tab(len(tabNames)))
			}
		case "shift+tab", "left", "h":
			if m.tab != tabCalendar || k.String() == "shift+tab" {
				return m.switchTab((m.tab + tab(len(tabNames)) - 1) % tab(len(tabNames)))
			}
		case "1", "2", "3", "4", "5", "6":
			return m.switchTab(tab(k.String()[0] - '1'))
		}
	}
	switch m.tab {
	case tabToday:
		return m.keyToday(k)
	case tabCalendar:
		return m.keyCalendar(k)
	case tabNotes:
		return m.keyNotes(k)
	case tabTasks:
		return m.keyTasks(k)
	case tabCanvases:
		return m.keyCanvases(k)
	case tabGraph:
		return m.keyGraph(k)
	}
	return m, nil
}

func (m model) switchTab(t tab) (tea.Model, tea.Cmd) {
	m.tab = t
	m.status = ""
	return m, m.loadTab(t)
}

func (m model) keyToday(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if !m.todayEd.Focused() {
		switch k.String() {
		case "enter", "i", "e":
			m.todayEd.Focus()
		case "g":
			if m.todayNote != nil {
				return m.jumpGraph(gnode{ID: m.todayNote.ID, Type: "note", Title: m.todayNote.Title})
			}
		}
		return m, nil
	}
	if k.String() == "esc" {
		m.todayEd.Blur()
		if m.todayDirty {
			m.todayDirty = false
			return m, m.saveToday()
		}
		return m, nil
	}
	before := m.todayEd.Value()
	var cmd tea.Cmd
	m.todayEd, cmd = m.todayEd.Update(k)
	if m.todayEd.Value() != before {
		m.todayDirty = true
		m.todaySeq++
		seq := m.todaySeq
		return m, tea.Batch(cmd, tea.Tick(800*time.Millisecond, func(time.Time) tea.Msg { return saveTick(seq) }))
	}
	return m, cmd
}

func (m model) keyCalendar(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	step := 1
	if m.calWeek {
		step = 7
	}
	switch k.String() {
	case "left", "h", "[":
		m.calDay = m.calDay.AddDate(0, 0, -step)
	case "right", "l", "]":
		m.calDay = m.calDay.AddDate(0, 0, step)
	case "w":
		m.calWeek = !m.calWeek
	case "t", ".":
		now := time.Now()
		m.calDay = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	default:
		return m, nil
	}
	return m, m.loadTab(tabCalendar)
}

func (m model) filteredNotes() []note {
	q := strings.ToLower(strings.TrimSpace(m.noteQuery.Value()))
	var out []note
	for _, n := range m.notes {
		if q == "" || strings.Contains(strings.ToLower(n.Title), q) || strings.Contains(strings.ToLower(n.ContentMD), q) {
			out = append(out, n)
		}
	}
	return out
}

func (m model) keyNotes(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.editing != nil {
		if k.String() == "esc" {
			n := m.editing
			m.editing = nil
			m.noteEd.Blur()
			if m.noteEd.Value() == n.ContentMD {
				return m, nil
			}
			return m, m.invokeThen("notes.update", map[string]any{"id": n.ID, "contentMd": m.noteEd.Value()}, "Saved “"+n.Title+"”", tabNotes)
		}
		var cmd tea.Cmd
		m.noteEd, cmd = m.noteEd.Update(k)
		return m, cmd
	}
	if m.noteQuery.Focused() {
		switch k.String() {
		case "esc", "enter":
			m.noteQuery.Blur()
			return m, nil
		}
		var cmd tea.Cmd
		m.noteQuery, cmd = m.noteQuery.Update(k)
		m.noteSel = 0
		return m, cmd
	}
	list := m.filteredNotes()
	switch k.String() {
	case "/":
		m.noteQuery.Focus()
	case "up", "k":
		m.noteSel = clamp(m.noteSel-1, len(list))
	case "down", "j":
		m.noteSel = clamp(m.noteSel+1, len(list))
	case "enter", "e":
		if len(list) > 0 {
			n := list[m.noteSel]
			m.editing = &n
			m.noteEd.SetValue(n.ContentMD)
			m.noteEd.Focus()
		}
	case "g":
		if len(list) > 0 {
			n := list[m.noteSel]
			return m.jumpGraph(gnode{ID: n.ID, Type: "note", Title: n.Title})
		}
	case "r":
		return m, m.loadTab(tabNotes)
	}
	return m, nil
}

func (m model) visibleTasks() []task {
	var out []task
	for _, t := range m.tasks {
		if m.showDone || t.Status == "open" {
			out = append(out, t)
		}
	}
	return out
}

func (m model) keyTasks(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	list := m.visibleTasks()
	if m.asking != "" {
		switch k.String() {
		case "esc":
			m.asking = ""
			m.prompt.Blur()
			return m, nil
		case "enter":
			text := strings.TrimSpace(m.prompt.Value())
			kind := m.asking
			m.asking = ""
			m.prompt.Blur()
			if text == "" {
				return m, nil
			}
			if kind == "new" {
				return m, m.invokeThen("tasks.create", map[string]any{"title": text}, "Created “"+text+"”", tabTasks)
			}
			if len(list) == 0 {
				return m, nil
			}
			t, c := list[m.taskSel], m.c
			return m, func() tea.Msg {
				at, err := ParseDate(c, text)
				if err != nil {
					return fail(err)
				}
				return m.invokeThen("tasks.update", map[string]any{"id": t.ID, "dueAt": at}, "Due "+at.Local().Format("Mon Jan 2 15:04"), tabTasks)()
			}
		}
		var cmd tea.Cmd
		m.prompt, cmd = m.prompt.Update(k)
		return m, cmd
	}
	switch k.String() {
	case "up", "k":
		m.taskSel = clamp(m.taskSel-1, len(list))
	case "down", "j":
		m.taskSel = clamp(m.taskSel+1, len(list))
	case "x", " ":
		if len(list) > 0 {
			t := list[m.taskSel]
			status, word := "done", "Done: "
			if t.Status == "done" {
				status, word = "open", "Reopened: "
			}
			return m, m.invokeThen("tasks.update", map[string]any{"id": t.ID, "status": status}, word+t.Title, tabTasks)
		}
	case "d":
		if len(list) > 0 {
			m.asking = "due"
			m.prompt.Prompt = "Due: "
			m.prompt.Placeholder = "tomorrow 5pm, fri, next week"
			m.prompt.SetValue("")
			m.prompt.Focus()
		}
	case "n":
		m.asking = "new"
		m.prompt.Prompt = "New task: "
		m.prompt.Placeholder = "title"
		m.prompt.SetValue("")
		m.prompt.Focus()
	case "a":
		m.showDone = !m.showDone
		m.taskSel = 0
	case "g":
		if len(list) > 0 {
			t := list[m.taskSel]
			return m.jumpGraph(gnode{ID: t.ID, Type: "task", Title: t.Title})
		}
	case "r":
		return m, m.loadTab(tabTasks)
	}
	return m, nil
}

func (m model) keyCanvases(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.canvasDoc != nil {
		switch k.String() {
		case "esc", "backspace":
			m.canvasDoc = nil
		case "g":
			c := m.canvasDoc.Canvas
			return m.jumpGraph(gnode{ID: c.ID, Type: "canvas", Title: c.Name})
		}
		return m, nil
	}
	switch k.String() {
	case "up", "k":
		m.canvasSel = clamp(m.canvasSel-1, len(m.canvases))
	case "down", "j":
		m.canvasSel = clamp(m.canvasSel+1, len(m.canvases))
	case "enter":
		if len(m.canvases) > 0 {
			return m, m.openCanvas(m.canvases[m.canvasSel].ID)
		}
	}
	return m, nil
}

func (m model) jumpGraph(n gnode) (tea.Model, tea.Cmd) {
	if m.graphCur != nil {
		m.graphHist = append(m.graphHist, *m.graphCur)
	}
	m.tab = tabGraph
	m.graphQuery.Blur()
	return m, m.openGraph(n)
}

func (m model) keyGraph(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.graphQuery.Focused() {
		switch k.String() {
		case "esc":
			m.graphQuery.Blur()
			return m, nil
		case "up":
			m.graphSel = clamp(m.graphSel-1, len(m.graphHits))
			return m, nil
		case "down":
			m.graphSel = clamp(m.graphSel+1, len(m.graphHits))
			return m, nil
		case "enter":
			if len(m.graphHits) == 0 {
				return m, nil
			}
			n := m.graphHits[m.graphSel]
			m.graphHits = nil
			m.graphQuery.SetValue("")
			return m.jumpGraph(n)
		}
		before := m.graphQuery.Value()
		var cmd tea.Cmd
		m.graphQuery, cmd = m.graphQuery.Update(k)
		if q := strings.TrimSpace(m.graphQuery.Value()); q != before && q != "" {
			return m, tea.Batch(cmd, m.searchGraph(q))
		}
		return m, cmd
	}
	switch k.String() {
	case "/":
		m.graphQuery.Focus()
	case "up", "k":
		m.graphSel = clamp(m.graphSel-1, len(m.graphLinks))
	case "down", "j":
		m.graphSel = clamp(m.graphSel+1, len(m.graphLinks))
	case "enter":
		if len(m.graphLinks) > 0 {
			return m.jumpGraph(m.graphLinks[m.graphSel].gnode)
		}
	case "backspace", "b":
		if n := len(m.graphHist); n > 0 {
			prev := m.graphHist[n-1]
			m.graphHist = m.graphHist[:n-1]
			return m, m.openGraph(prev)
		}
	}
	return m, nil
}

// --- view -------------------------------------------------------------------

var (
	accent   = lipgloss.AdaptiveColor{Light: "#3b5bdb", Dark: "#91a7ff"}
	muted    = lipgloss.AdaptiveColor{Light: "#868e96", Dark: "#868e96"}
	tabOn    = lipgloss.NewStyle().Bold(true).Foreground(accent).Underline(true).Padding(0, 1)
	tabOff   = lipgloss.NewStyle().Foreground(muted).Padding(0, 1)
	dim      = lipgloss.NewStyle().Foreground(muted)
	bold     = lipgloss.NewStyle().Bold(true)
	selected = lipgloss.NewStyle().Foreground(accent).Bold(true)
	heading  = lipgloss.NewStyle().Bold(true).Foreground(accent)
	warn     = lipgloss.NewStyle().Foreground(lipgloss.Color("#e8590c"))
)

func (m model) bodyHeight() int { return max(m.h-4, 3) }

func (m model) View() string {
	if m.w == 0 {
		return ""
	}
	var tabs []string
	for i, n := range tabNames {
		label := fmt.Sprintf("%d %s", i+1, n)
		if tab(i) == m.tab {
			tabs = append(tabs, tabOn.Render(label))
		} else {
			tabs = append(tabs, tabOff.Render(label))
		}
	}
	header := lipgloss.JoinHorizontal(lipgloss.Top, append([]string{heading.Render(" Companion ")}, tabs...)...)
	var body string
	switch m.tab {
	case tabToday:
		body = m.viewToday()
	case tabCalendar:
		body = m.viewCalendar()
	case tabNotes:
		body = m.viewNotes()
	case tabTasks:
		body = m.viewTasks()
	case tabCanvases:
		body = m.viewCanvases()
	case tabGraph:
		body = m.viewGraph()
	}
	body = lipgloss.NewStyle().Height(m.bodyHeight()).MaxHeight(m.bodyHeight()).Padding(0, 1).Render(body)
	foot := dim.Render(m.help())
	if m.status != "" {
		st := m.status
		if strings.HasPrefix(st, "⚠") {
			st = warn.Render(st)
		}
		foot = st + dim.Render("  ·  ") + foot
	}
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, lipgloss.NewStyle().MaxWidth(m.w).Render(foot))
}

func (m model) help() string {
	nav := "tab/1-6 switch · q quit"
	switch m.tab {
	case tabToday:
		if m.todayEd.Focused() {
			return "esc done editing (saves as you type)"
		}
		return "enter edit · g graph · " + nav
	case tabCalendar:
		return "←/→ move · w day/week · t today · " + nav
	case tabNotes:
		if m.editing != nil {
			return "esc save and close"
		}
		return "/ search · ↑↓ move · enter edit · g graph · " + nav
	case tabTasks:
		if m.asking != "" {
			return "enter save · esc cancel"
		}
		return "x done · d due · n new · a show done · g graph · " + nav
	case tabCanvases:
		if m.canvasDoc != nil {
			return "esc back · g graph · " + nav
		}
		return "enter open · " + nav
	case tabGraph:
		return "/ find · enter follow · b back · " + nav
	}
	return nav
}

func (m model) viewToday() string {
	title := bold.Render(fullDate(m.todayDate))
	state := dim.Render(" · no note yet")
	if m.todayNote != nil {
		state = dim.Render(" · daily note")
	}
	if m.todayDirty {
		state += dim.Render(" · editing…")
	}
	return title + state + "\n" + m.todayEd.View()
}

func (m model) viewCalendar() string {
	var b strings.Builder
	days := 1
	start := m.calDay
	if m.calWeek {
		start = m.calDay.AddDate(0, 0, -int((m.calDay.Weekday()+6)%7))
		days = 7
	}
	for d := 0; d < days; d++ {
		day := start.AddDate(0, 0, d)
		label := day.Format("Monday, January 2")
		if day.Format("2006-01-02") == time.Now().Format("2006-01-02") {
			label += " · today"
		}
		b.WriteString(heading.Render(label) + "\n")
		n := 0
		for _, it := range m.calItems {
			if !onDay(it, day) {
				continue
			}
			n++
			when := "all day"
			if !it.AllDay && !it.Span {
				when = it.StartsAt.Local().Format("15:04")
				if it.EndsAt != nil {
					when += "–" + it.EndsAt.Local().Format("15:04")
				}
			}
			line := fmt.Sprintf("  %-11s %s %s", when, kindMark(it.Kind), it.Title)
			if it.Location != nil && *it.Location != "" {
				line += dim.Render("  @ " + *it.Location)
			}
			b.WriteString(truncate(line, m.w-2) + "\n")
		}
		if n == 0 {
			b.WriteString(dim.Render("  nothing scheduled") + "\n")
		}
		// A day leaves a gap; a week packs its days so all seven fit.
		if d < days-1 && !m.calWeek {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// onDay places an item on a local day. All-day items carry UTC-midnight date markers, so they
// compare by date; timed ones by instant.
func onDay(it calItem, day time.Time) bool {
	next := day.AddDate(0, 0, 1)
	if it.AllDay {
		d := it.StartsAt.UTC().Format("2006-01-02")
		end := d
		if it.EndsAt != nil {
			end = it.EndsAt.UTC().AddDate(0, 0, -1).Format("2006-01-02")
		}
		ds := day.Format("2006-01-02")
		return ds >= d && ds <= end
	}
	end := it.StartsAt
	if it.EndsAt != nil && it.EndsAt.After(end) {
		end = *it.EndsAt
	}
	// Starts before the day ends, and either starts on it or is still going into it.
	return it.StartsAt.Before(next) && (!it.StartsAt.Before(day) || end.After(day))
}

func kindMark(kind string) string {
	switch kind {
	case "task":
		return "☐"
	case "note":
		return "✎"
	case "project":
		return "◆"
	}
	return "•"
}

func (m model) viewNotes() string {
	if m.editing != nil {
		return bold.Render(m.editing.Title) + dim.Render(" · editing") + "\n" + m.noteEd.View()
	}
	list := m.filteredNotes()
	leftW := min(42, m.w/3)
	h := m.bodyHeight() - 2
	var rows []string
	for _, n := range list {
		t := n.Title
		if t == "" {
			t = "Untitled"
		}
		if n.Date != nil {
			t = "✎ " + t
		}
		rows = append(rows, t)
	}
	left := m.noteQuery.View() + "\n" + listView(rows, m.noteSel, h, leftW)
	if len(list) == 0 {
		left = m.noteQuery.View() + "\n" + dim.Render("no notes match")
	}
	right := ""
	if len(list) > 0 {
		right = m.renderMarkdown(list[m.noteSel], m.w-leftW-6)
	}
	return lipgloss.JoinHorizontal(lipgloss.Top,
		lipgloss.NewStyle().Width(leftW).Render(left), "  ",
		lipgloss.NewStyle().MaxHeight(h+1).Render(right))
}

func (m model) renderMarkdown(n note, width int) string {
	key := n.ID + n.UpdatedAt.String()
	if s, ok := m.preview[key]; ok {
		return s
	}
	src := "# " + n.Title + "\n\n" + n.ContentMD
	r, err := glamour.NewTermRenderer(glamour.WithStandardStyle("dark"), glamour.WithWordWrap(max(width, 20)))
	out := src
	if err == nil {
		if s, err := r.Render(src); err == nil {
			out = strings.Trim(s, "\n")
		}
	}
	m.preview[key] = out
	return out
}

func (m model) viewTasks() string {
	list := m.visibleTasks()
	var rows []string
	for _, t := range list {
		box := "☐"
		switch t.Status {
		case "done":
			box = "☑"
		case "cancelled":
			box = "☒"
		}
		row := box + " " + t.Title
		if t.DueAt != nil {
			due := t.DueAt.Local()
			label := due.Format("Mon Jan 2")
			if due.Hour() != 0 || due.Minute() != 0 {
				label += due.Format(" 15:04")
			}
			label = "due " + label
			if t.Status == "open" && due.Before(time.Now()) {
				label = warn.Render("overdue") + dim.Render(" · "+label)
			}
			row += "  " + dim.Render(label)
		} else if t.Someday {
			row += "  " + dim.Render("someday")
		}
		rows = append(rows, row)
	}
	head := bold.Render(fmt.Sprintf("%d open", countOpen(m.tasks)))
	if m.showDone {
		head += dim.Render(" · showing done")
	}
	out := head + "\n"
	if len(rows) == 0 {
		out += dim.Render("nothing to do")
	} else {
		out += listView(rows, m.taskSel, m.bodyHeight()-3, m.w-4)
	}
	if m.asking != "" {
		out += "\n" + m.prompt.View()
	}
	return out
}

func countOpen(ts []task) int {
	n := 0
	for _, t := range ts {
		if t.Status == "open" {
			n++
		}
	}
	return n
}

func (m model) viewCanvases() string {
	if m.canvasDoc != nil {
		return m.viewCanvas(m.canvasDoc)
	}
	if len(m.canvases) == 0 {
		return dim.Render("no canvases")
	}
	var rows []string
	for _, c := range m.canvases {
		rows = append(rows, "▦ "+c.Name)
	}
	return listView(rows, m.canvasSel, m.bodyHeight(), m.w-4)
}

// viewCanvas draws a board as an outline: its cards, then how they connect.
func (m model) viewCanvas(doc *canvasDoc) string {
	label := map[string]string{}
	var b strings.Builder
	b.WriteString(bold.Render(doc.Canvas.Name) + dim.Render(fmt.Sprintf(" · %d cards, %d connections", len(doc.Nodes), len(doc.Edges))) + "\n\n")
	if len(doc.Nodes) == 0 {
		return b.String() + dim.Render("This canvas is empty. Add cards to it in the Companion app.")
	}
	b.WriteString(heading.Render("Cards") + "\n")
	for _, n := range doc.Nodes {
		text := canvasLabel(doc, n.Kind, n.RefType, n.RefID, n.Data)
		label[n.ID] = text
		b.WriteString(truncate("  "+kindIcon(n.Kind)+" "+text, m.w-4) + "\n")
	}
	if len(doc.Edges) > 0 {
		b.WriteString("\n" + heading.Render("Connections") + "\n")
		for _, e := range doc.Edges {
			line := "  " + label[e.From] + dim.Render(" → ") + label[e.To]
			if e.Label != "" {
				line += dim.Render("  (" + e.Label + ")")
			}
			b.WriteString(truncate(line, m.w-4) + "\n")
		}
	}
	return b.String()
}

func canvasLabel(doc *canvasDoc, kind string, refType, refID *string, data map[string]any) string {
	str := func(k string) string {
		s, _ := data[k].(string)
		return strings.TrimSpace(s)
	}
	if refID != nil && refType != nil {
		switch *refType {
		case "note":
			return doc.Refs.Notes[*refID].Title
		case "task":
			t := doc.Refs.Tasks[*refID]
			if t.Status == "done" {
				return t.Title + " ✓"
			}
			return t.Title
		case "event":
			return doc.Refs.Events[*refID].Title
		case "document":
			return doc.Refs.Documents[*refID].Filename
		}
	}
	switch kind {
	case "text":
		if t := str("text"); t != "" {
			first, _, _ := strings.Cut(t, "\n")
			return first
		}
		return "(empty card)"
	case "group":
		if l := str("label"); l != "" {
			return l
		}
		return "(group)"
	case "link":
		return str("url")
	}
	return "(" + kind + ")"
}

func kindIcon(kind string) string {
	switch kind {
	case "note":
		return "✎"
	case "task":
		return "☐"
	case "event":
		return "◷"
	case "group":
		return "▭"
	case "link":
		return "↗"
	case "image":
		return "▣"
	}
	return "▪"
}

func (m model) viewGraph() string {
	if m.graphQuery.Focused() || m.graphCur == nil {
		out := m.graphQuery.View() + "\n"
		if len(m.graphHits) == 0 {
			if m.graphQuery.Value() == "" {
				out += dim.Render("Type to find something, then press enter to see what links to it.")
			} else {
				out += dim.Render("nothing matches")
			}
			return out
		}
		var rows []string
		for _, n := range m.graphHits {
			rows = append(rows, typeTag(n.Type)+" "+n.Title)
		}
		return out + listView(rows, m.graphSel, m.bodyHeight()-2, m.w-4)
	}
	cur := m.graphCur
	out := typeTag(cur.Type) + " " + bold.Render(cur.Title)
	if n := len(m.graphHist); n > 0 {
		out += dim.Render("  ← " + m.graphHist[n-1].Title)
	}
	out += "\n\n"
	if len(m.graphLinks) == 0 {
		return out + dim.Render("Nothing links to or from this yet.")
	}
	var rows []string
	for _, l := range m.graphLinks {
		arrow := "→"
		if l.incoming {
			arrow = "←"
		}
		rows = append(rows, arrow+" "+typeTag(l.Type)+" "+l.Title+dim.Render("  "+edgeWord(l.kind, l.incoming)))
	}
	return out + listView(rows, m.graphSel, m.bodyHeight()-3, m.w-4)
}

func typeTag(t string) string {
	return dim.Render(fmt.Sprintf("%-7s", t))
}

func edgeWord(kind string, in bool) string {
	switch {
	case kind == "ref" && in:
		return "links here"
	case kind == "ref":
		return "linked"
	case kind == "embed" && in:
		return "embeds this"
	case kind == "embed":
		return "embedded"
	case kind == "member":
		return "project"
	case kind == "canvas":
		return "on canvas"
	case strings.HasPrefix(kind, "prop:"):
		return strings.TrimPrefix(kind, "prop:")
	}
	return kind
}

// listView renders rows with the selected one marked, scrolled to keep it in view.
func listView(rows []string, sel, height, width int) string {
	if height < 1 {
		height = 1
	}
	top := 0
	if sel >= height {
		top = sel - height + 1
	}
	var b strings.Builder
	for i := top; i < len(rows) && i < top+height; i++ {
		line := "  " + rows[i]
		if i == sel {
			line = selected.Render("▸ ") + rows[i]
		}
		b.WriteString(truncate(line, width) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func truncate(s string, w int) string {
	if w < 1 {
		return ""
	}
	return lipgloss.NewStyle().MaxWidth(w).Render(s)
}

func clamp(i, n int) int {
	if n == 0 || i < 0 {
		return 0
	}
	if i >= n {
		return n - 1
	}
	return i
}

var months = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// fullDate is a daily note's title, as the app's Today tool names it ("November 23, 2026").
func fullDate(iso string) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		return iso
	}
	return fmt.Sprintf("%s %d, %d", months[t.Month()-1], t.Day(), t.Year())
}
