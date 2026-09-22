package domain

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Onboarding records that the user settled one version of one guided tour: walked it to the
// end, or skipped it. Each tool has its own tour and version (the app defines both); a tour
// shows until a live row exists for its current version or a later one, so bumping a tour's
// version shows the new tour once. Rows are facts and never change after they are written:
// two devices settling the same tour offline leave two rows that agree, which is why the id is
// random. Replaying the tours from scratch tombstones the rows.
type Onboarding struct {
	ID string `json:"id"`
	// Tour names the tour: a tool ("today", "notes", …) or a place ("areas", "area", "project").
	// Two names are not tours: "welcome" is the welcome sheet every user reads once, and
	// "tutorials" holds their answer to whether tours show at all (completed = on, skipped =
	// off), replaced whenever they change it.
	Tour string `json:"tour"`
	// TourVersion is the version of the tour that was settled.
	TourVersion int        `json:"tourVersion"`
	Outcome     string     `json:"outcome"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	DeletedAt   *time.Time `json:"deletedAt,omitempty"`
	Version     int64      `json:"version"`
	Dirty       bool       `json:"dirty"`
}

// How a tour was settled.
const (
	OnboardingCompleted = "completed"
	OnboardingSkipped   = "skipped"
)

// ErrInvalidOnboarding is returned when an onboarding row fails validation.
var ErrInvalidOnboarding = errors.New("invalid onboarding")

// tourNameRe keeps tour names to short machine ids.
var tourNameRe = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// Validate checks the invariants that must hold before a row is persisted.
func (o *Onboarding) Validate() error {
	if _, err := uuid.Parse(strings.TrimSpace(o.ID)); err != nil {
		return errors.Join(ErrInvalidOnboarding, errors.New("id must be a UUID"))
	}
	if !tourNameRe.MatchString(o.Tour) {
		return errors.Join(ErrInvalidOnboarding, errors.New("tour must be a short lowercase id"))
	}
	if o.TourVersion < 1 {
		return errors.Join(ErrInvalidOnboarding, errors.New("tourVersion must be at least 1"))
	}
	if o.Outcome != OnboardingCompleted && o.Outcome != OnboardingSkipped {
		return errors.Join(ErrInvalidOnboarding, errors.New("outcome must be completed or skipped"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (o *Onboarding) SyncID() string           { return o.ID }
func (o *Onboarding) SyncVersion() int64       { return o.Version }
func (o *Onboarding) SyncUpdatedAt() time.Time { return o.UpdatedAt }
func (o *Onboarding) SyncDeleted() bool        { return o.DeletedAt != nil }
func (o *Onboarding) SyncDirty() bool          { return o.Dirty }
