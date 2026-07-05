package dates

import (
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	ref := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC) // a Sunday

	res, err := Parse("remind me tomorrow at 3pm", ref)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if res == nil {
		t.Fatal("expected a match for 'tomorrow at 3pm'")
	}
	if res.At.Day() != 6 || res.At.Hour() != 15 {
		t.Errorf("parsed %v, want the 6th at 15:00", res.At)
	}

	// A string with no date yields no result (not an error).
	none, err := Parse("just some text", ref)
	if err != nil {
		t.Fatalf("parse plain text: %v", err)
	}
	if none != nil {
		t.Errorf("expected nil for non-date text, got %+v", none)
	}
}
