package llm

import (
	"testing"
	"time"
)

func TestDateFacts(t *testing.T) {
	// Monday 23 November 2026.
	f := DateFacts(time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC))
	coming := f["comingDays"].(map[string]string)
	want := map[string]string{"tomorrow": "2026-11-24", "friday": "2026-11-27", "monday": "2026-11-30", "sunday": "2026-11-29"}
	for k, v := range want {
		if coming[k] != v {
			t.Errorf("%s = %s, want %s", k, coming[k], v)
		}
	}
	if f["nextWeekStart"] != "2026-11-30" || f["year"] != 2026 || f["weekday"] != "Monday" {
		t.Errorf("facts = %v", f)
	}
	// On a Sunday, next week starts tomorrow.
	if got := DateFacts(time.Date(2026, 11, 29, 9, 0, 0, 0, time.UTC))["nextWeekStart"]; got != "2026-11-30" {
		t.Errorf("Sunday's next week = %v", got)
	}
}
