package syncserver

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"companion/core/domain"

	ical "github.com/emersion/go-ical"
	"github.com/google/uuid"
	"github.com/teambition/rrule-go"
)

// calendarFetchInterval is how often every feed's ICS URL is re-fetched (PLAN §6.7). ICS
// publishers change slowly; a quarter-hour keeps clones fresh without hammering sources.
const calendarFetchInterval = 15 * time.Minute

// calendarWindow bounds recurrence expansion to ±1y around now, so an unbounded weekly rule
// yields a finite, storable set of occurrences (PLAN §6.7).
const calendarWindow = 365 * 24 * time.Hour

// maxICSBytes caps a fetched ICS body to guard against a hostile or runaway feed.
const maxICSBytes = 10 << 20 // 10 MiB

// calendarNS namespaces the deterministic (UUIDv5) event ids so re-fetches upsert the same
// occurrence in place rather than duplicating it. The value is an arbitrary fixed UUID.
var calendarNS = uuid.MustParse("1b4e28ba-2fa1-11d2-883f-0016d3cca427")

// icsClient fetches feeds with a bounded timeout so a slow host can't wedge a sweep.
var icsClient = &http.Client{Timeout: 30 * time.Second}

// StartCalendarFetcher runs the ICS sweep once at startup and then on a fixed interval until
// ctx is cancelled (PLAN §6.7), mirroring StartRepeatMaterializer / StartTrashCollector.
// Per-feed errors are logged, never fatal: a bad URL or an unreachable host simply retries
// next tick.
func (s *Server) StartCalendarFetcher(ctx context.Context) {
	sweep := func() {
		if n, err := s.FetchAllFeeds(ctx); err != nil {
			log.Printf("calendar fetcher: %v", err)
		} else if n > 0 {
			log.Printf("calendar fetcher: %d event change(s) across feeds", n)
		}
	}
	sweep()
	go func() {
		t := time.NewTicker(calendarFetchInterval)
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

// feedRef is a live feed to reconcile, with its owner and source. Exactly one of url /
// icsText drives it: a subscription URL the server fetches, or uploaded ICS text parsed in
// place.
type feedRef struct {
	uid, id, url string
	icsText      string
}

// FetchAllFeeds fetches every live feed (the periodic sweep), reconciles its cloned events,
// and pokes each affected user's devices to pull. Returns the total number of event rows
// written (created / updated / tombstoned) across all feeds.
func (s *Server) FetchAllFeeds(ctx context.Context) (int, error) {
	feeds, err := s.loadFeeds("")
	if err != nil {
		return 0, err
	}
	return s.reconcileFeeds(ctx, feeds)
}

// FetchUserFeeds fetches just one account's live feeds now — the manual "Refresh" the
// calendar view triggers (PLAN §6.7). Runs synchronously so the caller's follow-up sync
// pull sees the freshly-cloned events.
func (s *Server) FetchUserFeeds(ctx context.Context, uid string) (int, error) {
	feeds, err := s.loadFeeds(uid)
	if err != nil {
		return 0, err
	}
	return s.reconcileFeeds(ctx, feeds)
}

// loadFeeds returns the live feeds to reconcile: all of them when uid is empty, or one
// account's when it is set.
func (s *Server) loadFeeds(uid string) ([]feedRef, error) {
	q := `SELECT user_id, id, url, ics_text FROM calendar_feeds WHERE deleted_at IS NULL`
	args := []any{}
	if uid != "" {
		q += ` AND user_id = ?`
		args = append(args, uid)
	}
	rows, err := s.query(q+`;`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var feeds []feedRef
	for rows.Next() {
		var f feedRef
		var icsText sql.NullString
		if err := rows.Scan(&f.uid, &f.id, &f.url, &icsText); err != nil {
			return nil, err
		}
		f.icsText = icsText.String
		feeds = append(feeds, f)
	}
	return feeds, rows.Err()
}

// reconcileFeeds fetches each feed, reconciles its events, and pokes each affected user's
// devices once. Per-feed errors are logged, never fatal. Returns total rows written.
func (s *Server) reconcileFeeds(ctx context.Context, feeds []feedRef) (int, error) {
	total := 0
	maxSeqByUser := map[string]int64{}
	for _, f := range feeds {
		n, seq, err := s.fetchFeed(ctx, f)
		if err != nil {
			log.Printf("calendar fetcher: feed %s (%s): %v", f.id, f.url, err)
			continue
		}
		total += n
		if seq > maxSeqByUser[f.uid] {
			maxSeqByUser[f.uid] = seq
		}
	}
	for uid, seq := range maxSeqByUser {
		if seq > 0 {
			s.hub.publish(uid, seq)
		}
	}
	return total, nil
}

// handleCalendarRefresh re-fetches the authenticated account's ICS feeds synchronously, so
// the client's next sync pull sees any changes right away (PLAN §6.7). The per-feed publish
// inside the fetch also pokes the user's other devices.
func (s *Server) handleCalendarRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	n, err := s.FetchUserFeeds(r.Context(), userID(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "refresh failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"changed": n})
}

// triggerFeedFetch reconciles a single feed the moment it is pushed — a new/edited feed is
// fetched right away, and a deleted feed has its cloned events tombstoned — so events reach
// devices within seconds instead of waiting for the periodic sweep (PLAN §6.7). Mirrors the
// on-push repeat materialization. Runs on a background goroutine; failures are logged only.
func (s *Server) triggerFeedFetch(uid, id string) {
	var url string
	var icsText sql.NullString
	var deleted int
	err := s.queryRow(
		`SELECT url, ics_text, CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END FROM calendar_feeds WHERE id = ? AND user_id = ?;`,
		id, uid).Scan(&url, &icsText, &deleted)
	if err != nil {
		if err != sql.ErrNoRows {
			log.Printf("calendar fetcher: trigger feed %s: %v", id, err)
		}
		return
	}
	var seq int64
	if deleted == 1 {
		_, seq, err = s.tombstoneFeedEvents(uid, id)
	} else {
		_, seq, err = s.fetchFeed(context.Background(), feedRef{uid: uid, id: id, url: url, icsText: icsText.String})
	}
	if err != nil {
		log.Printf("calendar fetcher: trigger feed %s: %v", id, err)
		return
	}
	if seq > 0 {
		s.hub.publish(uid, seq)
	}
}

// tombstoneFeedEvents marks every live cloned event of a feed deleted (the user removed the
// feed), assigning fresh seqs so the removal syncs to every device. Returns rows written and
// the max seq.
func (s *Server) tombstoneFeedEvents(uid, feedID string) (int, int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(s.rebind(`SELECT `+eventCols+` FROM calendar_events WHERE feed_id = ? AND user_id = ? AND deleted_at IS NULL;`), feedID, uid)
	if err != nil {
		return 0, 0, err
	}
	var events []*domain.CalendarEvent
	for rows.Next() {
		e, _, err := scanServerEvent(rows)
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()

	now := s.clock.Now().UTC()
	written := 0
	var maxSeq int64
	for _, e := range events {
		seq, err := s.nextSeq(tx, uid)
		if err != nil {
			return 0, 0, err
		}
		e.DeletedAt = &now
		e.UpdatedAt = now
		e.Version++
		if err := upsertEventTx(s, tx, uid, e, e.Version, seq); err != nil {
			return 0, 0, err
		}
		written++
		if seq > maxSeq {
			maxSeq = seq
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return written, maxSeq, nil
}

// fetchFeed downloads one feed, expands its events over the window, and reconciles them
// against the stored clone in a single transaction: new/changed occurrences are upserted
// with a fresh server_seq, and occurrences that vanished from the feed are tombstoned. An
// unchanged event keeps its seq, so a quiet feed produces no sync churn. Returns the number
// of rows written and the max server_seq assigned.
func (s *Server) fetchFeed(ctx context.Context, f feedRef) (int, int64, error) {
	events, err := fetchAndExpand(ctx, f, s.clock.Now().UTC())
	if err != nil {
		return 0, 0, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	// Existing non-deleted clones for this feed, by id.
	existing := map[string]*domain.CalendarEvent{}
	er, err := tx.Query(s.rebind(`SELECT `+eventCols+` FROM calendar_events WHERE feed_id = ? AND user_id = ? AND deleted_at IS NULL;`), f.id, f.uid)
	if err != nil {
		return 0, 0, err
	}
	for er.Next() {
		e, _, err := scanServerEvent(er)
		if err != nil {
			er.Close()
			return 0, 0, err
		}
		existing[e.ID] = e
	}
	if err := er.Err(); err != nil {
		er.Close()
		return 0, 0, err
	}
	er.Close()

	now := s.clock.Now().UTC()
	written := 0
	var maxSeq int64

	for _, e := range events {
		old, ok := existing[e.ID]
		if ok {
			delete(existing, e.ID) // seen this cycle
			if !eventChanged(old, e) {
				continue // quiet: no seq bump, no re-pull
			}
			e.Version = old.Version + 1
			e.CreatedAt = old.CreatedAt
		} else {
			e.Version = 1
			e.CreatedAt = now
		}
		e.UpdatedAt = now
		seq, err := s.nextSeq(tx, f.uid)
		if err != nil {
			return 0, 0, err
		}
		if err := upsertEventTx(s, tx, f.uid, e, e.Version, seq); err != nil {
			return 0, 0, err
		}
		written++
		if seq > maxSeq {
			maxSeq = seq
		}
	}

	// Anything still in `existing` was not produced this cycle → tombstone it so the
	// removal reaches clients through normal sync.
	for _, old := range existing {
		seq, err := s.nextSeq(tx, f.uid)
		if err != nil {
			return 0, 0, err
		}
		old.DeletedAt = &now
		old.UpdatedAt = now
		old.Version++
		if err := upsertEventTx(s, tx, f.uid, old, old.Version, seq); err != nil {
			return 0, 0, err
		}
		written++
		if seq > maxSeq {
			maxSeq = seq
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return written, maxSeq, nil
}

// fetchAndExpand yields the feed's expanded occurrences over [now-window, now+window]: it
// parses the uploaded ICS text in place when present, otherwise downloads the subscription
// URL. Separated from persistence so the fixture test can exercise parsing offline.
func fetchAndExpand(ctx context.Context, f feedRef, now time.Time) ([]*domain.CalendarEvent, error) {
	if strings.TrimSpace(f.icsText) != "" {
		return parseAndExpand(strings.NewReader(f.icsText), f.id, now)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizeFeedURL(f.url), nil)
	if err != nil {
		return nil, err
	}
	// Some ICS hosts (Google among them) reject the default Go user-agent or an absent
	// Accept header; present as a normal calendar client so subscriptions actually download.
	req.Header.Set("User-Agent", "Companion-Calendar/1.0")
	req.Header.Set("Accept", "text/calendar, text/plain;q=0.9, */*;q=0.5")
	resp, err := icsClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ics status %d", resp.StatusCode)
	}
	return parseAndExpand(io.LimitReader(resp.Body, maxICSBytes), f.id, now)
}

// normalizeFeedURL rewrites the webcal(s):// scheme that calendar apps (including Google
// Calendar's "copy link") hand out to https://, which Go's HTTP client understands — a
// webcal URL otherwise fails hard with "unsupported protocol scheme".
func normalizeFeedURL(raw string) string {
	u := strings.TrimSpace(raw)
	switch {
	case strings.HasPrefix(strings.ToLower(u), "webcals://"):
		return "https://" + u[len("webcals://"):]
	case strings.HasPrefix(strings.ToLower(u), "webcal://"):
		return "https://" + u[len("webcal://"):]
	}
	return u
}

// parseAndExpand decodes an ICS stream and expands it. Exposed to the fetcher test.
func parseAndExpand(r io.Reader, feedID string, now time.Time) ([]*domain.CalendarEvent, error) {
	cal, err := ical.NewDecoder(r).Decode()
	if err != nil {
		return nil, fmt.Errorf("decode ics: %w", err)
	}
	windowStart := now.Add(-calendarWindow)
	windowEnd := now.Add(calendarWindow)

	var out []*domain.CalendarEvent
	for _, ev := range cal.Events() {
		base, allDay, dur, rrl, err := parseEvent(&ev)
		if err != nil {
			// Skip a malformed event rather than failing the whole feed.
			continue
		}
		starts := expandStarts(base, rrl, exDates(&ev), windowStart, windowEnd)
		for _, st := range starts {
			out = append(out, buildOccurrence(feedID, &ev, st, dur, allDay))
		}
	}
	return out, nil
}

// exDates returns the excluded recurrence instants declared by a VEVENT's EXDATE
// properties (a single instance the user deleted from a repeating Google/Outlook event).
// EXDATE may repeat and may be comma-separated; each value is parsed with its own TZID and
// normalized to UTC to match the expanded occurrences. Unparseable values are skipped.
func exDates(ev *ical.Event) []time.Time {
	var out []time.Time
	for _, p := range ev.Props[ical.PropExceptionDates] {
		for _, v := range strings.Split(p.Value, ",") {
			cp := p
			cp.Value = strings.TrimSpace(v)
			if t, err := cp.DateTime(time.UTC); err == nil {
				out = append(out, t.UTC())
			}
		}
	}
	return out
}

// parseEvent extracts the anchor start, all-day flag, duration, and RRULE string (if any)
// from a VEVENT.
func parseEvent(ev *ical.Event) (start time.Time, allDay bool, dur time.Duration, rruleStr string, err error) {
	start, err = ev.DateTimeStart(time.UTC)
	if err != nil {
		return time.Time{}, false, 0, "", err
	}
	if p := ev.Props.Get(ical.PropDateTimeStart); p != nil && p.Params.Get(ical.ParamValue) == "DATE" {
		allDay = true
	}
	if end, err := ev.DateTimeEnd(time.UTC); err == nil && !end.IsZero() {
		dur = end.Sub(start)
	}
	if p := ev.Props.Get(ical.PropRecurrenceRule); p != nil {
		rruleStr = p.Value
	}
	return start, allDay, dur, rruleStr, nil
}

// expandStarts returns every occurrence start within [from, to]. A non-recurring event
// yields its single start if in range; a recurring one is expanded with rrule-go.
func expandStarts(base time.Time, rruleStr string, exdates []time.Time, from, to time.Time) []time.Time {
	if rruleStr == "" {
		if !base.Before(from) && !base.After(to) {
			return []time.Time{base}
		}
		return nil
	}
	opt, err := rrule.StrToROption(rruleStr)
	if err != nil {
		// Unparseable rule: fall back to the single anchor occurrence.
		if !base.Before(from) && !base.After(to) {
			return []time.Time{base}
		}
		return nil
	}
	opt.Dtstart = base
	set := &rrule.Set{}
	if r, err := rrule.NewRRule(*opt); err == nil {
		set.RRule(r)
	} else {
		return nil
	}
	// Exclude instances the user deleted from the series (EXDATE).
	for _, ex := range exdates {
		set.ExDate(ex)
	}
	return set.Between(from, to, true)
}

// buildOccurrence materializes one CalendarEvent for a start instant, with a deterministic
// id so re-fetches upsert in place (PLAN §6.7).
func buildOccurrence(feedID string, ev *ical.Event, start time.Time, dur time.Duration, allDay bool) *domain.CalendarEvent {
	uid := propText(ev, ical.PropUID)
	e := &domain.CalendarEvent{
		ID:       eventID(feedID, uid, start),
		FeedID:   feedID,
		ICSUID:   uid,
		Title:    propText(ev, ical.PropSummary),
		StartsAt: start.UTC(),
		AllDay:   allDay,
	}
	if dur > 0 {
		end := start.Add(dur).UTC()
		e.EndsAt = &end
	}
	if loc := propText(ev, ical.PropLocation); loc != "" {
		e.Location = &loc
	}
	if desc := propText(ev, ical.PropDescription); desc != "" {
		e.Description = &desc
	}
	return e
}

// propText reads a text property, treating an absent or malformed value as empty.
func propText(ev *ical.Event, name string) string {
	v, err := ev.Props.Text(name)
	if err != nil {
		return ""
	}
	return v
}

// eventID is the deterministic UUIDv5 of feed|uid|occurrence-start.
func eventID(feedID, uid string, start time.Time) string {
	return uuid.NewSHA1(calendarNS, []byte(feedID+"|"+uid+"|"+start.UTC().Format(time.RFC3339))).String()
}

// eventChanged reports whether a freshly-expanded occurrence differs from the stored clone
// in any user-visible field (ignoring created_at/updated_at/version/seq).
func eventChanged(old, fresh *domain.CalendarEvent) bool {
	if old.Title != fresh.Title || old.ICSUID != fresh.ICSUID || old.AllDay != fresh.AllDay {
		return true
	}
	if !old.StartsAt.Equal(fresh.StartsAt) {
		return true
	}
	if (old.EndsAt == nil) != (fresh.EndsAt == nil) {
		return true
	}
	if old.EndsAt != nil && fresh.EndsAt != nil && !old.EndsAt.Equal(*fresh.EndsAt) {
		return true
	}
	return derefStr(old.Location) != derefStr(fresh.Location) || derefStr(old.Description) != derefStr(fresh.Description)
}

// derefStr returns the string or "" for a nil pointer.
func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
