package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// OnboardingRepo records which guided tours the user has settled (finished or skipped), per
// tour and tour version. The rows sync, so a tour settled on one device never shows on another.
type OnboardingRepo struct {
	db    Driver
	clock domain.Clock
}

const onboardingColumns = `id, tour, tour_version, outcome, created_at, updated_at, deleted_at, version, dirty`

// OnboardingEntry is one tour to settle.
type OnboardingEntry struct {
	Tour        string `json:"tour"`
	TourVersion int    `json:"tourVersion"`
	Outcome     string `json:"outcome"`
	// Replace forgets the tour's earlier rows first, for a row that stands for a choice the user
	// can change (whether tutorials show at all) rather than a fact.
	Replace bool `json:"replace,omitempty"`
}

// Record settles each entry's tour at its version, returning the rows that stand for them in
// input order. Idempotent: a tour already settled at that version or a later one keeps the row
// it has, so a double click or a replayed tour writes nothing. An entry marked Replace always
// writes, after tombstoning the tour's earlier rows.
func (r *OnboardingRepo) Record(entries []OnboardingEntry) ([]*domain.Onboarding, error) {
	now := r.clock.Now().UTC()
	out := make([]*domain.Onboarding, 0, len(entries))
	for _, e := range entries {
		o := &domain.Onboarding{
			ID: uuid.NewString(), Tour: strings.TrimSpace(e.Tour), TourVersion: e.TourVersion, Outcome: e.Outcome,
			CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
		}
		if err := o.Validate(); err != nil {
			return nil, err
		}
		if e.Replace {
			if _, err := r.Reset([]string{o.Tour}); err != nil {
				return nil, err
			}
		}
		existing, err := r.list(
			`SELECT `+onboardingColumns+` FROM onboarding WHERE tour = ? AND tour_version >= ? AND deleted_at IS NULL ORDER BY tour_version DESC, created_at ASC LIMIT 1;`,
			o.Tour, o.TourVersion,
		)
		if err != nil {
			return nil, err
		}
		if len(existing) > 0 {
			out = append(out, existing[0])
			continue
		}
		if _, err := r.db.Exec(
			`INSERT INTO onboarding (id, tour, tour_version, outcome, created_at, updated_at, deleted_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 1);`,
			o.ID, o.Tour, o.TourVersion, o.Outcome, o.CreatedAt.Format(timeFormat), o.UpdatedAt.Format(timeFormat),
		); err != nil {
			return nil, fmt.Errorf("insert onboarding: %w", err)
		}
		out = append(out, o)
	}
	return out, nil
}

// List returns every live row, oldest first.
func (r *OnboardingRepo) List() ([]*domain.Onboarding, error) {
	return r.list(`SELECT ` + onboardingColumns + ` FROM onboarding WHERE deleted_at IS NULL ORDER BY created_at, id;`)
}

// Reset tombstones the rows of the named tours (every tour when none are named), so each shows
// again the next time its tool is opened. Returns how many rows it removed.
func (r *OnboardingRepo) Reset(tours []string) (int64, error) {
	now := r.clock.Now().UTC().Format(timeFormat)
	query := `UPDATE onboarding SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE deleted_at IS NULL`
	args := []any{now, now}
	if len(tours) > 0 {
		in, tourArgs := placeholders(tours)
		query += ` AND tour IN (` + in + `)`
		args = append(args, tourArgs...)
	}
	res, err := r.db.Exec(query+`;`, args...)
	if err != nil {
		return 0, fmt.Errorf("reset onboarding: %w", err)
	}
	affected, _ := res.RowsAffected()
	return affected, nil
}

func (r *OnboardingRepo) list(query string, args ...any) ([]*domain.Onboarding, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query onboarding: %w", err)
	}
	defer rows.Close()
	out := []*domain.Onboarding{}
	for rows.Next() {
		o, err := scanOnboarding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.Onboarding] ---

func (r *OnboardingRepo) EntityType() string { return protocol.EntityOnboarding }

func (r *OnboardingRepo) Dirty() ([]*domain.Onboarding, error) {
	return r.list(`SELECT ` + onboardingColumns + ` FROM onboarding WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *OnboardingRepo) GetAny(id string) (*domain.Onboarding, error) {
	rows, err := r.db.Query(`SELECT `+onboardingColumns+` FROM onboarding WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query onboarding: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanOnboarding(rows)
}

func (r *OnboardingRepo) Apply(o *domain.Onboarding) error {
	if _, err := r.db.Exec(
		`INSERT INTO onboarding (id, tour, tour_version, outcome, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   tour = excluded.tour, tour_version = excluded.tour_version, outcome = excluded.outcome,
		   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		o.ID, o.Tour, o.TourVersion, o.Outcome, o.CreatedAt.UTC().Format(timeFormat), o.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(o.DeletedAt), o.Version,
	); err != nil {
		return fmt.Errorf("apply onboarding: %w", err)
	}
	return nil
}

func (r *OnboardingRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE onboarding SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: a row is written once and only ever tombstoned after, so alive-vs-deleted is
// the only difference worth keeping, and even that needs no copy (a reset wins either way).
func (r *OnboardingRepo) MeaningfulDiff(a, b *domain.Onboarding) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *OnboardingRepo) ConflictedCopy(local *domain.Onboarding, suffix string) error { return nil }

func (r *OnboardingRepo) Decode(raw json.RawMessage) (*domain.Onboarding, error) {
	var o domain.Onboarding
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("decode onboarding: %w", err)
	}
	return &o, nil
}

func scanOnboarding(rows Rows) (*domain.Onboarding, error) {
	var (
		o                    domain.Onboarding
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&o.ID, &o.Tour, &o.TourVersion, &o.Outcome, &createdAt, &updatedAt, &deletedAt, &o.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan onboarding: %w", err)
	}
	var err error
	if o.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if o.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if o.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	o.Dirty = dirty != 0
	return &o, nil
}
