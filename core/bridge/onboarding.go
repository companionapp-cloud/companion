package bridge

import (
	"encoding/json"

	"companion/core/store"
)

// onboardingChangedEvent tells the UI its settled-tour list changed locally. Rows pulled by a
// sync arrive with the bulk data.changed every sync emits.
const onboardingChangedEvent = "onboarding.changed"

// onboardingList returns every tour the user has settled: one row per tour version finished or
// skipped. The app works out which of its tours are still to show.
func (c *Core) onboardingList() ([]byte, error) {
	rows, err := c.store.Onboarding.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(rows)
}

// onboardingRecord settles tours: each entry names a tour, the version the user saw, and
// whether they finished or skipped it. Settling one that is already settled writes nothing.
func (c *Core) onboardingRecord(payload []byte) ([]byte, error) {
	var args struct {
		Entries []store.OnboardingEntry `json:"entries"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	rows, err := c.store.Onboarding.Record(args.Entries)
	if err != nil {
		return nil, err
	}
	c.emit(onboardingChangedEvent, nil)
	return json.Marshal(rows)
}

// onboardingReset forgets that the named tours (every tour when none are named) were settled,
// so each shows again the next time its tool is opened, on every device.
func (c *Core) onboardingReset(payload []byte) ([]byte, error) {
	var args struct {
		Tours []string `json:"tours"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Onboarding.Reset(args.Tours)
	if err != nil {
		return nil, err
	}
	c.emit(onboardingChangedEvent, nil)
	return json.Marshal(map[string]int64{"count": n})
}
