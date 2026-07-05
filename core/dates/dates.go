// Package dates parses natural-language date/time expressions ("next friday at 3pm",
// "tomorrow", "in 2 hours") into concrete instants, shared by every platform through the
// bridge (PLAN §6.4 task due/reminder entry). It wraps github.com/olebedev/when — pure Go,
// so it compiles for wasm and gomobile like the rest of core.
package dates

import (
	"time"

	"github.com/olebedev/when"
	"github.com/olebedev/when/rules/common"
	"github.com/olebedev/when/rules/en"
)

// parser is built once with the English + common rule sets.
var parser = newParser()

func newParser() *when.Parser {
	p := when.New(nil)
	p.Add(en.All...)
	p.Add(common.All...)
	return p
}

// Result is a successful parse: the resolved instant plus the substring that matched, so a
// caller can show what was understood ("understood ‘next friday’ as …").
type Result struct {
	At      time.Time `json:"at"`
	Matched string    `json:"matched"`
}

// Parse resolves the first date/time expression in text relative to ref, or nil when none
// is found. ref anchors relative phrases ("tomorrow") — pass the user's local now.
func Parse(text string, ref time.Time) (*Result, error) {
	r, err := parser.Parse(text, ref)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, nil
	}
	return &Result{At: r.Time, Matched: r.Text}, nil
}
