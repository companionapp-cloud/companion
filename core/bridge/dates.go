package bridge

import (
	"encoding/json"
	"time"

	"companion/core/dates"
)

// datesParse resolves a natural-language date/time ("next friday at 3pm") into a concrete
// instant (PLAN §6.4). `ref` is the caller's local now (RFC3339, with offset) so relative
// phrases and bare times resolve in the user's timezone; it defaults to the core's now.
// Returns null when nothing date-like is found.
func (c *Core) datesParse(payload []byte) ([]byte, error) {
	var args struct {
		Text string `json:"text"`
		Ref  string `json:"ref"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ref := time.Now()
	if args.Ref != "" {
		if parsed, err := time.Parse(time.RFC3339, args.Ref); err == nil {
			ref = parsed
		}
	}
	res, err := dates.Parse(args.Text, ref)
	if err != nil {
		return nil, err
	}
	if res == nil {
		return json.Marshal(nil)
	}
	return json.Marshal(map[string]any{
		"at":      res.At.Format(time.RFC3339),
		"matched": res.Matched,
	})
}
