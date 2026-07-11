package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// ---- calendar feeds (user-authored, bidirectional) -----------------------

const feedCols = `id, name, url, ics_text, color, created_at, updated_at, deleted_at, version, server_seq`

var calendarFeedHandler = &entityHandler{
	typ:   protocol.EntityCalendarFeed,
	table: "calendar_feeds",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var f domain.CalendarFeed
		if err := json.Unmarshal(raw, &f); err != nil {
			return err
		}
		var deletedAt any
		if f.DeletedAt != nil {
			deletedAt = f.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO calendar_feeds (id, user_id, name, url, ics_text, color, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   name = excluded.name, url = excluded.url, ics_text = excluded.ics_text, color = excluded.color,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			f.ID, uid, f.Name, f.URL, nullStr(f.ICSText), f.Color,
			f.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+feedCols+` FROM calendar_feeds WHERE id = ? AND user_id = ?;`), id, uid)
		f, _, err := scanServerFeed(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(f)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+feedCols+` FROM calendar_feeds WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			f, seq, err := scanServerFeed(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(f)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityCalendarFeed, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerFeed(sc rowScanner) (*domain.CalendarFeed, int64, error) {
	var (
		f                    domain.CalendarFeed
		icsText, color       sql.NullString
		deletedAt            sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&f.ID, &f.Name, &f.URL, &icsText, &color, &createdAt, &updatedAt, &deletedAt, &f.Version, &seq); err != nil {
		return nil, 0, err
	}
	if icsText.Valid {
		f.ICSText = &icsText.String
	}
	if color.Valid {
		f.Color = &color.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &f, seq, nil
}

// ---- calendar events (server-owned, pull-only) ---------------------------

const eventCols = `id, feed_id, ics_uid, title, starts_at, ends_at, all_day, location, description, created_at, updated_at, deleted_at, version, server_seq`

var calendarEventHandler = &entityHandler{
	typ:   protocol.EntityCalendarEvent,
	table: "calendar_events",
	// upsert is defined for completeness but is never reached by a client push: clients
	// never author events (their local repo has no dirty rows). The fetcher writes events
	// directly (see calendar.go).
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var e domain.CalendarEvent
		if err := json.Unmarshal(raw, &e); err != nil {
			return err
		}
		return upsertEventTx(s, tx, uid, &e, version, seq)
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+eventCols+` FROM calendar_events WHERE id = ? AND user_id = ?;`), id, uid)
		e, _, err := scanServerEvent(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(e)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+eventCols+` FROM calendar_events WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			e, seq, err := scanServerEvent(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(e)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityCalendarEvent, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

// upsertEventTx writes one event row (used by the fetcher and the handler upsert). It
// preserves created_at on conflict and stamps the given version + server_seq.
func upsertEventTx(s *Server, tx *sql.Tx, uid string, e *domain.CalendarEvent, version, seq int64) error {
	var endsAt, deletedAt any
	if e.EndsAt != nil {
		endsAt = e.EndsAt.UTC().Format(timeFormat)
	}
	if e.DeletedAt != nil {
		deletedAt = e.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := tx.Exec(s.rebind(
		`INSERT INTO calendar_events (id, user_id, feed_id, ics_uid, title, starts_at, ends_at, all_day, location, description, created_at, updated_at, deleted_at, version, server_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		   feed_id = excluded.feed_id, ics_uid = excluded.ics_uid, title = excluded.title,
		   starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
		   location = excluded.location, description = excluded.description,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, server_seq = excluded.server_seq;`),
		e.ID, uid, e.FeedID, e.ICSUID, e.Title, e.StartsAt.UTC().Format(timeFormat), endsAt, boolToInt(e.AllDay),
		nullStr(e.Location), nullStr(e.Description),
		e.CreatedAt.UTC().Format(timeFormat), e.UpdatedAt.UTC().Format(timeFormat), deletedAt, version, seq)
	return err
}

func scanServerEvent(sc rowScanner) (*domain.CalendarEvent, int64, error) {
	var (
		e                              domain.CalendarEvent
		endsAt, location, description  sql.NullString
		deletedAt                      sql.NullString
		startsAt, createdAt, updatedAt string
		allDay                         int64
		seq                            int64
	)
	if err := sc.Scan(&e.ID, &e.FeedID, &e.ICSUID, &e.Title, &startsAt, &endsAt, &allDay,
		&location, &description, &createdAt, &updatedAt, &deletedAt, &e.Version, &seq); err != nil {
		return nil, 0, err
	}
	var err error
	if e.StartsAt, err = time.Parse(timeFormat, startsAt); err != nil {
		return nil, 0, err
	}
	if endsAt.Valid {
		t, err := time.Parse(timeFormat, endsAt.String)
		if err != nil {
			return nil, 0, err
		}
		e.EndsAt = &t
	}
	if location.Valid {
		e.Location = &location.String
	}
	if description.Valid {
		e.Description = &description.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &e.CreatedAt, &e.UpdatedAt, &e.DeletedAt); err != nil {
		return nil, 0, err
	}
	e.AllDay = allDay != 0
	return &e, seq, nil
}

// boolToInt renders a bool as 0/1 for the integer all_day column.
func boolToInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// nullStr maps a *string to a nullable column value.
func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
