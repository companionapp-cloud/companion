//go:build !js

package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/agentrt"
	"companion/core/agents"
	"companion/core/llm"
)

// TestFoundationToolModesEval compares how Apple Intelligence handles Companion's tools in each
// tool mode, against the real on-device model:
//
//	lean    — the 14 core tools defined up front (today's default)
//	short   — every tool, with short descriptions
//	full    — every tool defined up front (the reference: does it even fit?)
//	catalog — get_date + search_notes up front; the rest behind call_tool and its menu
//
// Each scenario is a realistic request answered by canned tool results; it passes when the model
// calls the right tool with the right arguments. Opt in with
//
//	COMPANION_FM_HELPER=$PWD/build/companion-fm COMPANION_FM_EVAL=1 go test ./core/bridge -run ToolModesEval -v -timeout 60m
//
// COMPANION_FM_EVAL_TRIALS repeats each scenario (default 1); COMPANION_FM_EVAL_OUT writes the
// raw results as JSON; COMPANION_FM_EVAL_MODES limits the modes (comma-separated).
func TestFoundationToolModesEval(t *testing.T) {
	helper := os.Getenv("COMPANION_FM_HELPER")
	if helper == "" || os.Getenv("COMPANION_FM_EVAL") == "" {
		t.Skip("set COMPANION_FM_HELPER and COMPANION_FM_EVAL=1 to run the Apple Intelligence evaluation")
	}
	trials := 1
	if n, err := strconv.Atoi(os.Getenv("COMPANION_FM_EVAL_TRIALS")); err == nil && n > 0 {
		trials = n
	}
	fm := &agentrt.FoundationModels{HelperPath: helper}

	c, _ := newTestCore(t)
	real := c.toolRegistry() // the product's registry, calendar writes included

	type mode struct {
		name     string
		opts     agents.FoundationOptions
		system   string
		registry func(*llm.Registry) *llm.Registry
	}
	all := func(r *llm.Registry) *llm.Registry { return r }
	modes := []mode{
		{"lean", agents.FoundationOptions{}, foundationSystemPrompt, func(r *llm.Registry) *llm.Registry { return r.Only(foundationTools...) }},
		{"short", foundationShortOptions, foundationSystemPrompt, all},
		{"full", agents.FoundationOptions{}, foundationSystemPrompt, all},
		{"catalog", foundationCatalogOptions, foundationCatalogPrompt, all},
	}
	if only := os.Getenv("COMPANION_FM_EVAL_MODES"); only != "" {
		var keep []mode
		for _, m := range modes {
			if strings.Contains(","+only+",", ","+m.name+",") {
				keep = append(keep, m)
			}
		}
		modes = keep
	}

	type result struct {
		Mode          string        `json:"mode"`
		Scenario      string        `json:"scenario"`
		Trial         int           `json:"trial"`
		Pass          bool          `json:"pass"`
		Why           string        `json:"why,omitempty"`
		Error         string        `json:"error,omitempty"`
		SetupTokens   int           `json:"setupTokens"`
		ContextTokens int           `json:"contextTokens"`
		Seconds       float64       `json:"seconds"`
		Calls         []evalCall    `json:"calls"`
		Trace         []string      `json:"trace,omitempty"`
		Reply         string        `json:"reply"`
		duration      time.Duration `json:"-"`
	}
	var results []result

	for _, m := range modes {
		for _, sc := range evalScenarios {
			for trial := 1; trial <= trials; trial++ {
				rec := &evalRecorder{}
				reg := cannedRegistry(m.registry(real), rec)
				p := fm.Provider(m.opts).(*agentrt.FoundationProvider)
				r := result{Mode: m.name, Scenario: sc.name, Trial: trial}
				var mu sync.Mutex
				p.Observe = func(kind string, ev map[string]any) {
					mu.Lock()
					defer mu.Unlock()
					switch kind {
					case "usage":
						r.SetupTokens = toInt(ev["setupTokens"])
					case "done":
						r.ContextTokens = toInt(ev["contextTokens"])
					case "trace":
						r.Trace = append(r.Trace, fmt.Sprintf("%v(%v) → %v", ev["tool"], ev["input"], ev["output"]))
					}
				}
				engine := &llm.Engine{Provider: p, Registry: reg, System: m.system, Model: "apple-on-device"}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
				start := time.Now()
				out, err := engine.Run(ctx, []llm.Message{{Role: llm.RoleUser, Text: sc.prompt}}, nil, nil)
				cancel()
				r.duration = time.Since(start)
				r.Seconds = r.duration.Seconds()
				r.Calls = rec.list()
				if len(out) > 0 {
					r.Reply = out[len(out)-1].Text
				}
				if err != nil {
					r.Error = err.Error()
					r.Why = "error"
				} else {
					r.Pass, r.Why = sc.check(r.Calls)
				}
				t.Logf("%-8s %-18s pass=%-5v setup=%-5d ctx=%-5d %5.1fs calls=%s %s", m.name, sc.name, r.Pass, r.SetupTokens, r.ContextTokens, r.Seconds, callNames(r.Calls), r.Why)
				if !r.Pass && len(r.Trace) > 0 {
					t.Logf("         trace: %s", strings.Join(r.Trace, " | "))
				}
				results = append(results, r)
			}
		}
	}

	// Summary per mode.
	t.Log("")
	t.Logf("%-8s %6s %10s %10s %8s", "mode", "pass", "setup tok", "ctx tok", "avg s")
	for _, m := range modes {
		var n, pass, setup, ctxTok int
		var secs float64
		for _, r := range results {
			if r.Mode != m.name {
				continue
			}
			n++
			if r.Pass {
				pass++
			}
			setup += r.SetupTokens
			ctxTok += r.ContextTokens
			secs += r.Seconds
		}
		if n == 0 {
			continue
		}
		t.Logf("%-8s %3d/%-3d %10d %10d %8.1f", m.name, pass, n, setup/n, ctxTok/n, secs/float64(n))
	}

	if path := os.Getenv("COMPANION_FM_EVAL_OUT"); path != "" {
		b, _ := json.MarshalIndent(results, "", "  ")
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Errorf("write results: %v", err)
		}
	}
}

// --- recording + canned results ------------------------------------------------------

type evalCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
	Raw  string         `json:"raw"`
}

type evalRecorder struct {
	mu    sync.Mutex
	calls []evalCall
}

func (r *evalRecorder) add(name string, raw json.RawMessage) {
	var args map[string]any
	_ = json.Unmarshal(raw, &args)
	r.mu.Lock()
	r.calls = append(r.calls, evalCall{Name: name, Args: args, Raw: string(raw)})
	r.mu.Unlock()
}

func (r *evalRecorder) list() []evalCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]evalCall(nil), r.calls...)
}

// cannedRegistry keeps each tool's real spec and write flag but answers from fixed data, so the
// evaluation measures tool choice, not the store.
func cannedRegistry(src *llm.Registry, rec *evalRecorder) *llm.Registry {
	out := llm.NewRegistry()
	for _, spec := range src.Specs() {
		name := spec.Name
		out.Add(llm.Tool{Spec: spec, Write: src.IsWrite(name), Handler: func(ctx context.Context, args json.RawMessage) (string, error) {
			rec.add(name, args)
			return cannedResult(name, string(args)), nil
		}})
	}
	return out
}

func cannedResult(name, args string) string {
	low := strings.ToLower(args)
	switch name {
	case "get_date":
		// The real get_date answer, at a fixed moment: Monday 23 November 2026, 9am in Toronto.
		b, _ := json.Marshal(llm.DateFacts(time.Date(2026, 11, 23, 9, 0, 0, 0, time.FixedZone("EST", -5*3600))))
		return string(b)
	case "search_notes":
		switch {
		case strings.Contains(low, "lisbon") || strings.Contains(low, "trip"):
			return `[{"id":"note-trip","title":"Lisbon trip plan","snippet":"Flights booked for Dec 12…"}]`
		case strings.Contains(low, "grocer"):
			return `[{"id":"note-groceries","title":"Groceries","snippet":"milk, eggs…"}]`
		}
		return `[{"id":"note-trip","title":"Lisbon trip plan","snippet":"Flights booked for Dec 12…"},{"id":"note-groceries","title":"Groceries","snippet":"milk, eggs…"}]`
	case "get_note":
		if strings.Contains(low, "groceries") {
			return `{"id":"note-groceries","title":"Groceries","contentMd":"- milk\n- eggs\n- coffee"}`
		}
		return `{"id":"note-trip","title":"Lisbon trip plan","contentMd":"Flights booked for Dec 12. Hotel in Alfama for 5 nights. Still to do: book a fado dinner and get travel insurance."}`
	case "list_tasks":
		return `[{"id":"task-dentist","title":"Dentist appointment","dueAt":"2026-11-25","status":"open"},{"id":"task-taxes","title":"File taxes","dueAt":"2027-04-30","status":"open"}]`
	case "get_task":
		return `{"id":"task-dentist","title":"Dentist appointment","dueAt":"2026-11-25","status":"open"}`
	case "list_events":
		return `[{"id":"ev-standup","title":"Team standup","start":"2026-11-24T10:00:00-05:00","end":"2026-11-24T10:15:00-05:00"},{"id":"ev-lunch","title":"Lunch with Sam","start":"2026-11-24T12:30:00-05:00","end":"2026-11-24T13:30:00-05:00"}]`
	case "list_projects":
		return `[{"id":"proj-house","title":"House renovation"},{"id":"proj-lisbon","title":"Lisbon trip"}]`
	case "list_areas":
		return `[{"id":"area-health","title":"Health"},{"id":"area-work","title":"Work"}]`
	case "list_lists":
		return `[{"id":"list-errands","title":"Errands"}]`
	case "list_calendars":
		return `[{"id":"cal-personal","title":"Personal","writable":true}]`
	case "list_canvases":
		return `[{"id":"canvas-roadmap","title":"Roadmap"}]`
	case "get_canvas":
		return `{"id":"canvas-roadmap","title":"Roadmap","cards":["Q1: launch sync","Q2: mobile app","Q3: Apple Intelligence"]}`
	case "get_backlinks":
		return `[{"type":"note","id":"note-packing","title":"Packing list"},{"type":"task","id":"task-insurance","title":"Buy travel insurance"}]`
	case "read_from_internet":
		return `{"url":"https://example.com/article","text":"The article argues that small on-device models are good enough for most personal assistant tasks when tools are well designed."}`
	case "read_from_google":
		return `[{"title":"Example","url":"https://example.com/article"}]`
	case "create_task", "update_task":
		return `{"ok":true,"id":"task-new","wikilink":"[[task:task-new]]"}`
	case "create_note", "update_note":
		return `{"ok":true,"id":"note-new","wikilink":"[[note:note-new]]"}`
	case "create_event", "update_event":
		return `{"ok":true,"id":"ev-new"}`
	case "create_canvas", "update_canvas":
		return `{"ok":true,"id":"canvas-new"}`
	}
	if strings.HasPrefix(name, "render_") {
		return `{"ok":true,"shown":true}`
	}
	return `[]`
}

func toInt(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

func callNames(calls []evalCall) string {
	names := make([]string, 0, len(calls))
	for _, c := range calls {
		names = append(names, c.Name)
	}
	return "[" + strings.Join(names, ",") + "]"
}

// --- scenarios -------------------------------------------------------------------------

type evalScenario struct {
	name   string
	prompt string
	check  func(calls []evalCall) (bool, string)
}

func callsNamed(calls []evalCall, name string) []evalCall {
	var out []evalCall
	for _, c := range calls {
		if c.Name == name {
			out = append(out, c)
		}
	}
	return out
}

// expect passes when some call to tool satisfies every predicate on its arguments.
func expect(tool string, preds ...func(evalCall) bool) func([]evalCall) (bool, string) {
	return func(calls []evalCall) (bool, string) {
		got := callsNamed(calls, tool)
		if len(got) == 0 {
			return false, "no " + tool
		}
		for _, c := range got {
			ok := true
			for _, p := range preds {
				if !p(c) {
					ok = false
					break
				}
			}
			if ok {
				return true, ""
			}
		}
		return false, tool + " args wrong: " + got[len(got)-1].Raw
	}
}

func argHas(key, sub string) func(evalCall) bool {
	return func(c evalCall) bool {
		v, ok := c.Args[key]
		if !ok {
			return false
		}
		b, _ := json.Marshal(v)
		return strings.Contains(strings.ToLower(string(b)), strings.ToLower(sub))
	}
}

func rawHas(sub string) func(evalCall) bool {
	return func(c evalCall) bool { return strings.Contains(strings.ToLower(c.Raw), strings.ToLower(sub)) }
}

func argSet(key string) func(evalCall) bool {
	return func(c evalCall) bool {
		v, ok := c.Args[key]
		if !ok || v == nil {
			return false
		}
		if a, isArr := v.([]any); isArr {
			return len(a) > 0
		}
		return fmt.Sprint(v) != ""
	}
}

// The canned date is Monday 23 November 2026.
var evalScenarios = []evalScenario{
	{"remind-rent", "Remind me to pay rent on Friday, and an hour before.", func(calls []evalCall) (bool, string) {
		if n := len(callsNamed(calls, "create_task")); n > 1 {
			return false, fmt.Sprintf("%d tasks for one reminder", n)
		}
		return expect("create_task", argHas("title", "rent"), argHas("dueAt", "2026-11-27"), argSet("reminders"))(calls)
	}},
	{"add-milk", "Add a task to buy milk.", expect("create_task", argHas("title", "milk"))},
	{"calendar-tomorrow", "What's on my calendar tomorrow?", expect("list_events", argHas("from", "2026-11-24"))},
	{"what-tasks", "What tasks do I have?", expect("list_tasks")},
	{"summarize-note", "Summarize my Lisbon trip note.", expect("get_note", argHas("id", "note-trip"))},
	{"create-note", "Create a note called Packing list with passport, charger and adapter.", expect("create_note", argHas("title", "packing"), rawHas("passport"))},
	{"complete-task", "Mark the dentist task as done.", expect("update_task", argHas("id", "task-dentist"), argSet("status"))},
	{"file-note", "File my Lisbon trip note under the Lisbon trip project.", expect("update_note", argHas("id", "note-trip"), argHas("projectId", "proj-lisbon"))},
	{"book-haircut", "Book time on my calendar Thursday 2-3pm for a haircut.", expect("create_event", rawHas("haircut"), rawHas("2026-11-26"))},
	{"list-projects", "Which projects do I have?", expect("list_projects")},
	{"show-note", "Show me my groceries note.", func(calls []evalCall) (bool, string) {
		if ok, _ := expect("render_note", argHas("id", "note-groceries"))(calls); ok {
			return true, ""
		}
		return expect("get_note", argHas("id", "note-groceries"))(calls)
	}},
	{"task-in-project", "Add 'call plumber' to the House renovation project.", expect("create_task", argHas("title", "plumber"), argHas("projectId", "proj-house"))},
	{"read-canvas", "What's on my Roadmap canvas?", expect("get_canvas", argHas("id", "canvas-roadmap"))},
	{"task-on-list", "Put 'buy stamps' on my Errands list.", expect("create_task", argHas("title", "stamps"), argHas("listId", "list-errands"))},
	{"read-url", "Read https://example.com/article and tell me what it says.", expect("read_from_internet", argHas("url", "example.com/article"))},
	{"move-task", "Move my dentist task to next Monday.", expect("update_task", argHas("id", "task-dentist"), argHas("dueAt", "2026-11-30"))},
	{"backlinks", "Which notes link to my Lisbon trip plan?", expect("get_backlinks", argHas("id", "note-trip"))},
	{"chit-chat", "Hi, how are you?", func(calls []evalCall) (bool, string) {
		for _, c := range calls {
			if strings.HasPrefix(c.Name, "create_") || strings.HasPrefix(c.Name, "update_") {
				return false, "wrote " + c.Name
			}
		}
		return true, ""
	}},
	{"list-areas", "What areas of responsibility do I have?", expect("list_areas")},
	{"task-in-area", "Create a task to renew my passport, due December 15, in my Health area.", expect("create_task", argHas("title", "passport"), argHas("dueAt", "2026-12-15"), argHas("areaId", "area-health"))},
}
