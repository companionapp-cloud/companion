package things

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"companion/core/domain"
)

// A repeating to-do is a hidden template whose rt1_recurrenceRule is an XML property list:
//
//	fu  unit: 16 daily, 256 weekly, 8 monthly, 4 yearly
//	fa  interval
//	of  offsets, each {wd: weekday 0=Sunday, wdo: nth weekday (−1 last), dy: day of month
//	    0-based (−1 last), mo: month 0-based}
//	tp  1 when it repeats after completion rather than on a schedule
//	ts  days an instance starts before its date (≤ 0)
//	rc  total instances ("ends after N"), 0 unlimited
//	ed  end date, Unix seconds (year 4001 means never)
//
// (things-api's recurrence model and the things-cloud-sdk decode it the same way.)

var errBinaryPlist = errors.New("binary property list")

// repeat is a template's rule, converted.
type repeat struct {
	rule            string // an RRULE body, validated by core/domain
	startOffset     int    // ts: days an instance starts before its date (≤ 0)
	afterCompletion bool   // tp=1: approximated as a fixed schedule
}

var weekdays = [7]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}

// convertRule turns a template's rule into an RRULE. created is how many instances Things has
// already made, so an "ends after N" rule counts only what remains; a rule whose end date is
// before now has ended. ok is false, with the reason, when the rule can't be expressed or the
// series is over.
func convertRule(raw []byte, created int64, loc *time.Location, now time.Time) (r repeat, reason string, ok bool) {
	v, err := parsePlist(raw)
	if err != nil {
		return r, "its repeat rule couldn’t be read", false
	}
	d, _ := v.(map[string]any)
	if d == nil {
		return r, "its repeat rule couldn’t be read", false
	}
	parts := []string{}
	var freq string
	switch num(d["fu"]) {
	case 16:
		freq = "DAILY"
	case 256:
		freq = "WEEKLY"
	case 8:
		freq = "MONTHLY"
	case 4:
		freq = "YEARLY"
	default:
		return r, "its repeat unit isn’t one Companion knows", false
	}
	parts = append(parts, "FREQ="+freq)
	if n := num(d["fa"]); n > 1 {
		parts = append(parts, "INTERVAL="+strconv.FormatInt(n, 10))
	}

	offsets, _ := d["of"].([]any)
	var byDay, byMonthDay, byMonth []string
	for _, o := range offsets {
		off, _ := o.(map[string]any)
		if off == nil {
			continue
		}
		wd, hasWD := off["wd"]
		dy, hasDY := off["dy"]
		if mo, ok := off["mo"]; ok && freq == "YEARLY" {
			byMonth = appendUnique(byMonth, strconv.FormatInt(num(mo)+1, 10))
		}
		switch {
		case hasWD && freq != "DAILY":
			w := num(wd)
			if w < 0 || w > 6 {
				continue
			}
			nth := ""
			if n := num(off["wdo"]); n != 0 && freq != "WEEKLY" {
				nth = strconv.FormatInt(n, 10)
			}
			byDay = appendUnique(byDay, nth+weekdays[w])
		case hasDY && (freq == "MONTHLY" || freq == "YEARLY"):
			day := num(dy)
			if day >= 0 {
				day++
			}
			byMonthDay = appendUnique(byMonthDay, strconv.FormatInt(day, 10))
		}
	}
	if len(byDay) > 0 && len(byMonthDay) > 0 {
		// RRULE would intersect the two (a weekday that is also that date); Things means
		// either. Keep the days of the month.
		byDay = nil
	}
	if len(byMonth) > 0 {
		parts = append(parts, "BYMONTH="+strings.Join(byMonth, ","))
	}
	if len(byDay) > 0 {
		sort.SliceStable(byDay, func(i, j int) bool { return weekdayOrder(byDay[i]) < weekdayOrder(byDay[j]) })
		parts = append(parts, "BYDAY="+strings.Join(byDay, ","))
	}
	if len(byMonthDay) > 0 {
		parts = append(parts, "BYMONTHDAY="+strings.Join(byMonthDay, ","))
	}

	if total := num(d["rc"]); total > 0 {
		remaining := total - created
		if remaining <= 0 {
			return r, "its repeat has already ended", false
		}
		parts = append(parts, "COUNT="+strconv.FormatInt(remaining, 10))
	} else if end := num(d["ed"]); end > 0 && end < 32503680000 { // before year 3000
		// The last day is inclusive: repeat until the end of that day where the user is.
		y, m, dd := time.Unix(end, 0).UTC().Date()
		until := time.Date(y, m, dd, 23, 59, 59, 0, loc).UTC()
		if until.Before(now) {
			return r, "its repeat has already ended", false
		}
		parts = append(parts, "UNTIL="+until.Format("20060102T150405Z"))
	}

	rule := strings.Join(parts, ";")
	if err := domain.ValidateRepeatRule(&rule); err != nil {
		return r, "its repeat rule couldn’t be converted", false
	}
	return repeat{rule: rule, startOffset: int(num(d["ts"])), afterCompletion: num(d["tp"]) == 1}, "", true
}

func weekdayOrder(byDay string) int {
	code := strings.TrimLeft(byDay, "-0123456789")
	for i, w := range []string{"MO", "TU", "WE", "TH", "FR", "SA", "SU"} {
		if w == code {
			return i
		}
	}
	return 7
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

// num reads a plist number as an integer (reals truncate), or 0.
func num(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(strings.TrimSpace(n), 10, 64)
		return i
	case bool:
		if n {
			return 1
		}
	}
	return 0
}

// parsePlist decodes an XML property list: dict → map[string]any, array → []any, integer →
// int64, real → float64, string and date → string, true/false → bool, data → []byte.
func parsePlist(b []byte) (any, error) {
	if bytes.HasPrefix(b, []byte("bplist")) {
		return nil, errBinaryPlist
	}
	dec := xml.NewDecoder(bytes.NewReader(b))
	dec.Strict = false
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("plist: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local != "plist" {
			return plistValue(dec, se)
		}
	}
}

func plistValue(dec *xml.Decoder, se xml.StartElement) (any, error) {
	switch se.Name.Local {
	case "dict":
		out := map[string]any{}
		key := ""
		for {
			tok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "key" {
					if key, err = plistText(dec); err != nil {
						return nil, err
					}
					continue
				}
				v, err := plistValue(dec, t)
				if err != nil {
					return nil, err
				}
				out[key] = v
			case xml.EndElement:
				return out, nil
			}
		}
	case "array":
		out := []any{}
		for {
			tok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.StartElement:
				v, err := plistValue(dec, t)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			case xml.EndElement:
				return out, nil
			}
		}
	case "true", "false":
		if err := dec.Skip(); err != nil {
			return nil, err
		}
		return se.Name.Local == "true", nil
	}
	text, err := plistText(dec)
	if err != nil {
		return nil, err
	}
	switch se.Name.Local {
	case "integer":
		n, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
		if err != nil {
			return nil, err
		}
		return n, nil
	case "real":
		f, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return nil, err
		}
		return f, nil
	case "data":
		return base64.StdEncoding.DecodeString(strings.Join(strings.Fields(text), ""))
	default: // string, date, and anything unknown
		return text, nil
	}
}

// plistText reads an element's character data up to its end tag.
func plistText(dec *xml.Decoder) (string, error) {
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return b.String(), nil
		}
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			b.Write(t)
		case xml.EndElement:
			return b.String(), nil
		case xml.StartElement:
			if err := dec.Skip(); err != nil {
				return "", err
			}
		}
	}
}
