package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The menu bar panel: a Control Center–style set of glass modules under the menu bar item
// (packages/app PomodoroView, the ?pomodoro=1 route) — the pomodoro timer with the tool on, a
// compact layout without it, and quick capture in both. The page sizes the panel's height to
// its layout (setPomodoroGlass); this is the width of the grid and the tallest layout.
const (
	pomodoroWindowName   = "pomodoro"
	pomodoroWindowWidth  = 318
	pomodoroWindowHeight = 432
	// A click on the menu bar item first takes focus from the panel, which hides it; the click
	// that follows must not bring it straight back.
	pomodoroReopenGuard = 300 * time.Millisecond
)

// pomodoroTimer is the desktop half of pomodoros: the core keeps the rows and decides how each
// ends (core/bridge/pomodoro.go); this counts down in the menu bar beside the Companion mark,
// owns the timer window that clicking the menu bar item brings up, and posts a notification
// when a pomodoro runs out or its break ends — the moments nobody may be looking.
//
// Pomodoros are an opt-in tool, switched on per device in Settings › Tools and off by default:
// while off the menu bar item is just the Companion mark, the timer window stays shut and
// nothing is announced, and the webview hides every task's stopwatch. The choice lives in a small
// JSON file beside the database (like the shortcuts), since the menu bar needs it before any
// webview has loaded.
//
// It keeps the last state the core reported and re-reads it when an event says it may have
// moved (a pomodoro started or settled, a task finished anywhere, a sync) and when a countdown
// reaches zero; in between it only redraws the label.
type pomodoroTimer struct {
	invoke func(method string, payload []byte) ([]byte, error)
	notify func(id, title, body string)
	// openCapture brings up the quick-capture panel (main.go), from the panel's Quick Capture tile.
	openCapture func()
	// openApp brings Companion's main window forward, from the panel's Open Companion button.
	openApp func()
	// emit announces a change of the enabled setting to every webview (the core's event stream).
	emit      func(name string, payload []byte)
	prefsPath string

	tray     *application.SystemTray
	window   *application.WebviewWindow
	hiddenAt time.Time // when the panel last put itself away (guarded by mu)
	menu     *application.Menu
	menuItem *application.MenuItem

	refreshCh chan struct{}

	mu      sync.Mutex
	enabled bool
	state   pomodoroSnapshot
	// label is what the menu bar shows now, so an unchanged second skips the redraw.
	label string
}

// pomodoroSnapshot is the part of the core's pomodoro.state this side needs.
type pomodoroSnapshot struct {
	Running     *pomodoroRow `json:"running"`
	BreakEndsAt *time.Time   `json:"breakEndsAt"`
	Last        *pomodoroRow `json:"last"`
}

type pomodoroRow struct {
	ID        string    `json:"id"`
	TaskTitle string    `json:"taskTitle"`
	EndsAt    time.Time `json:"endsAt"`
	Outcome   string    `json:"outcome"`
	TasksDone int       `json:"tasksDone"`
	// PausedAt is set while the clock is stopped; RemainingSec is the time left then.
	PausedAt     *time.Time `json:"pausedAt"`
	RemainingSec int        `json:"remainingSec"`
}

// pomodoroEnabledEvent tells every window the tool was switched on or off; its payload is
// {"enabled": bool}.
const pomodoroEnabledEvent = "pomodoro.enabled"

// pomodoroPrefs is the on-disk shape of the setting.
type pomodoroPrefs struct {
	Enabled bool `json:"enabled"`
}

func pomodoroPrefsPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "pomodoro.json")
}

func newPomodoroTimer(invoke func(string, []byte) ([]byte, error), prefsPath string) *pomodoroTimer {
	p := &pomodoroTimer{
		invoke: invoke, notify: func(string, string, string) {}, emit: func(string, []byte) {},
		prefsPath: prefsPath, refreshCh: make(chan struct{}, 1),
	}
	var prefs pomodoroPrefs
	if data, err := os.ReadFile(prefsPath); err == nil && json.Unmarshal(data, &prefs) == nil {
		p.enabled = prefs.Enabled
	}
	return p
}

func (p *pomodoroTimer) isEnabled() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.enabled
}

// setEnabled switches the tool on or off and remembers it. Switching it off gives up a pomodoro
// that is running — there'd be nothing left to show it — and puts the timer away.
func (p *pomodoroTimer) setEnabled(on bool) error {
	p.mu.Lock()
	if p.enabled == on {
		p.mu.Unlock()
		return nil
	}
	data, _ := json.Marshal(pomodoroPrefs{Enabled: on})
	if err := os.WriteFile(p.prefsPath, data, 0o600); err != nil {
		p.mu.Unlock()
		return err
	}
	p.enabled = on
	p.mu.Unlock()

	if !on {
		// The panel stays (it switches to its layout without the timer); the pomodoro doesn't.
		if _, err := p.invoke("pomodoro.cancel", nil); err != nil {
			log.Printf("pomodoro: cancel on disable: %v", err)
		}
	}
	p.syncMenu()
	payload, _ := json.Marshal(pomodoroPrefs{Enabled: on})
	p.emit(pomodoroEnabledEvent, payload)
	p.requestRefresh()
	return nil
}

// attachMenu hands over the menu bar's "Pomodoro Timer" item, shown only while the tool is on.
func (p *pomodoroTimer) attachMenu(menu *application.Menu, item *application.MenuItem) {
	p.menu, p.menuItem = menu, item
	p.syncMenu()
}

func (p *pomodoroTimer) syncMenu() {
	if p.menuItem == nil {
		return
	}
	p.menuItem.SetHidden(!p.isEnabled())
	if p.menu != nil {
		p.menu.Update()
	}
}

// handleEnabled serves /pomodoro/enabled: GET reads the setting, POST {"enabled": bool} sets it
// (Settings › Tools).
func (p *pomodoroTimer) handleEnabled(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var body pomodoroPrefs
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<10))
		if err != nil || json.Unmarshal(data, &body) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if err := p.setEnabled(body.Enabled); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pomodoroPrefs{Enabled: p.isEnabled()})
}

// OnEvent watches the core's event stream (see eventFanout) for anything that may move the
// timer. It runs on the emitting goroutine, possibly mid-invoke, so it only signals.
func (p *pomodoroTimer) OnEvent(name string, _ []byte) {
	switch name {
	case "pomodoro.changed", "tasks.changed", "data.changed":
		p.requestRefresh()
	}
}

func (p *pomodoroTimer) requestRefresh() {
	select {
	case p.refreshCh <- struct{}{}:
	default:
	}
}

// start creates the (hidden) timer window, hooks the menu bar item, and runs the countdown.
func (p *pomodoroTimer) start(app *application.App, tray *application.SystemTray) {
	p.tray = tray
	p.window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:          pomodoroWindowName,
		Title:         "Pomodoro",
		Width:         pomodoroWindowWidth,
		Height:        pomodoroWindowHeight,
		DisableResize: true,
		// No title bar, no traffic lights and no panel: a fully transparent window whose page
		// lays out Control Center's modules, each on its own native glass (setPomodoroGlass).
		// The page's own background is cleared too (apps/desktop/frontend main.tsx).
		Frameless:        true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		URL:              "/?pomodoro=1",
		// Loaded up front so it is ready the moment the menu bar item is clicked.
		Hidden: true,
		// Esc puts it away, like any menu bar extra.
		HideOnEscape: true,
		Mac: application.MacWindow{
			Backdrop:      application.MacBackdropTransparent,
			DisableShadow: true,
		},
	})
	// Closing it puts it away; the menu bar item brings it back.
	p.window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		p.hide()
	})
	// Clicking anywhere else puts it away, like Control Center.
	p.window.OnWindowEvent(events.Common.WindowLostFocus, func(*application.WindowEvent) {
		p.hide()
	})
	go p.run()
}

// hide puts the panel away, remembering when (see pomodoroReopenGuard).
func (p *pomodoroTimer) hide() {
	if p.window == nil || !p.window.IsVisible() {
		return
	}
	p.window.Hide()
	p.mu.Lock()
	p.hiddenAt = time.Now()
	p.mu.Unlock()
}

// toggleWindow is the menu bar item's click: it drops the panel down, or puts it away.
func (p *pomodoroTimer) toggleWindow() {
	if p.window == nil {
		return
	}
	if p.window.IsVisible() {
		p.hide()
		return
	}
	p.mu.Lock()
	justHidden := time.Since(p.hiddenAt) < pomodoroReopenGuard
	p.mu.Unlock()
	if justHidden {
		// This very click took focus from the panel and hid it: leave it hidden.
		return
	}
	p.showWindow()
}

// showWindow drops the panel down just under the menu bar item.
func (p *pomodoroTimer) showWindow() {
	if p.window == nil {
		return
	}
	if p.window.IsVisible() {
		presentPomodoroPanel(p.window)
		return
	}
	preparePomodoroPanel(p.window)
	if p.tray != nil {
		if err := p.tray.PositionWindow(p.window, 6); err != nil {
			log.Printf("pomodoro: position window: %v", err)
		}
	}
	presentPomodoroPanel(p.window)
}

// pomodoroGlassRect is one module's glass: its box in the page (points, origin top-left) and
// corner radius.
type pomodoroGlassRect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
	R float64 `json:"r"`
}

// pomodoroGlassLayout is what the panel's page reports: the height its layout needs, and the
// modules to put glass under.
type pomodoroGlassLayout struct {
	Height float64             `json:"height"`
	Rects  []pomodoroGlassRect `json:"rects"`
}

// handleGlass serves POST /pomodoro/glass: the panel's page reporting its height and where its
// modules sit, so the panel fits the layout and each module gets native glass under it. A dozen
// modules at most; anything larger isn't this page.
func (p *pomodoroTimer) handleGlass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var layout pomodoroGlassLayout
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<10))
	if err != nil || json.Unmarshal(data, &layout) != nil || len(layout.Rects) > 32 ||
		layout.Height < 0 || layout.Height > 2*pomodoroWindowHeight {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if p.window != nil {
		setPomodoroGlass(p.window, layout.Height, layout.Rects)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleOpenApp serves POST /pomodoro/open: the panel's Open Companion button. The panel puts
// itself away and the main window comes forward, as the menu's Open Companion does.
func (p *pomodoroTimer) handleOpenApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p.hide()
	if p.openApp != nil {
		p.openApp()
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCapture serves POST /pomodoro/capture: the panel's Quick Capture tile. The panel puts
// itself away and the quick-capture panel takes its place.
func (p *pomodoroTimer) handleCapture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p.hide()
	if p.openCapture != nil {
		p.openCapture()
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleShow serves POST /pomodoro/show: a task's stopwatch asking for the timer window.
func (p *pomodoroTimer) handleShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p.showWindow()
	w.WriteHeader(http.StatusNoContent)
}

func (p *pomodoroTimer) run() {
	p.refresh()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	// A safety net for anything that moves the state without an event reaching this process.
	resync := time.NewTicker(time.Minute)
	defer resync.Stop()
	for {
		select {
		case <-p.refreshCh:
			p.refresh()
		case <-resync.C:
			p.refresh()
		case now := <-tick.C:
			if p.due(now) {
				p.refresh()
			} else {
				p.draw(now)
			}
		}
	}
}

// due reports whether a countdown has reached zero, so the core should settle it.
func (p *pomodoroTimer) due(now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state.Running != nil {
		// A stopped clock never runs out.
		return p.state.Running.PausedAt == nil && !now.Before(p.state.Running.EndsAt)
	}
	return p.state.BreakEndsAt != nil && !now.Before(*p.state.BreakEndsAt)
}

// refresh reads the state from the core, announces how anything that just ended ended, and
// redraws.
func (p *pomodoroTimer) refresh() {
	out, err := p.invoke("pomodoro.state", nil)
	if err != nil {
		log.Printf("pomodoro: state: %v", err)
		return
	}
	var next pomodoroSnapshot
	if err := json.Unmarshal(out, &next); err != nil {
		log.Printf("pomodoro: decode state: %v", err)
		return
	}
	now := time.Now()
	p.mu.Lock()
	prev := p.state
	p.state = next
	enabled := p.enabled
	p.mu.Unlock()

	if enabled {
		for _, n := range pomodoroTransitions(prev, next, now) {
			p.notify(n.id, n.title, n.body)
		}
	}
	p.draw(now)
}

type pomodoroNotice struct{ id, title, body string }

// pomodoroTransitions works out what to tell the user about the move from prev to next: a
// pomodoro whose clock ran out (it counted, and the break is on — or nothing was finished, and it
// didn't), or a break that ended on its own. Cancelling, taking a break early (which only a
// stopped clock offers) and skipping the break are things the user just did, so they pass
// without a notification.
func pomodoroTransitions(prev, next pomodoroSnapshot, now time.Time) []pomodoroNotice {
	var out []pomodoroNotice
	if prev.Running != nil && prev.Running.PausedAt == nil && (next.Running == nil || next.Running.ID != prev.Running.ID) &&
		next.Last != nil && next.Last.ID == prev.Running.ID {
		switch next.Last.Outcome {
		case "completed":
			tasks := "1 task"
			if next.Last.TasksDone != 1 {
				tasks = fmt.Sprintf("%d tasks", next.Last.TasksDone)
			}
			out = append(out, pomodoroNotice{
				id:    "pomodoro:" + prev.Running.ID + ":completed",
				title: "Pomodoro done",
				body:  fmt.Sprintf("%s finished — that one counts. Take a 5-minute break.", tasks),
			})
		case "expired":
			out = append(out, pomodoroNotice{
				id:    "pomodoro:" + prev.Running.ID + ":expired",
				title: "Time’s up",
				body:  "Nothing was finished, so this pomodoro doesn’t count. Start another when you’re ready.",
			})
		}
	}
	if prev.BreakEndsAt != nil && next.BreakEndsAt == nil && next.Running == nil && !now.Before(*prev.BreakEndsAt) {
		out = append(out, pomodoroNotice{
			id:    "pomodoro:break:" + prev.BreakEndsAt.UTC().Format(time.RFC3339),
			title: "Break’s over",
			body:  "Pick your next task and start a pomodoro.",
		})
	}
	return out
}

// draw puts the countdown in the menu bar: the focus time left while a pomodoro runs, the break
// left during a break, nothing otherwise (or while the tool is off).
func (p *pomodoroTimer) draw(now time.Time) {
	p.mu.Lock()
	label := ""
	if p.enabled {
		label = pomodoroLabel(p.state, now)
	}
	changed := label != p.label
	p.label = label
	p.mu.Unlock()
	if changed && p.tray != nil {
		p.tray.SetLabel(label)
	}
}

func pomodoroLabel(s pomodoroSnapshot, now time.Time) string {
	switch {
	case s.Running != nil && s.Running.PausedAt != nil:
		// Stopped: the time left holds still.
		return "⏸ " + countdown(time.Duration(s.Running.RemainingSec)*time.Second)
	case s.Running != nil:
		return countdown(s.Running.EndsAt.Sub(now))
	case s.BreakEndsAt != nil:
		return "Break " + countdown(s.BreakEndsAt.Sub(now))
	default:
		return ""
	}
}

// countdown renders a duration as m:ss, rounding up so the label reads 0:00 only at the end.
func countdown(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	secs := int((d + time.Second - 1) / time.Second)
	return fmt.Sprintf("%d:%02d", secs/60, secs%60)
}

// eventFanout hands every core event to each handler in turn: the webview's SSE stream and the
// in-process listeners (the pomodoro timer) alike.
type eventFanout []interface {
	OnEvent(name string, payload []byte)
}

func (f eventFanout) OnEvent(name string, payload []byte) {
	for _, h := range f {
		h.OnEvent(name, payload)
	}
}
