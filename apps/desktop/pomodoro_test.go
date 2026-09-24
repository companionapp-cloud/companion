package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func running(id string, endsAt time.Time) *pomodoroRow {
	return &pomodoroRow{ID: id, TaskTitle: "Write report", EndsAt: endsAt}
}

func last(id, outcome string, tasksDone int) *pomodoroRow {
	return &pomodoroRow{ID: id, TaskTitle: "Write report", Outcome: outcome, TasksDone: tasksDone}
}

func TestPomodoroLabel(t *testing.T) {
	now := time.Date(2026, 9, 24, 9, 0, 0, 0, time.UTC)
	brk := now.Add(4*time.Minute + 30*time.Second)
	for _, tc := range []struct {
		name string
		s    pomodoroSnapshot
		want string
	}{
		{"idle", pomodoroSnapshot{}, ""},
		{"running", pomodoroSnapshot{Running: running("a", now.Add(24*time.Minute+500*time.Millisecond))}, "24:01"},
		{"running out", pomodoroSnapshot{Running: running("a", now.Add(-time.Second))}, "0:00"},
		{"break", pomodoroSnapshot{BreakEndsAt: &brk}, "Break 4:30"},
		{"paused", pomodoroSnapshot{Running: &pomodoroRow{ID: "a", EndsAt: now.Add(time.Hour), PausedAt: &now, RemainingSec: 12*60 + 34}}, "⏸ 12:34"},
	} {
		if got := pomodoroLabel(tc.s, now); got != tc.want {
			t.Errorf("%s: label = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestPomodoroTransitions(t *testing.T) {
	now := time.Date(2026, 9, 24, 9, 0, 0, 0, time.UTC)
	past := now.Add(-time.Second)
	future := now.Add(time.Minute)
	runningA := pomodoroSnapshot{Running: running("a", now)}

	for _, tc := range []struct {
		name       string
		prev, next pomodoroSnapshot
		want       []string // notification titles
	}{
		{"ran out with nothing finished", runningA, pomodoroSnapshot{Last: last("a", "expired", 0)}, []string{"Time’s up"}},
		{"ran out having finished tasks", runningA, pomodoroSnapshot{Last: last("a", "completed", 2), BreakEndsAt: &future}, []string{"Pomodoro done"}},
		{"moving to the next task is no news", runningA, pomodoroSnapshot{Running: running("a", now)}, nil},
		{"taking a break early is the user's own doing", pomodoroSnapshot{Running: &pomodoroRow{ID: "a", PausedAt: &now}}, pomodoroSnapshot{Last: last("a", "completed", 1), BreakEndsAt: &future}, nil},
		{"cancelled is the user's own doing", runningA, pomodoroSnapshot{Last: last("a", "cancelled", 0)}, nil},
		{"break ended on its own", pomodoroSnapshot{BreakEndsAt: &past}, pomodoroSnapshot{}, []string{"Break’s over"}},
		{"break skipped", pomodoroSnapshot{BreakEndsAt: &future}, pomodoroSnapshot{}, nil},
		{"launch with nothing before", pomodoroSnapshot{}, pomodoroSnapshot{Last: last("a", "expired", 0)}, nil},
	} {
		got := pomodoroTransitions(tc.prev, tc.next, now)
		if len(got) != len(tc.want) {
			t.Errorf("%s: %d notices %+v, want %v", tc.name, len(got), got, tc.want)
			continue
		}
		for i := range got {
			if got[i].title != tc.want[i] {
				t.Errorf("%s: notice %d = %q, want %q", tc.name, i, got[i].title, tc.want[i])
			}
		}
	}
}

func TestPomodoroEnabledIsOffByDefaultAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pomodoro.json")
	var invoked []string
	invoke := func(method string, _ []byte) ([]byte, error) {
		invoked = append(invoked, method)
		return []byte(`{}`), nil
	}
	p := newPomodoroTimer(invoke, path)
	if p.isEnabled() {
		t.Fatal("pomodoros should start switched off")
	}
	var events []string
	p.emit = func(name string, payload []byte) { events = append(events, name+" "+string(payload)) }

	rec := httptest.NewRecorder()
	p.handleEnabled(rec, httptest.NewRequest(http.MethodPost, "/pomodoro/enabled", strings.NewReader(`{"enabled":true}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"enabled":true`) {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body)
	}
	if len(events) != 1 || events[0] != `pomodoro.enabled {"enabled":true}` {
		t.Errorf("events = %v", events)
	}
	if !newPomodoroTimer(invoke, path).isEnabled() {
		t.Error("the setting should survive a restart")
	}

	// Switched off, it gives up the running pomodoro and the menu bar goes back to plain.
	p.state = pomodoroSnapshot{Running: running("a", time.Now().Add(time.Minute))}
	if err := p.setEnabled(false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if p.isEnabled() {
		t.Error("isEnabled() = true after switching off")
	}
	if len(invoked) != 1 || invoked[0] != "pomodoro.cancel" {
		t.Errorf("invoked = %v, want the running pomodoro cancelled", invoked)
	}

	rec = httptest.NewRecorder()
	p.handleEnabled(rec, httptest.NewRequest(http.MethodGet, "/pomodoro/enabled", nil))
	if !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Errorf("GET = %s", rec.Body)
	}
}
