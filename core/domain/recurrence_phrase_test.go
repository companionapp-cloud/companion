package domain

import (
	"testing"
	"time"
)

func TestParseRepeatPhrase(t *testing.T) {
	ref := time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		in   string
		want string // "" means unrecognized
	}{
		// Sub-daily frequency.
		{"every minute", "FREQ=MINUTELY"},
		{"every 5 minutes", "FREQ=MINUTELY;INTERVAL=5"},
		{"every 30 mins", "FREQ=MINUTELY;INTERVAL=30"},
		{"every hour", "FREQ=HOURLY"},
		{"hourly", "FREQ=HOURLY"},
		{"every 5 hours", "FREQ=HOURLY;INTERVAL=5"},
		{"every other hour", "FREQ=HOURLY;INTERVAL=2"},
		{"every 2 hrs", "FREQ=HOURLY;INTERVAL=2"},

		// Plain frequency + synonyms.
		{"every day", "FREQ=DAILY"},
		{"daily", "FREQ=DAILY"},
		{"every week", "FREQ=WEEKLY"},
		{"weekly", "FREQ=WEEKLY"},
		{"every month", "FREQ=MONTHLY"},
		{"monthly", "FREQ=MONTHLY"},
		{"every year", "FREQ=YEARLY"},
		{"annually", "FREQ=YEARLY"},
		{"yearly", "FREQ=YEARLY"},

		// Intervals.
		{"every other day", "FREQ=DAILY;INTERVAL=2"},
		{"every 3 days", "FREQ=DAILY;INTERVAL=3"},
		{"every three days", "FREQ=DAILY;INTERVAL=3"},
		{"every other week", "FREQ=WEEKLY;INTERVAL=2"},
		{"biweekly", "FREQ=WEEKLY;INTERVAL=2"},
		{"fortnightly", "FREQ=WEEKLY;INTERVAL=2"},
		{"every 2 weeks", "FREQ=WEEKLY;INTERVAL=2"},
		{"every other month", "FREQ=MONTHLY;INTERVAL=2"},
		{"quarterly", "FREQ=MONTHLY;INTERVAL=3"},
		{"every 6 months", "FREQ=MONTHLY;INTERVAL=6"},
		{"semiannually", "FREQ=MONTHLY;INTERVAL=6"},
		{"every other year", "FREQ=YEARLY;INTERVAL=2"},
		{"biennially", "FREQ=YEARLY;INTERVAL=2"},

		// Weekday lists.
		{"every monday", "FREQ=WEEKLY;BYDAY=MO"},
		{"mondays", "FREQ=WEEKLY;BYDAY=MO"},
		{"on tuesdays", "FREQ=WEEKLY;BYDAY=TU"},
		{"every mon", "FREQ=WEEKLY;BYDAY=MO"},
		{"every monday and thursday", "FREQ=WEEKLY;BYDAY=MO,TH"},
		{"mondays, wednesdays and fridays", "FREQ=WEEKLY;BYDAY=MO,WE,FR"},
		{"every tue, thu", "FREQ=WEEKLY;BYDAY=TU,TH"},
		{"every other monday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"},
		{"every 2 weeks on monday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"},

		// Weekday shortcuts + ranges.
		{"weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"},
		{"every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"},
		{"every work day", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"},
		{"monday to friday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"},
		{"monday through friday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"},
		{"monday-thursday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH"},
		{"weekends", "FREQ=WEEKLY;BYDAY=SA,SU"},
		{"every weekend", "FREQ=WEEKLY;BYDAY=SA,SU"},
		{"saturday and sunday", "FREQ=WEEKLY;BYDAY=SA,SU"},

		// Ordinal weekday of month.
		{"the first monday of the month", "FREQ=MONTHLY;BYDAY=1MO"},
		{"second tuesday of the month", "FREQ=MONTHLY;BYDAY=2TU"},
		{"the third wednesday of the month", "FREQ=MONTHLY;BYDAY=3WE"},
		{"fourth thursday of every month", "FREQ=MONTHLY;BYDAY=4TH"},
		{"the last friday of the month", "FREQ=MONTHLY;BYDAY=-1FR"},
		{"the first monday of every other month", "FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO"},

		// Day of month.
		{"on the 15th of every month", "FREQ=MONTHLY;BYMONTHDAY=15"},
		{"monthly on the 1st", "FREQ=MONTHLY;BYMONTHDAY=1"},
		{"the 1st and 15th of the month", "FREQ=MONTHLY;BYMONTHDAY=1,15"},
		{"the last day of the month", "FREQ=MONTHLY;BYMONTHDAY=-1"},

		// Yearly calendar date.
		{"every july 4", "FREQ=YEARLY;BYMONTH=7;BYMONTHDAY=4"},
		{"annually on december 25th", "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25"},

		// Bounds.
		{"every day for 10 times", "FREQ=DAILY;COUNT=10"},
		{"every friday until august 1", "FREQ=WEEKLY;BYDAY=FR;UNTIL=20260801T235959Z"},

		// Rejections.
		{"twice a week", ""},
		{"3 times a month", ""},
		{"", ""},
		{"whenever i feel like it", ""},
	}
	for _, tc := range cases {
		got, err := ParseRepeatPhrase(tc.in, ref)
		if err != nil {
			t.Errorf("%q: unexpected error %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q -> %q, want %q", tc.in, got, tc.want)
		}
		// Every recognized rule must be a rule the core actually accepts.
		if got != "" {
			if err := ValidateRepeatRule(&got); err != nil {
				t.Errorf("%q produced invalid rule %q: %v", tc.in, got, err)
			}
		}
	}
}
