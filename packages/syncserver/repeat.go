package syncserver

import (
	"context"
	"database/sql"
	"log"
	"time"

	"companion/core/domain"

	"github.com/google/uuid"
)

// Repeating tasks (PLAN §6.4, §11 milestone 11). Only the server generates occurrences, and
// it does so **just in time**: an occurrence row (repeat_seed_id = seed.id) is created only
// once its due instant has actually arrived — never ahead of time. A minute-cadence sweep
// asks each live seed "is a new occurrence due?" and creates the ones whose time has come;
// seed writes trigger the same check immediately (folded into push, sync.go), so a task that
// is already due appears at once. Occurrences sync down as ordinary tasks; completing one is
// a normal client edit. Because nothing is created ahead, there are never future occurrence
// rows to reconcile — editing a seed's rule simply changes what gets generated next.

// repeatSweepInterval is how often every seed is checked for a newly-due occurrence. The
// user's expectation is minute-level granularity (a task due at 9:00 appears by ~9:01).
const repeatSweepInterval = time.Minute

// StartRepeatMaterializer runs the due-occurrence sweep once at startup and then on every
// wall-clock minute boundary until ctx is cancelled. Ticking *on* the minute (rather than a
// minute after the process happens to start) means a task due at 9:00 is generated right at
// 9:00:0x, no matter when the server booted. Errors are logged, not fatal — a transient
// failure retries next tick, and the on-push trigger covers a seed the moment it is created
// or edited.
func (s *Server) StartRepeatMaterializer(ctx context.Context) {
	sweep := func() {
		if n, err := s.MaterializeAllRepeats(); err != nil {
			log.Printf("repeat generator: %v", err)
		} else if n > 0 {
			log.Printf("repeat generator: created %d due occurrence(s)", n)
		}
	}
	sweep()
	go func() {
		// Align the first tick to the next minute boundary; once the ticker starts there it
		// keeps firing on the minute (Go tickers schedule relative to their start).
		align := time.NewTimer(time.Until(time.Now().Truncate(time.Minute).Add(time.Minute)))
		defer align.Stop()
		select {
		case <-ctx.Done():
			return
		case <-align.C:
		}
		sweep()
		t := time.NewTicker(repeatSweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sweep()
			}
		}
	}()
}

// MaterializeAllRepeats checks every live seed across all users for occurrences that have
// come due, creating them, and returns the number created. Each affected user's devices are
// notified so their next sync pulls the new occurrences.
func (s *Server) MaterializeAllRepeats() (int, error) {
	type seedRef struct{ uid, id string }
	var seeds []seedRef
	rows, err := s.query(
		`SELECT user_id, id FROM tasks
		 WHERE repeat_rule IS NOT NULL AND repeat_seed_id IS NULL
		   AND deleted_at IS NULL AND deleting_at IS NULL;`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var r seedRef
		if err := rows.Scan(&r.uid, &r.id); err != nil {
			rows.Close()
			return 0, err
		}
		seeds = append(seeds, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	written := 0
	maxSeqByUser := map[string]int64{}
	for _, sr := range seeds {
		n, seq, err := s.materializeSeed(sr.uid, sr.id)
		if err != nil {
			return written, err
		}
		written += n
		if seq > maxSeqByUser[sr.uid] {
			maxSeqByUser[sr.uid] = seq
		}
	}
	for uid, seq := range maxSeqByUser {
		s.hub.publish(uid, seq)
	}
	return written, nil
}

// serverSeed is a seed's fields needed to shape its occurrences.
type serverSeed struct {
	id           string
	title        string
	notesMD      string
	dueAt        *time.Time
	remindAt     *time.Time
	repeatRule   string
	objectTypeID *string
	props        string
	createdAt    time.Time
	gone         bool // deleted or trashed: stop generating (existing occurrences are left be)
}

// reminderOffset is the seed's reminder lead relative to its due date (usually negative:
// remind before due), or 0 when it has no reminder. An occurrence inherits the same offset,
// and generation is timed so the occurrence's reminder still lands (PLAN §6.4).
func (s *serverSeed) reminderOffset() time.Duration {
	if s.remindAt == nil || s.dueAt == nil {
		return 0
	}
	return s.remindAt.Sub(*s.dueAt)
}

// materializeSeed creates the seed's next occurrence the moment it becomes relevant, and
// nothing else (PLAN §6.4). "Relevant" is the occurrence's own **reminder time** when the
// seed has a lead-time reminder (so that reminder can still fire), else its due time. The
// occurrence copies the seed's content, its project memberships, and its due/reminder shifted
// forward to the occurrence's date; the seed's own due/reminder then advance to show the last
// generated instance. Only one occurrence per sweep, never the whole schedule; a gone
// (deleted/trashed) seed generates nothing and leaves its existing occurrences in place.
//
// The schedule anchor is the *first* occurrence's due date (immutable) rather than the seed's
// current due date — so advancing the seed's displayed due date can't shift the schedule or
// reset a COUNT/UNTIL bound.
//
// It returns the number of rows written (occurrence + memberships + the seed update) and the
// max server_seq assigned, but does NOT publish — callers batch the hub notification.
func (s *Server) materializeSeed(uid, seedID string) (int, int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	seed, err := s.loadServerSeed(tx, uid, seedID)
	if err != nil {
		return 0, 0, err
	}
	if seed == nil || seed.gone {
		return 0, 0, nil // not a live seed: never generate ahead, never sweep history
	}

	now := s.clock.Now().UTC()
	anchor := seed.createdAt
	if seed.dueAt != nil {
		anchor = *seed.dueAt
	}
	// Pin the anchor to the first occurrence ever generated, so it stays fixed even as the
	// seed's displayed due date advances below.
	if first, err := s.firstOccurrenceDue(tx, uid, seedID); err != nil {
		return 0, 0, err
	} else if first != nil {
		anchor = *first
	}

	// Trigger generation when the occurrence's reminder is due (its due date shifted back by
	// the reminder lead), so a "remind me before it's due" reminder still lands.
	offset := seed.reminderOffset()
	trigger := now.Add(-offset)

	due, err := domain.LatestOccurrence(seed.repeatRule, anchor, trigger)
	if err != nil {
		// A malformed rule slipped past client validation: skip quietly rather than wedging
		// the sweep.
		log.Printf("repeat generator: seed %s: %v", seedID, err)
		return 0, 0, nil
	}
	if due == nil {
		return 0, 0, nil
	}

	// Already created (in any state — a completed or user-deleted occurrence is never
	// resurrected)? Then there's nothing new to do this sweep.
	exists, err := s.occurrenceExists(tx, uid, seedID, *due)
	if err != nil || exists {
		return 0, 0, err
	}

	// The occurrence's reminder is its due date shifted by the same lead as the seed's.
	var remind *time.Time
	if seed.reminderOffset() != 0 {
		r := due.Add(offset)
		remind = &r
	}

	written := 0
	var maxSeq int64
	bump := func(seq int64) {
		written++
		if seq > maxSeq {
			maxSeq = seq
		}
	}

	// 1. The occurrence itself.
	seq, err := s.nextSeq(tx, uid)
	if err != nil {
		return 0, 0, err
	}
	occID, err := s.insertOccurrence(tx, uid, seed, *due, remind, seq)
	if err != nil {
		return 0, 0, err
	}
	bump(seq)

	// 2. Copy the seed's project memberships onto the occurrence.
	projectIDs, err := s.seedProjectIDs(tx, uid, seedID)
	if err != nil {
		return 0, 0, err
	}
	for _, pid := range projectIDs {
		seq, err := s.nextSeq(tx, uid)
		if err != nil {
			return 0, 0, err
		}
		if err := s.copyOccurrenceMembership(tx, uid, pid, occID, seq); err != nil {
			return 0, 0, err
		}
		bump(seq)
	}

	// 3. Advance the seed's displayed due/reminder to this occurrence (the anchor stays fixed).
	seq, err = s.nextSeq(tx, uid)
	if err != nil {
		return 0, 0, err
	}
	if err := s.advanceSeedDates(tx, uid, seedID, *due, remind, seq); err != nil {
		return 0, 0, err
	}
	bump(seq)

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return written, maxSeq, nil
}

// firstOccurrenceDue returns the earliest due instant among a seed's occurrences (any state),
// or nil if none exist yet — the immutable schedule anchor.
func (s *Server) firstOccurrenceDue(tx *sql.Tx, uid, seedID string) (*time.Time, error) {
	var due sql.NullString
	err := tx.QueryRow(s.rebind(
		`SELECT MIN(due_at) FROM tasks WHERE user_id = ? AND repeat_seed_id = ? AND due_at IS NOT NULL;`),
		uid, seedID).Scan(&due)
	if err != nil {
		return nil, err
	}
	return parseServerTime(due)
}

// seedProjectIDs returns the ids of projects the seed is a live member of, so its occurrences
// can inherit the same memberships (PLAN §6.6).
func (s *Server) seedProjectIDs(tx *sql.Tx, uid, seedID string) ([]string, error) {
	rows, err := tx.Query(s.rebind(
		`SELECT project_id FROM project_members
		 WHERE user_id = ? AND entity_type = 'task' AND entity_id = ? AND deleted_at IS NULL;`),
		uid, seedID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var pid string
		if err := rows.Scan(&pid); err != nil {
			return nil, err
		}
		out = append(out, pid)
	}
	return out, rows.Err()
}

// copyOccurrenceMembership creates a project_members row joining an occurrence to a project,
// using the shared deterministic id (domain.MemberID) so it converges with any client copy.
func (s *Server) copyOccurrenceMembership(tx *sql.Tx, uid, projectID, occID string, seq int64) error {
	now := s.clock.Now().UTC().Format(timeFormat)
	_, err := tx.Exec(s.rebind(
		`INSERT INTO project_members (id, user_id, project_id, entity_type, entity_id, created_at, updated_at, deleted_at, version, server_seq)
		 VALUES (?, ?, ?, 'task', ?, ?, ?, NULL, 1, ?)
		 ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING;`),
		domain.MemberID(projectID, "task", occID), uid, projectID, occID, now, now, seq)
	return err
}

// advanceSeedDates moves the seed's displayed due/reminder forward to its latest generated
// occurrence (bumping version + server_seq so it pulls down), without touching the schedule
// anchor (which firstOccurrenceDue pins to the first occurrence).
func (s *Server) advanceSeedDates(tx *sql.Tx, uid, seedID string, due time.Time, remind *time.Time, seq int64) error {
	var version int64
	if err := tx.QueryRow(s.rebind(
		`SELECT version FROM tasks WHERE id = ? AND user_id = ?;`), seedID, uid).Scan(&version); err != nil {
		return err
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	_, err := tx.Exec(s.rebind(
		`UPDATE tasks SET due_at = ?, remind_at = ?, updated_at = ?, version = ?, server_seq = ?
		 WHERE id = ? AND user_id = ?;`),
		due.UTC().Format(timeFormat), fmtTime(remind), now, version+1, seq, seedID, uid)
	return err
}

// occurrenceExists reports whether this seed already has an occurrence at the given instant,
// in any row state — so a completed or user-deleted occurrence is never regenerated.
func (s *Server) occurrenceExists(tx *sql.Tx, uid, seedID string, due time.Time) (bool, error) {
	var one int
	err := tx.QueryRow(s.rebind(
		`SELECT 1 FROM tasks WHERE user_id = ? AND repeat_seed_id = ? AND due_at = ? LIMIT 1;`),
		uid, seedID, due.UTC().Format(timeFormat)).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// insertOccurrence writes one occurrence: the seed's content (title, notes, archetype/props)
// stamped with a concrete due date and a reminder shifted to match. It is a plain task — no
// repeat_rule of its own — pointing back at its seed. Returns the new occurrence id so the
// caller can attach the seed's project memberships to it.
func (s *Server) insertOccurrence(tx *sql.Tx, uid string, seed *serverSeed, due time.Time, remind *time.Time, seq int64) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	_, err = tx.Exec(s.rebind(
		`INSERT INTO tasks (id, user_id, title, notes_md, status, due_at, remind_at, completed_at,
		   repeat_rule, repeat_seed_id, object_type_id, props_json, created_at, updated_at,
		   deleting_at, deleted_at, version, server_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)
		 ON CONFLICT (id) DO NOTHING;`),
		id.String(), uid, seed.title, seed.notesMD, domain.TaskOpen,
		due.UTC().Format(timeFormat), fmtTime(remind), seed.id, seed.objectTypeID, seed.props,
		now, now, seq)
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// loadServerSeed reads the fields needed to shape a seed's occurrences, or nil if the id is
// not a seed on this account. A deleted or trashed seed is returned with gone=true so the
// generator stops producing new occurrences for it.
func (s *Server) loadServerSeed(tx *sql.Tx, uid, id string) (*serverSeed, error) {
	var (
		seed                     serverSeed
		notesMD, propsJSON       sql.NullString
		dueAt, remindAt          sql.NullString
		repeatRule, repeatSeedID sql.NullString
		objectTypeID             sql.NullString
		createdAt                string
		deletingAt, deletedAt    sql.NullString
	)
	row := tx.QueryRow(s.rebind(
		`SELECT id, title, notes_md, due_at, remind_at, repeat_rule, repeat_seed_id,
		   object_type_id, props_json, created_at, deleting_at, deleted_at
		 FROM tasks WHERE id = ? AND user_id = ?;`), id, uid)
	if err := row.Scan(&seed.id, &seed.title, &notesMD, &dueAt, &remindAt, &repeatRule,
		&repeatSeedID, &objectTypeID, &propsJSON, &createdAt, &deletingAt, &deletedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	// Only a seed (rule set, not itself an occurrence) drives materialization.
	if !repeatRule.Valid || repeatRule.String == "" || repeatSeedID.Valid {
		return nil, nil
	}
	seed.notesMD = notesMD.String
	seed.repeatRule = repeatRule.String
	seed.props = propsOrDefault([]byte(propsJSON.String))
	if objectTypeID.Valid {
		seed.objectTypeID = &objectTypeID.String
	}
	var err error
	if seed.createdAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, err
	}
	if seed.dueAt, err = parseServerTime(dueAt); err != nil {
		return nil, err
	}
	if seed.remindAt, err = parseServerTime(remindAt); err != nil {
		return nil, err
	}
	seed.gone = deletedAt.Valid || deletingAt.Valid
	return &seed, nil
}
