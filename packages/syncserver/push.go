package syncserver

import (
	"context"
	"crypto/ecdh"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"companion/core/crypto"
	"companion/core/domain"
	"companion/core/notify"

	"github.com/google/uuid"
)

// Reminder push (PLAN §6.4, web): browsers — above all an installed web app on iOS, which can't
// run a page in the background — register a Web Push subscription here, and the server delivers
// each task reminder as it comes due, whether or not the app is open. The fires are exactly the
// apps' own (notify.PlanTasks over the same synced tasks), so a device that also schedules
// reminders locally shows the same notification, which the service worker collapses into one.
//
// Everything a fire needs to be timed — deadline, reminders, status — is plaintext on the server
// (PLAN §E2EE). A task's title is not on an encrypted account, so its push carries no title: the
// service worker words it from what the device has cached, or generically.

// Delivery cadence. A sweep every pushSweepInterval sends every fire that has come due since the
// last one; pushLookback bounds how late a fire may still go out — a restart or a slow sweep
// delivers a reminder a little late rather than never, but one missed by more than this is
// dropped rather than arriving stale.
const (
	pushSweepInterval = 15 * time.Second
	pushLookback      = 10 * time.Minute
	// pushLateEditGrace: a fire is skipped when its task was last written more than this after
	// the fire instant — the reminder was set (or moved) into the past, which the apps' local
	// schedulers never fire either. The grace covers repeat occurrences, which the server writes a
	// moment after the instant they are due.
	pushLateEditGrace = 2 * time.Minute
	// pushTTL is how long a push service holds an undelivered reminder for an offline device.
	pushTTL = 4 * time.Hour
	// pushLedgerRetention is how long a delivered fire is remembered for de-duplication. It only
	// has to outlive pushLookback; the rest is slack.
	pushLedgerRetention = 24 * time.Hour
	// pushConcurrency bounds the messages in flight at once within a sweep.
	pushConcurrency = 8
	// maxPushSubscriptions caps one account's subscriptions; registering past it retires the
	// least recently refreshed.
	maxPushSubscriptions = 20
)

// vapidSettingKey names the generated VAPID key pair in server_settings.
const vapidSettingKey = "webpush.vapid"

// pushServiceHosts are the push services browsers subscribe through. A subscription must point at
// one of them over HTTPS: the server POSTs to whatever endpoint a client registers, so it must not
// be steerable at arbitrary — or internal — hosts. A host matches itself and its subdomains.
var pushServiceHosts = []string{
	"fcm.googleapis.com",        // Chrome and most Chromium browsers (Android included)
	"push.services.mozilla.com", // Firefox
	"push.apple.com",            // Safari on macOS, and Home Screen web apps on iOS/iPadOS
	"notify.windows.com",        // Edge on Windows
}

// validatePushEndpoint accepts only an HTTPS URL on a known push service's default port.
func validatePushEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return errors.New("push endpoint must be an https URL")
	}
	if p := u.Port(); p != "" && p != "443" {
		return errors.New("push endpoint must use the default https port")
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range pushServiceHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			return nil
		}
	}
	return errors.New("push endpoint is not a known push service")
}

// loadPushConfig resolves the VAPID key pair and contact. VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY pin
// the pair (e.g. to share one across environments); otherwise one is generated on first boot and
// kept in the store, so it survives restarts and every instance on the same database shares it.
func (s *Server) loadPushConfig() error {
	s.vapidSubject = pushSubject(os.Getenv("VAPID_SUBJECT"), s.publicURL, s.mailer.from)
	if placeholderSubject(s.vapidSubject) {
		log.Printf("push: VAPID contact is %q — Apple's push service rejects placeholder contacts, so reminders to iPhones and iPads will fail; set VAPID_SUBJECT to a real mailto: or https: address", s.vapidSubject)
	}
	pub, priv := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY")
	if strings.TrimSpace(pub) != "" || strings.TrimSpace(priv) != "" {
		k, err := parseVAPIDKeys(pub, priv)
		if err != nil {
			return fmt.Errorf("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: %w", err)
		}
		s.vapid = k
		return nil
	}
	k, err := s.storedVAPIDKeys()
	if err != nil {
		return err
	}
	s.vapid = k
	return nil
}

// storedVAPIDKeys returns the generated key pair, creating it on first use. Two instances booting
// at once both try the insert; whichever lands first wins and both read that one back.
func (s *Server) storedVAPIDKeys() (*vapidKeys, error) {
	type stored struct {
		PublicKey  string `json:"publicKey"`
		PrivateKey string `json:"privateKey"`
	}
	read := func() (*vapidKeys, error) {
		var raw string
		if err := s.queryRow(`SELECT value FROM server_settings WHERE key = ?;`, vapidSettingKey).Scan(&raw); err != nil {
			return nil, err
		}
		var v stored
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, fmt.Errorf("stored VAPID keys: %w", err)
		}
		return parseVAPIDKeys(v.PublicKey, v.PrivateKey)
	}
	k, err := read()
	if !errors.Is(err, sql.ErrNoRows) {
		return k, err
	}
	fresh, err := newVAPIDKeys()
	if err != nil {
		return nil, err
	}
	value, err := json.Marshal(stored{PublicKey: fresh.publicKey(), PrivateKey: fresh.privateKey()})
	if err != nil {
		return nil, err
	}
	if _, err := s.exec(`INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING;`,
		vapidSettingKey, string(value), s.clock.Now().UTC().Format(timeFormat)); err != nil {
		return nil, err
	}
	return read()
}

// pushSubject is the operator contact every VAPID token names (RFC 8292 §2.1), which a push service
// uses to reach whoever runs the server: VAPID_SUBJECT when set, else this API's public URL when it
// is HTTPS, else the address mail is sent from. Push services refuse a token whose subject is not a
// mailto: or https: URL, and Apple's also refuses placeholder ones (mailto:…@localhost), so production
// sets VAPID_SUBJECT or an HTTPS COMPANION_PUBLIC_URL.
func pushSubject(configured, publicURL, mailFrom string) string {
	if v := strings.TrimSpace(configured); v != "" {
		return v
	}
	if strings.HasPrefix(publicURL, "https://") {
		return publicURL
	}
	if a, err := mail.ParseAddress(mailFrom); err == nil {
		return "mailto:" + a.Address
	}
	return "mailto:no-reply@localhost"
}

// placeholderSubject reports a contact no push service can reach (Apple answers BadJwtToken).
func placeholderSubject(subject string) bool {
	host := subject
	if i := strings.LastIndex(host, "@"); i >= 0 {
		host = host[i+1:]
	} else if u, err := url.Parse(subject); err == nil {
		host = u.Hostname()
	}
	host = strings.ToLower(strings.TrimSuffix(host, "/"))
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".invalid") || strings.HasSuffix(host, ".test") || strings.HasSuffix(host, ".example") ||
		host == "example.com" || net.ParseIP(host) != nil
}

// pushSubscription is one browser's registration: where to deliver and the keys to encrypt with.
type pushSubscription struct {
	id       string
	userID   string
	endpoint string
	p256dh   string
	auth     string
}

// pushSubscriptionWire is PushSubscription.toJSON(), as the browser hands it over.
type pushSubscriptionWire struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// handlePushConfig tells a client whether push is available and which key to subscribe with.
func (s *Server) handlePushConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"publicKey": s.vapid.publicKey()})
}

// handlePushSubscribe registers (or refreshes) the calling browser's subscription. An endpoint is
// one browser profile, so it belongs to whoever registered it last — the account signed in there
// now — and a device keeps a single subscription: registering a new endpoint retires its old one.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	var in struct {
		DeviceID     string               `json:"deviceId"`
		Subscription pushSubscriptionWire `json:"subscription"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	sub := in.Subscription
	sub.Endpoint = strings.TrimSpace(sub.Endpoint)
	deviceID := strings.TrimSpace(in.DeviceID)
	if len(sub.Endpoint) > 2048 || len(deviceID) > 64 {
		writeErr(w, http.StatusBadRequest, "subscription is too large")
		return
	}
	if err := s.pushEndpointOK(sub.Endpoint); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateSubscriptionKeys(sub.Keys.P256DH, sub.Keys.Auth); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	if _, err := s.exec(
		`INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (endpoint) DO UPDATE SET
		   user_id = excluded.user_id, device_id = excluded.device_id, p256dh = excluded.p256dh,
		   auth = excluded.auth, updated_at = excluded.updated_at;`,
		uuid.NewString(), uid, deviceID, sub.Endpoint, sub.Keys.P256DH, sub.Keys.Auth, now, now); err != nil {
		writeErr(w, http.StatusInternalServerError, "subscription store failed")
		return
	}
	if deviceID != "" {
		if _, err := s.exec(`DELETE FROM push_subscriptions WHERE user_id = ? AND device_id = ? AND endpoint <> ?;`,
			uid, deviceID, sub.Endpoint); err != nil {
			writeErr(w, http.StatusInternalServerError, "subscription store failed")
			return
		}
	}
	if err := s.trimPushSubscriptions(uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "subscription store failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// validateSubscriptionKeys checks a subscription's p256dh (a P-256 point, 65 bytes uncompressed)
// and auth secret (16 bytes), so a malformed one is refused now rather than failing every push.
func validateSubscriptionKeys(p256dh, auth string) error {
	pub, err := decodeB64(p256dh)
	if err != nil {
		return errors.New("subscription p256dh key is invalid")
	}
	if _, err := ecdh.P256().NewPublicKey(pub); err != nil { // uncompressed and on the curve
		return errors.New("subscription p256dh key is invalid")
	}
	if secret, err := decodeB64(auth); err != nil || len(secret) != 16 {
		return errors.New("subscription auth secret is invalid")
	}
	return nil
}

// trimPushSubscriptions retires an account's least recently refreshed subscriptions past the cap.
func (s *Server) trimPushSubscriptions(uid string) error {
	rows, err := s.query(`SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id;`, uid)
	if err != nil {
		return err
	}
	var extra []string
	for i := 0; rows.Next(); i++ {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if i >= maxPushSubscriptions {
			extra = append(extra, id)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range extra {
		if _, err := s.exec(`DELETE FROM push_subscriptions WHERE id = ?;`, id); err != nil {
			return err
		}
	}
	return nil
}

// handlePushUnsubscribe forgets one of the caller's subscriptions (signing out, or turning
// notifications off on that device). Unknown endpoints are not an error: the goal state holds.
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Endpoint string `json:"endpoint"`
	}
	if err := decode(r, &in); err != nil || strings.TrimSpace(in.Endpoint) == "" {
		writeErr(w, http.StatusBadRequest, "endpoint is required")
		return
	}
	if _, err := s.exec(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?;`, userID(r), strings.TrimSpace(in.Endpoint)); err != nil {
		writeErr(w, http.StatusInternalServerError, "unsubscribe failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handlePushTest sends a test notification to one of the caller's subscriptions, so Settings can
// prove the whole path — server, push service, service worker — works on this device.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	var in struct {
		Endpoint string `json:"endpoint"`
	}
	if err := decode(r, &in); err != nil || strings.TrimSpace(in.Endpoint) == "" {
		writeErr(w, http.StatusBadRequest, "endpoint is required")
		return
	}
	sub, err := s.pushSubscriptionByEndpoint(userID(r), strings.TrimSpace(in.Endpoint))
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "this device is not subscribed")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "subscription lookup failed")
		return
	}
	payload, _ := json.Marshal(pushPayload{
		V: 1, Type: "test", Title: "Notifications are on",
		Body: "Reminders will arrive on this device even when Companion is closed.",
	})
	outcome, err := s.sendPush(r.Context(), sub, pushMessage{payload: payload, ttl: time.Minute, urgency: "high"})
	switch outcome {
	case pushDelivered:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case pushGone:
		s.forgetPushSubscription(sub.id)
		writeErr(w, http.StatusGone, "this device's subscription has expired; turn notifications off and on again")
	default:
		log.Printf("push: test to %s failed: %v", pushServiceName(sub.endpoint), err)
		writeErr(w, http.StatusBadGateway, "the push service rejected the notification")
	}
}

func (s *Server) pushSubscriptionByEndpoint(uid, endpoint string) (pushSubscription, error) {
	sub := pushSubscription{userID: uid, endpoint: endpoint}
	err := s.queryRow(`SELECT id, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND endpoint = ?;`, uid, endpoint).
		Scan(&sub.id, &sub.p256dh, &sub.auth)
	return sub, err
}

func (s *Server) forgetPushSubscription(id string) {
	if _, err := s.exec(`DELETE FROM push_subscriptions WHERE id = ?;`, id); err != nil {
		log.Printf("push: forget subscription: %v", err)
	}
}

// pushPayload is the JSON a push carries to the service worker (apps/web/public/sw.js). A reminder
// carries the fire, not its wording: the worker phrases it in the device's own time zone and, on
// an encrypted account, supplies the title from the device's cache.
type pushPayload struct {
	V      int    `json:"v"`
	Type   string `json:"type"` // "reminder" | "test"
	TaskID string `json:"taskId,omitempty"`
	Kind   string `json:"kind,omitempty"` // notify.KindReminder | notify.KindDue
	FireAt string `json:"fireAt,omitempty"`
	DueAt  string `json:"dueAt,omitempty"`
	// Title is the task's title — omitted when the account encrypts it (PLAN §E2EE).
	Title string `json:"title,omitempty"`
	// Body is set on test messages only; reminders are worded on the device.
	Body string `json:"body,omitempty"`
}

// StartPushDispatcher delivers due reminders once at startup and then every pushSweepInterval
// until ctx is cancelled. Ticks sit a couple of seconds past each quarter minute, so a reminder at
// 9:00 goes out at 9:00:02 — after the repeat generator's on-the-minute sweep has created any
// occurrence due then. Errors are logged, not fatal: the next tick retries within the lookback.
func (s *Server) StartPushDispatcher(ctx context.Context) {
	sweep := func() {
		if n, err := s.SendDueReminders(ctx); err != nil {
			log.Printf("push: %v", err)
		} else if n > 0 {
			log.Printf("push: sent %d reminder(s)", n)
		}
	}
	sweep()
	go func() {
		next := time.Now().Truncate(pushSweepInterval).Add(pushSweepInterval + 2*time.Second)
		align := time.NewTimer(time.Until(next))
		defer align.Stop()
		select {
		case <-ctx.Done():
			return
		case <-align.C:
		}
		sweep()
		t := time.NewTicker(pushSweepInterval)
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

// pushJob is one reminder on its way to one subscription.
type pushJob struct {
	sub     pushSubscription
	payload []byte
}

// SendDueReminders sends every reminder that has come due since the last sweep to each subscribed
// browser of its account, and returns how many messages the push services accepted. A fire is
// claimed in push_deliveries before it is sent, so it goes out once however many sweeps — or
// instances — see it.
func (s *Server) SendDueReminders(ctx context.Context) (int, error) {
	now := s.clock.Now().UTC()
	from := now.Add(-pushLookback)
	s.prunePushLedger(now)

	tasksByUser, err := s.pushCandidateTasks()
	if err != nil {
		return 0, err
	}
	var (
		jobs     []pushJob
		firstErr error
	)
	for uid, tasks := range tasksByUser {
		fires := notify.PlanTasks(tasks, from, now.Sub(from))
		if len(fires) == 0 {
			continue
		}
		if s.syncGuard != nil {
			if err := s.syncGuard(ctx, uid); err != nil {
				continue // no longer entitled to sync (the cloud's subscription gate)
			}
		}
		byID := make(map[string]*domain.Task, len(tasks))
		for _, t := range tasks {
			byID[t.ID] = t
		}
		var subs []pushSubscription
		for _, f := range fires {
			task := byID[f.TaskID]
			if task.UpdatedAt.After(f.FireAt.Add(pushLateEditGrace)) {
				continue // set into the past: not a reminder anyone is waiting for
			}
			// A failure here skips the rest of this account's fires until the next sweep (they
			// are unclaimed, so still in the lookback) but never the fires already claimed.
			claimed, err := s.claimPushFire(uid, f, now)
			if err != nil {
				firstErr = errors.Join(firstErr, err)
				break
			}
			if !claimed {
				continue
			}
			if subs == nil {
				if subs, err = s.pushSubscriptionsOf(uid); err != nil {
					firstErr = errors.Join(firstErr, err)
					break
				}
			}
			payload, _ := json.Marshal(reminderPayload(task, f))
			for _, sub := range subs {
				jobs = append(jobs, pushJob{sub: sub, payload: payload})
			}
		}
	}
	return s.deliverPushes(ctx, jobs), firstErr
}

// pushCandidateTasks loads, per account with a push subscription, the open tasks that can fire:
// the same rows the apps plan from (repeat seeds excluded, as in store.TasksRepo.List), narrowed to
// those with a deadline or reminders.
func (s *Server) pushCandidateTasks() (map[string][]*domain.Task, error) {
	rows, err := s.query(
		`SELECT user_id, id, title, due_at, reminders_json, updated_at FROM tasks
		 WHERE user_id IN (SELECT DISTINCT user_id FROM push_subscriptions)
		   AND status = 'open' AND deleted_at IS NULL AND deleting_at IS NULL
		   AND NOT (repeat_rule IS NOT NULL AND repeat_seed_id IS NULL)
		   AND (due_at IS NOT NULL OR reminders_json <> '[]');`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]*domain.Task{}
	for rows.Next() {
		var (
			uid, reminders, updatedAt string
			dueAt                     sql.NullString
			t                         = &domain.Task{Status: domain.TaskOpen}
		)
		if err := rows.Scan(&uid, &t.ID, &t.Title, &dueAt, &reminders, &updatedAt); err != nil {
			return nil, err
		}
		if t.DueAt, err = parseServerTime(dueAt); err != nil {
			continue // unreadable deadline: skip the task, don't stall everyone's reminders
		}
		if t.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
			continue
		}
		t.Reminders = parseReminders(reminders)
		out[uid] = append(out[uid], t)
	}
	return out, rows.Err()
}

// maxPushTitle bounds the title a push carries (in runes): a notification shows a line or two, and
// the whole encrypted message must fit a push service's 4 KB.
const maxPushTitle = 200

// reminderPayload shapes one fire for the service worker. An encrypted title stays behind.
func reminderPayload(t *domain.Task, f notify.Notification) pushPayload {
	p := pushPayload{V: 1, Type: "reminder", TaskID: f.TaskID, Kind: f.Kind, FireAt: f.FireAt.UTC().Format(time.RFC3339)}
	if t.DueAt != nil {
		p.DueAt = t.DueAt.UTC().Format(time.RFC3339)
	}
	if t.Title != "" && !crypto.IsEnvelope(t.Title) {
		p.Title = t.Title
		if r := []rune(p.Title); len(r) > maxPushTitle {
			p.Title = string(r[:maxPushTitle-1]) + "…"
		}
	}
	return p
}

// claimPushFire records that a fire is being delivered, reporting false when it already was.
func (s *Server) claimPushFire(uid string, f notify.Notification, now time.Time) (bool, error) {
	res, err := s.exec(`INSERT INTO push_deliveries (user_id, task_id, fire_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING;`,
		uid, f.TaskID, f.FireAt.UTC().Format(timeFormat), now.Format(time.RFC3339))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// prunePushLedger drops delivery records too old to matter for de-duplication. created_at is
// fixed-width UTC, so the text comparison is chronological.
func (s *Server) prunePushLedger(now time.Time) {
	if _, err := s.exec(`DELETE FROM push_deliveries WHERE created_at < ?;`, now.Add(-pushLedgerRetention).Format(time.RFC3339)); err != nil {
		log.Printf("push: prune ledger: %v", err)
	}
}

func (s *Server) pushSubscriptionsOf(uid string) ([]pushSubscription, error) {
	rows, err := s.query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?;`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []pushSubscription{}
	for rows.Next() {
		sub := pushSubscription{userID: uid}
		if err := rows.Scan(&sub.id, &sub.endpoint, &sub.p256dh, &sub.auth); err != nil {
			return nil, err
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

// deliverPushes sends the jobs a few at a time and returns how many the push services accepted.
// A subscription the push service reports gone is deleted; other failures are logged — the fire
// stays claimed, so a failing push service costs one reminder rather than a retry storm.
func (s *Server) deliverPushes(ctx context.Context, jobs []pushJob) int {
	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		delivered int
		slots     = make(chan struct{}, pushConcurrency)
	)
	for _, job := range jobs {
		wg.Add(1)
		slots <- struct{}{}
		go func(job pushJob) {
			defer wg.Done()
			defer func() { <-slots }()
			outcome, err := s.sendPush(ctx, job.sub, pushMessage{payload: job.payload, ttl: pushTTL, urgency: "high"})
			switch outcome {
			case pushDelivered:
				mu.Lock()
				delivered++
				mu.Unlock()
			case pushGone:
				s.forgetPushSubscription(job.sub.id)
			default:
				log.Printf("push: reminder to %s failed: %v", pushServiceName(job.sub.endpoint), err)
			}
		}(job)
	}
	wg.Wait()
	return delivered
}

// pushServiceName is an endpoint's host, for logs: the full endpoint is a bearer capability.
func pushServiceName(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil && u.Host != "" {
		return u.Host
	}
	return "push service"
}
