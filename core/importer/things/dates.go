package things

import "time"

// Things stores calendar dates — When dates, deadlines, a repeat's next instance — as packed
// integers, year<<16 | month<<12 | day<<7, with no time zone: they are wall-clock dates on the
// user's calendar. Reminder times pack the same way: hour<<26 | minute<<20.

// unpackDate splits a packed date; ok is false for unset or out-of-range values (including
// the year-4001 sentinel templates carry — see isSentinelDate).
func unpackDate(v int64) (y int, m time.Month, d int, ok bool) {
	if v <= 0 {
		return 0, 0, 0, false
	}
	y, m, d = int(v>>16), time.Month((v>>12)&0xF), int((v>>7)&0x1F)
	return y, m, d, y >= 1900 && y < 3000 && m >= time.January && m <= time.December && d >= 1 && d <= 31
}

// isSentinelDate reports the far-future date (4001-01-01) a repeat template stores in its
// deadline to mean "each instance gets a deadline".
func isSentinelDate(v int64) bool { return v>>16 >= 4000 }

// unpackTime splits a packed reminder time.
func unpackTime(v int64) (h, m int, ok bool) {
	if v < 0 {
		return 0, 0, false
	}
	h, m = int(v>>26), int((v>>20)&0x3F)
	return h, m, h < 24 && m < 60
}

// Wall-clock times given to Things' date-only values. A start becomes local midnight, which
// the editor shows as a bare date (This Evening, 6pm). A deadline becomes 5pm — the deadline
// presets' time — so "the day before" and overdue read as they do for tasks made in Companion.
const (
	startHour   = 0
	eveningHour = 18
	dueHour     = 17
)

// at builds the instant for a packed date at a wall-clock time in loc.
func at(packed int64, hour, minute int, loc *time.Location) *time.Time {
	y, m, d, ok := unpackDate(packed)
	if !ok {
		return nil
	}
	t := time.Date(y, m, d, hour, minute, 0, 0, loc)
	return &t
}

// fromUnix converts Things' REAL Unix timestamps (completion, creation), or nil when unset.
func fromUnix(secs float64) *time.Time {
	if secs <= 0 {
		return nil
	}
	whole := int64(secs)
	t := time.Unix(whole, int64((secs-float64(whole))*1e9)).UTC()
	return &t
}
