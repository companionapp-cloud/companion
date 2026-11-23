package term

import (
	"encoding/json"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// TestDocsFrames renders the TUI screens the docs show, as HTML terminal frames, into
// $COMPANION_TUI_FRAMES. apps/website/scripts/capture-docs.mjs runs it and screenshots each
// frame, so the images come from this code and a throwaway demo workspace, never real data.
// Without the variable it is skipped.
func TestDocsFrames(t *testing.T) {
	outDir := os.Getenv("COMPANION_TUI_FRAMES")
	if outDir == "" {
		t.Skip("set COMPANION_TUI_FRAMES to render the docs' TUI frames")
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)

	c, core := liveClient(t)
	ids := seedDemo(t, core)

	const cols, rows = 104, 26
	frame := func(name string, m model, keys ...string) model {
		t.Helper()
		m = drive(t, m, tea.WindowSizeMsg{Width: cols, Height: rows})
		for _, k := range keys {
			m = drive(t, m, keyMsg(k))
		}
		if strings.HasPrefix(m.status, "⚠") {
			t.Fatalf("%s: %s", name, m.status)
		}
		page := terminalPage(m.View(), cols)
		if err := os.WriteFile(filepath.Join(outDir, name+".html"), []byte(page), 0o644); err != nil {
			t.Fatal(err)
		}
		return m
	}
	start := func(tb tab) model {
		m := newModel(t.Context(), c, tb)
		m.events = nil // the frames are stills; nothing should wait on live events
		return drive(t, m, nil)
	}

	frame("tui-today", start(tabToday))
	frame("tui-calendar", start(tabCalendar), "w")
	notes := start(tabNotes)
	notes = drive(t, notes, tea.WindowSizeMsg{Width: cols, Height: rows})
	for i, n := range notes.filteredNotes() {
		if n.ID == ids["plan"] {
			notes.noteSel = i
		}
	}
	frame("tui-notes", notes)
	frame("tui-tasks", start(tabTasks))
	frame("tui-canvas", start(tabCanvases), "enter")
	g := start(tabGraph)
	g = drive(t, g, tea.WindowSizeMsg{Width: cols, Height: rows})
	g, cmd := g.jumpGraphModel(gnode{ID: ids["plan"], Type: "note", Title: "v1.2 launch plan"})
	g = run(t, g, cmd)
	frame("tui-graph", g)
}

// jumpGraphModel is jumpGraph with the concrete model back, for the test.
func (m model) jumpGraphModel(n gnode) (model, tea.Cmd) {
	next, cmd := m.jumpGraph(n)
	return next.(model), cmd
}

// drive feeds msg to the model, then runs the commands it returns (and theirs) until they
// settle. Commands that don't return promptly, such as cursor blinks and save ticks, are dropped.
func drive(t *testing.T, m model, msg tea.Msg) model {
	t.Helper()
	if msg == nil {
		return run(t, m, m.Init())
	}
	next, cmd := m.Update(msg)
	return run(t, next.(model), cmd)
}

func run(t *testing.T, m model, cmd tea.Cmd) model {
	t.Helper()
	queue := []tea.Cmd{cmd}
	for steps := 0; len(queue) > 0 && steps < 200; steps++ {
		c := queue[0]
		queue = queue[1:]
		if c == nil {
			continue
		}
		done := make(chan tea.Msg, 1)
		go func() { done <- c() }()
		var msg tea.Msg
		select {
		case msg = <-done:
		case <-time.After(400 * time.Millisecond):
			continue
		}
		if batch, ok := msg.(tea.BatchMsg); ok {
			queue = append(queue, batch...)
			continue
		}
		if msg == nil {
			continue
		}
		next, more := m.Update(msg)
		m = next.(model)
		queue = append(queue, more)
	}
	return m
}

func keyMsg(k string) tea.KeyMsg {
	switch k {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
}

// seedDemo writes the same kind of demo workspace the web screenshots use, dated around today.
func seedDemo(t *testing.T, core interface {
	Invoke(string, []byte) ([]byte, error)
}) map[string]string {
	t.Helper()
	ids := map[string]string{}
	call := func(key, method string, payload any) {
		t.Helper()
		var body []byte
		switch p := payload.(type) {
		case string:
			body = []byte(p)
		default:
			body = []byte(mustJSON(t, p))
		}
		out, err := core.Invoke(method, body)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		if key != "" {
			if m := regexp.MustCompile(`"(?:id|eventId)":"([^"]+)"`).FindSubmatch(out); m != nil {
				ids[key] = string(m[1])
			}
		}
	}
	now := time.Now()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	at := func(offset, hour, minute int) time.Time {
		return day.AddDate(0, 0, offset).Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute)
	}

	call("work", "areas.create", map[string]any{"name": "Work"})
	call("launch", "projects.create", map[string]any{"areaId": ids["work"], "name": "v1.2 launch"})
	call("draft", "tasks.create", map[string]any{"title": "Draft the launch announcement", "dueAt": at(0, 17, 0)})
	call("pricing", "tasks.create", map[string]any{"title": "Review pricing page copy", "dueAt": at(1, 17, 0)})
	call("support", "tasks.create", map[string]any{"title": "Brief support on the new billing flow", "dueAt": at(2, 11, 0)})
	call("investor", "tasks.create", map[string]any{"title": "Send the investor update", "dueAt": at(4, 9, 0)})
	call("", "tasks.create", map[string]any{"title": "Book the venue for the team offsite", "someday": true})
	call("", "tasks.create", map[string]any{"title": "Order new standing desks", "dueAt": at(-2, 12, 0)})
	for _, k := range []string{"draft", "pricing", "support"} {
		call("", "projects.addMember", map[string]any{"projectId": ids["launch"], "entityType": "task", "entityId": ids[k]})
	}

	call("plan", "notes.create", map[string]any{"title": "v1.2 launch plan", "contentMd": strings.Join([]string{
		"Shipping v1.2 at the end of the month. Risks are mostly on the pricing page.",
		"",
		"## What has to happen",
		"",
		"- Finish the pricing page copy",
		"- Line up the announcement post",
		"- Brief support on the new billing flow",
		"",
		fmt.Sprintf("Tracking the work in [[task:%s|Review pricing page copy]] and [[task:%s|Draft the launch announcement]].", ids["pricing"], ids["draft"]),
	}, "\n")})
	call("", "projects.addMember", map[string]any{"projectId": ids["launch"], "entityType": "note", "entityId": ids["plan"]})
	call("standup", "notes.create", map[string]any{"title": "Standup notes", "contentMd": fmt.Sprintf(
		"## Monday\n\n- Pricing copy is with legal\n- Announcement draft due today, see [[note:%s|v1.2 launch plan]]\n\n## Blockers\n\nNone this week.", ids["plan"])})
	call("", "notes.create", map[string]any{"title": "Interview loop: frontend", "contentMd": "Three rounds: pairing, system design, values.\n\nScorecards go in the hiring folder."})
	call("", "notes.create", map[string]any{"title": "Kitchen renovation ideas", "contentMd": "- Open shelving on the left wall\n- Warmer lighting over the island"})
	today := day.Format("2006-01-02")
	call("today", "notes.create", map[string]any{"title": fullDate(today), "date": today, "contentMd": strings.Join([]string{
		"## Focus",
		"",
		"- Get the launch announcement to a first draft",
		"- Pricing copy review with Maya at 2pm",
		"",
		"## Notes",
		"",
		"Legal is happy with the billing wording. Next step is the FAQ.",
	}, "\n")})

	// Events: a static ICS calendar, so the agenda shows meetings beside the tasks and notes.
	ics := func(uid, title string, start, end time.Time, loc string) string {
		f := "20060102T150405Z"
		return fmt.Sprintf("BEGIN:VEVENT\r\nUID:%s\r\nSUMMARY:%s\r\nDTSTART:%s\r\nDTEND:%s\r\nLOCATION:%s\r\nEND:VEVENT\r\n",
			uid, title, start.UTC().Format(f), end.UTC().Format(f), loc)
	}
	cal := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Companion docs//EN\r\n" +
		ics("e1", "Weekly team sync", at(0, 9, 30), at(0, 10, 0), "Zoom") +
		ics("e2", "Pricing copy review", at(0, 14, 0), at(0, 15, 0), "Room 4") +
		ics("e3", "1:1 with Maya", at(1, 11, 0), at(1, 11, 30), "") +
		ics("e4", "Launch dry run", at(3, 15, 0), at(3, 16, 30), "Main office") +
		"END:VCALENDAR\r\n"
	call("feed", "calendar.feeds.create", map[string]any{"name": "Work", "url": "", "icsText": cal, "color": "#3b5bdb"})
	call("", "calendar.refresh", map[string]any{})

	call("board", "canvases.create", map[string]any{"name": "Launch board"})
	ref := func(s string) *string { return &s }
	call("", "canvases.nodes.upsert", map[string]any{"canvasId": ids["board"], "nodes": []map[string]any{
		{"id": "n-goal", "kind": "text", "x": 0, "y": 0, "width": 240, "height": 80, "data": map[string]any{"text": "Ship v1.2 by the 30th"}},
		{"id": "n-plan", "kind": "note", "x": 300, "y": 0, "width": 240, "height": 120, "refType": ref("note"), "refId": ref(ids["plan"])},
		{"id": "n-pricing", "kind": "task", "x": 300, "y": 160, "width": 240, "height": 60, "refType": ref("task"), "refId": ref(ids["pricing"])},
		{"id": "n-draft", "kind": "task", "x": 600, "y": 160, "width": 240, "height": 60, "refType": ref("task"), "refId": ref(ids["draft"])},
		{"id": "n-risks", "kind": "group", "x": 0, "y": 280, "width": 500, "height": 200, "data": map[string]any{"label": "Risks"}},
		{"id": "n-legal", "kind": "text", "x": 20, "y": 320, "width": 220, "height": 60, "data": map[string]any{"text": "Legal sign-off on billing copy"}},
	}})
	edge := func(from, to, label string) map[string]any {
		return map[string]any{"fromNodeId": from, "toNodeId": to, "fromEnd": "none", "toEnd": "arrow", "style": "curved", "label": label}
	}
	call("", "canvases.edges.upsert", map[string]any{"canvasId": ids["board"], "edges": []map[string]any{
		edge("n-goal", "n-plan", "how"), edge("n-plan", "n-pricing", ""), edge("n-plan", "n-draft", ""), edge("n-legal", "n-pricing", "blocks"),
	}})
	return ids
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// --- ANSI → HTML ------------------------------------------------------------

var (
	sgrRe   = regexp.MustCompile(`\x1b\[([0-9;]*)m`)
	otherRe = regexp.MustCompile(`\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]`)
)

type sgrState struct {
	fg, bg                         string
	bold, faint, italic, underline bool
	reverse                        bool
}

func (s sgrState) style() string {
	fg, bg := s.fg, s.bg
	if s.reverse {
		fg, bg = bg, fg
		if fg == "" {
			fg = "var(--bg)"
		}
		if bg == "" {
			bg = "var(--fg)"
		}
	}
	var css []string
	if fg != "" {
		css = append(css, "color:"+fg)
	}
	if bg != "" {
		css = append(css, "background:"+bg)
	}
	if s.bold {
		css = append(css, "font-weight:700")
	}
	if s.faint {
		css = append(css, "opacity:.6")
	}
	if s.italic {
		css = append(css, "font-style:italic")
	}
	if s.underline {
		css = append(css, "text-decoration:underline")
	}
	return strings.Join(css, ";")
}

var basic = []string{"#1e1f24", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#adbac7",
	"#636e7b", "#ff938a", "#6bc46d", "#daaa3f", "#6cb6ff", "#dcbdfb", "#56d4dd", "#cdd9e5"}

func xterm256(n int) string {
	switch {
	case n < 16:
		return basic[n]
	case n < 232:
		n -= 16
		lv := []int{0, 95, 135, 175, 215, 255}
		return fmt.Sprintf("#%02x%02x%02x", lv[n/36], lv[(n/6)%6], lv[n%6])
	}
	g := 8 + (n-232)*10
	return fmt.Sprintf("#%02x%02x%02x", g, g, g)
}

func (s *sgrState) apply(params string) {
	if params == "" {
		params = "0"
	}
	p := strings.Split(params, ";")
	for i := 0; i < len(p); i++ {
		n, _ := strconv.Atoi(p[i])
		switch {
		case n == 0:
			*s = sgrState{}
		case n == 1:
			s.bold = true
		case n == 2:
			s.faint = true
		case n == 3:
			s.italic = true
		case n == 4:
			s.underline = true
		case n == 7:
			s.reverse = true
		case n == 22:
			s.bold, s.faint = false, false
		case n == 23:
			s.italic = false
		case n == 24:
			s.underline = false
		case n == 27:
			s.reverse = false
		case n >= 30 && n <= 37:
			s.fg = basic[n-30]
		case n >= 90 && n <= 97:
			s.fg = basic[n-90+8]
		case n >= 40 && n <= 47:
			s.bg = basic[n-40]
		case n >= 100 && n <= 107:
			s.bg = basic[n-100+8]
		case n == 39:
			s.fg = ""
		case n == 49:
			s.bg = ""
		case (n == 38 || n == 48) && i+1 < len(p):
			var color string
			if p[i+1] == "5" && i+2 < len(p) {
				v, _ := strconv.Atoi(p[i+2])
				color, i = xterm256(v), i+2
			} else if p[i+1] == "2" && i+4 < len(p) {
				r, _ := strconv.Atoi(p[i+2])
				g, _ := strconv.Atoi(p[i+3])
				b, _ := strconv.Atoi(p[i+4])
				color, i = fmt.Sprintf("#%02x%02x%02x", r, g, b), i+4
			}
			if n == 38 {
				s.fg = color
			} else {
				s.bg = color
			}
		}
	}
}

func ansiToHTML(s string) string {
	s = otherRe.ReplaceAllStringFunc(s, func(m string) string {
		if sgrRe.MatchString(m) {
			return m
		}
		return ""
	})
	var b strings.Builder
	var st sgrState
	open := false
	last := 0
	flush := func(text string) {
		if text == "" {
			return
		}
		b.WriteString(html.EscapeString(text))
	}
	for _, loc := range sgrRe.FindAllStringSubmatchIndex(s, -1) {
		flush(s[last:loc[0]])
		last = loc[1]
		if open {
			b.WriteString("</span>")
			open = false
		}
		st.apply(s[loc[2]:loc[3]])
		if css := st.style(); css != "" {
			b.WriteString(`<span style="` + css + `">`)
			open = true
		}
	}
	flush(s[last:])
	if open {
		b.WriteString("</span>")
	}
	return b.String()
}

// terminalPage wraps a frame in a macOS-style terminal window for the screenshot.
func terminalPage(view string, cols int) string {
	return `<!doctype html><meta charset="utf-8"><style>
:root{--bg:#1c1d21;--fg:#d4d7dd}
body{margin:0;padding:32px;background:#f5f5f3}
.term{display:inline-block;background:var(--bg);color:var(--fg);border-radius:12px;overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.25)}
.bar{height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#2a2b30}
.bar i{width:12px;height:12px;border-radius:50%;display:block}
.bar span{flex:1;text-align:center;color:#8b8f97;font:12px -apple-system,BlinkMacSystemFont,sans-serif;margin-right:60px}
pre{margin:0;padding:14px 18px 16px;font:13px/1.38 "SF Mono",Menlo,Monaco,monospace;width:` + strconv.Itoa(cols) + `ch;white-space:pre}
</style><div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>companion tui</span></div><pre>` +
		ansiToHTML(view) + `</pre></div>`
}
