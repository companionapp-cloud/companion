package syncserver

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// fakePushService stands in for Apple/Google/Mozilla: it decrypts every message with the
// subscribing browser's private key, records it, and answers with a per-path status.
type fakePushService struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	browsers map[string]fakeBrowser // path → subscribing browser
	status   map[string]int         // path → status to answer (default 201)
	got      []receivedPush
}

type fakeBrowser struct {
	priv *ecdh.PrivateKey
	auth []byte
}

type receivedPush struct {
	path    string
	header  http.Header
	payload pushPayload
}

func newFakePushService(t *testing.T) *fakePushService {
	f := &fakePushService{t: t, browsers: map[string]fakeBrowser{}, status: map[string]int{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		if code := f.status[r.URL.Path]; code != 0 {
			w.WriteHeader(code)
			return
		}
		b, ok := f.browsers[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var p pushPayload
		if err := json.Unmarshal(decryptPush(t, body, b.priv, b.auth), &p); err != nil {
			t.Errorf("payload: %v", err)
		}
		f.got = append(f.got, receivedPush{path: r.URL.Path, header: r.Header.Clone(), payload: p})
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// take returns and clears what the service has received.
func (f *fakePushService) take() []receivedPush {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.got
	f.got = nil
	return out
}

func (f *fakePushService) answer(path string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status[path] = code
}

// subscribe makes a browser at path and registers it with the server for token's account.
func (f *fakePushService) subscribe(t *testing.T, apiURL, token, path, deviceID string) string {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	rand.Read(auth)
	f.mu.Lock()
	f.browsers[path] = fakeBrowser{priv: priv, auth: auth}
	f.mu.Unlock()
	endpoint := f.srv.URL + path
	resp := authedPost(t, apiURL+"/v1/push/subscribe", token, map[string]any{
		"deviceId": deviceID,
		"subscription": map[string]any{
			"endpoint":       endpoint,
			"expirationTime": nil,
			"keys":           map[string]string{"p256dh": b64.EncodeToString(priv.PublicKey().Bytes()), "auth": b64.EncodeToString(auth)},
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("subscribe %s: status %d", path, resp.StatusCode)
	}
	return endpoint
}

func authedPost(t *testing.T, url, token string, body any) *http.Response {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

// pushTestServer is newServerAPI with a server clock at `base` and endpoints on the local fake
// push service allowed.
func pushTestServer(t *testing.T) (*httptest.Server, *Server, *testClock) {
	t.Helper()
	ts, srv := newServerAPI(t)
	clk := &testClock{t: base}
	srv.clock = clk
	srv.pushEndpointOK = func(string) error { return nil }
	return ts, srv, clk
}

func userOf(t *testing.T, srv *Server, token string) string {
	t.Helper()
	var uid string
	if err := srv.queryRow(`SELECT user_id FROM sessions WHERE token = ?;`, token).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	return uid
}

func countSubscriptions(t *testing.T, srv *Server, where string, args ...any) int {
	t.Helper()
	var n int
	if err := srv.queryRow(`SELECT count(*) FROM push_subscriptions WHERE `+where+`;`, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func sweep(t *testing.T, srv *Server) int {
	t.Helper()
	n, err := srv.SendDueReminders(context.Background())
	if err != nil {
		t.Fatalf("SendDueReminders: %v", err)
	}
	return n
}

func at(d time.Duration) *time.Time {
	v := base.Add(d)
	return &v
}

// Reminders created on one device reach a subscribed browser as they come due — each once, with
// the apps' own fires (a deadline alone fires at the deadline; reminders replace that).
func TestPushDeliversDueReminders(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "push@b.co", "password")
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/phone", "phone-1")

	c := newClient(t, ts.URL, token, "devA")
	rent, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "Pay rent", DueAt: at(time.Hour)})
	call, _ := c.store.Tasks.Create(store.CreateTaskInput{
		Title: "Call mum", DueAt: at(2 * time.Hour), Reminders: []domain.Reminder{{Before: "PT30M"}},
	})
	done, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "Already done", DueAt: at(time.Hour)})
	doneStatus := domain.TaskDone
	c.store.Tasks.Update(done.ID, store.UpdateTaskInput{Status: &doneStatus})
	rule := "FREQ=DAILY"
	c.store.Tasks.Create(store.CreateTaskInput{Title: "Repeating seed", DueAt: at(time.Hour), RepeatRule: &rule})
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}

	// Nothing is due yet.
	clk.t = base.Add(59 * time.Minute)
	if n := sweep(t, srv); n != 0 {
		t.Fatalf("early sweep sent %d", n)
	}

	clk.t = base.Add(time.Hour + 2*time.Second)
	if n := sweep(t, srv); n != 1 {
		t.Fatalf("sent %d, want 1 (the deadline of Pay rent only)", n)
	}
	got := push.take()
	if len(got) != 1 {
		t.Fatalf("received %d", len(got))
	}
	p := got[0].payload
	if p.Type != "reminder" || p.TaskID != rent.ID || p.Kind != "due" || p.Title != "Pay rent" ||
		p.FireAt != "2020-01-01T13:00:00Z" || p.DueAt != "2020-01-01T13:00:00Z" {
		t.Fatalf("payload = %+v", p)
	}
	h := got[0].header
	if h.Get("Content-Encoding") != "aes128gcm" || h.Get("TTL") != "14400" || h.Get("Urgency") != "high" ||
		!strings.HasPrefix(h.Get("Authorization"), "vapid t=") {
		t.Fatalf("headers = %v", h)
	}

	// A later sweep inside the lookback doesn't send it again.
	clk.t = base.Add(time.Hour + 20*time.Second)
	if n := sweep(t, srv); n != 0 {
		t.Fatalf("re-sent %d", n)
	}

	// The relative reminder fires 30 minutes before its deadline, and the deadline itself stays
	// quiet because the task has reminders.
	clk.t = base.Add(90*time.Minute + time.Second)
	sweep(t, srv)
	clk.t = base.Add(2*time.Hour + time.Second)
	sweep(t, srv)
	got = push.take()
	if len(got) != 1 || got[0].payload.TaskID != call.ID || got[0].payload.Kind != "reminder" ||
		got[0].payload.FireAt != "2020-01-01T13:30:00Z" || got[0].payload.DueAt != "2020-01-01T14:00:00Z" {
		t.Fatalf("received %+v", got)
	}
}

// A fire older than the lookback is dropped rather than delivered stale.
func TestPushDropsStaleFires(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "stale@b.co", "password")
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/a", "dev-a")
	c := newClient(t, ts.URL, token, "devA")
	c.store.Tasks.Create(store.CreateTaskInput{Title: "Long gone", DueAt: at(time.Hour)})
	c.engine.Sync()

	clk.t = base.Add(time.Hour + pushLookback + time.Minute)
	if n := sweep(t, srv); n != 0 || len(push.take()) != 0 {
		t.Fatalf("stale fire sent")
	}
}

// Encrypted titles never leave the server; a reminder moved into the past isn't sent; a gone
// subscription is forgotten; and the cloud's sync gate holds pushes back without losing them.
// (The timeline stays inside the one-hour access token so the client keeps syncing.)
func TestPushTitlesEditsGoneAndGuard(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "edge@b.co", "password")
	uid := userOf(t, srv, token)
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/laptop", "laptop")

	c := newClient(t, ts.URL, token, "devA")
	secret, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "placeholder", DueAt: at(30 * time.Minute)})
	moved, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "Moved into the past", DueAt: at(3 * time.Hour)})
	grace, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "Edited just after", DueAt: at(30 * time.Minute)})
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	// What an encrypted account's row holds: an envelope, not a title.
	if _, err := srv.exec(`UPDATE tasks SET title = ? WHERE id = ?;`, "enc$v1$AAAAsealed", secret.ID); err != nil {
		t.Fatal(err)
	}
	// At 0:33 the user moves one deadline to 0:30 (three minutes ago); at 0:31 they rename a task
	// whose deadline passed a minute before. Only the latter is still a reminder worth sending.
	c.clk.t = base.Add(33 * time.Minute)
	if _, err := c.store.Tasks.Update(moved.ID, store.UpdateTaskInput{DueAt: at(30 * time.Minute)}); err != nil {
		t.Fatalf("move: %v", err)
	}
	c.clk.t = base.Add(31 * time.Minute)
	title := "Edited just after (renamed)"
	if _, err := c.store.Tasks.Update(grace.ID, store.UpdateTaskInput{Title: &title}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	// The server clamps client times from its future, so its clock moves on with the client's.
	clk.t = base.Add(34 * time.Minute)
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}

	// The sync gate refuses: nothing is sent, and nothing is claimed either.
	srv.syncGuard = func(context.Context, string) error { return errors.New("subscription required") }
	if n := sweep(t, srv); n != 0 {
		t.Fatalf("guarded sweep sent %d", n)
	}
	srv.syncGuard = nil
	sweep(t, srv)
	got := push.take()
	byTask := map[string]pushPayload{}
	for _, g := range got {
		byTask[g.payload.TaskID] = g.payload
	}
	if len(got) != 2 {
		t.Fatalf("received %d, want 2: %+v", len(got), got)
	}
	if p, ok := byTask[secret.ID]; !ok || p.Title != "" {
		t.Fatalf("encrypted task payload = %+v (sent %v)", p, ok)
	}
	if p, ok := byTask[grace.ID]; !ok || p.Title != title {
		t.Fatalf("edited task payload = %+v (sent %v)", p, ok)
	}
	if _, ok := byTask[moved.ID]; ok {
		t.Fatal("a reminder moved into the past was sent")
	}

	// The browser uninstalled the app: the push service answers 410 and the subscription goes.
	push.answer("/sub/laptop", http.StatusGone)
	c.clk.t = base.Add(35 * time.Minute)
	clk.t = base.Add(35 * time.Minute)
	c.store.Tasks.Create(store.CreateTaskInput{Title: "Next", DueAt: at(36 * time.Minute)})
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	clk.t = base.Add(36*time.Minute + time.Second)
	sweep(t, srv)
	if n := countSubscriptions(t, srv, "user_id = ?", uid); n != 0 {
		t.Fatalf("gone subscription kept (%d)", n)
	}
}

// A title too long for a push is shortened rather than losing the reminder to the 4 KB limit.
func TestPushTruncatesLongTitles(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "long@b.co", "password")
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/a", "dev-a")
	c := newClient(t, ts.URL, token, "devA")
	c.store.Tasks.Create(store.CreateTaskInput{Title: strings.Repeat("é", 5000), DueAt: at(10 * time.Minute)})
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	clk.t = base.Add(10*time.Minute + time.Second)
	if n := sweep(t, srv); n != 1 {
		t.Fatalf("sent %d", n)
	}
	got := push.take()
	if title := []rune(got[0].payload.Title); len(title) != maxPushTitle || title[len(title)-1] != '…' {
		t.Fatalf("title has %d runes", len(title))
	}
}

// Every subscribed browser of the account gets the reminder.
func TestPushFansOutToEveryBrowser(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "fan@b.co", "password")
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/phone", "phone")
	push.subscribe(t, ts.URL, token, "/sub/tablet", "tablet")
	other := register(t, ts.URL, "other@b.co", "password")
	push.subscribe(t, ts.URL, other, "/sub/someone-else", "elsewhere")

	c := newClient(t, ts.URL, token, "devA")
	c.store.Tasks.Create(store.CreateTaskInput{Title: "Standup", Reminders: []domain.Reminder{{At: at(10 * time.Minute)}}})
	c.engine.Sync()
	clk.t = base.Add(10*time.Minute + time.Second)
	if n := sweep(t, srv); n != 2 {
		t.Fatalf("sent %d, want 2", n)
	}
	paths := map[string]bool{}
	for _, g := range push.take() {
		paths[g.path] = true
		if g.payload.Kind != "reminder" || g.payload.DueAt != "" || g.payload.Title != "Standup" {
			t.Fatalf("payload = %+v", g.payload)
		}
	}
	if !paths["/sub/phone"] || !paths["/sub/tablet"] || paths["/sub/someone-else"] {
		t.Fatalf("delivered to %v", paths)
	}
}

func TestPushSubscriptionEndpoints(t *testing.T) {
	ts, srv, _ := pushTestServer(t)
	token := register(t, ts.URL, "subs@b.co", "password")
	uid := userOf(t, srv, token)
	push := newFakePushService(t)

	// The config hands out the key subscriptions must be made with.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/push/config", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct{ PublicKey string }
	json.NewDecoder(resp.Body).Decode(&cfg)
	resp.Body.Close()
	if cfg.PublicKey == "" || cfg.PublicKey != srv.vapid.publicKey() {
		t.Fatalf("config public key = %q", cfg.PublicKey)
	}

	// Re-registering an endpoint refreshes it; a device registering a new endpoint retires its old one.
	first := push.subscribe(t, ts.URL, token, "/sub/one", "device-1")
	push.subscribe(t, ts.URL, token, "/sub/one", "device-1")
	if n := countSubscriptions(t, srv, "user_id = ?", uid); n != 1 {
		t.Fatalf("after re-register: %d", n)
	}
	second := push.subscribe(t, ts.URL, token, "/sub/two", "device-1")
	if n := countSubscriptions(t, srv, "user_id = ? AND endpoint = ?", uid, first); n != 0 {
		t.Fatal("device kept its old endpoint")
	}

	// The test notification reaches the browser; an endpoint that isn't the caller's is a 404.
	if resp := authedPost(t, ts.URL+"/v1/push/test", token, map[string]string{"endpoint": second}); resp.StatusCode != http.StatusOK {
		t.Fatalf("test push status %d", resp.StatusCode)
	}
	if got := push.take(); len(got) != 1 || got[0].payload.Type != "test" || got[0].payload.Body == "" {
		t.Fatalf("test push = %+v", got)
	}
	if resp := authedPost(t, ts.URL+"/v1/push/test", token, map[string]string{"endpoint": first}); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("test push to an unknown endpoint: %d", resp.StatusCode)
	}

	// An endpoint belongs to whoever registered it last (the account signed in on that browser).
	other := register(t, ts.URL, "subs2@b.co", "password")
	push.subscribe(t, ts.URL, other, "/sub/two", "device-9")
	if n := countSubscriptions(t, srv, "user_id = ? AND endpoint = ?", userOf(t, srv, other), second); n != 1 {
		t.Fatal("endpoint not reassigned to the account that registered it last")
	}

	// Unsubscribing is idempotent and scoped to the caller.
	push.subscribe(t, ts.URL, token, "/sub/three", "device-2")
	if resp := authedPost(t, ts.URL+"/v1/push/unsubscribe", token, map[string]string{"endpoint": push.srv.URL + "/sub/three"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("unsubscribe: %d", resp.StatusCode)
	}
	if resp := authedPost(t, ts.URL+"/v1/push/unsubscribe", token, map[string]string{"endpoint": push.srv.URL + "/sub/three"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("repeat unsubscribe: %d", resp.StatusCode)
	}
	if resp := authedPost(t, ts.URL+"/v1/push/unsubscribe", token, map[string]string{"endpoint": second}); resp.StatusCode != http.StatusOK {
		t.Fatal("unsubscribe of another account's endpoint errored")
	}
	if n := countSubscriptions(t, srv, "endpoint = ?", second); n != 1 {
		t.Fatal("unsubscribe removed another account's endpoint")
	}

	// An account's subscriptions are capped.
	for i := 0; i < maxPushSubscriptions+3; i++ {
		push.subscribe(t, ts.URL, token, "/sub/many/"+string(rune('a'+i)), "")
	}
	if n := countSubscriptions(t, srv, "user_id = ?", uid); n != maxPushSubscriptions {
		t.Fatalf("subscriptions = %d, want the cap %d", n, maxPushSubscriptions)
	}
}

func TestPushSubscribeValidation(t *testing.T) {
	ts, _ := newServerAPI(t) // the real endpoint check: only known push services
	token := register(t, ts.URL, "valid@b.co", "password")
	priv, _ := ecdh.P256().GenerateKey(rand.Reader)
	goodKey := b64.EncodeToString(priv.PublicKey().Bytes())
	goodAuth := b64.EncodeToString(make([]byte, 16))
	sub := func(endpoint, p256dh, auth string) int {
		return authedPost(t, ts.URL+"/v1/push/subscribe", token, map[string]any{
			"deviceId":     "d",
			"subscription": map[string]any{"endpoint": endpoint, "keys": map[string]string{"p256dh": p256dh, "auth": auth}},
		}).StatusCode
	}
	if code := sub("https://fcm.googleapis.com/fcm/send/abc", goodKey, goodAuth); code != http.StatusOK {
		t.Fatalf("valid subscription: %d", code)
	}
	for name, code := range map[string]int{
		"internal host":  sub("https://10.0.0.5/push", goodKey, goodAuth),
		"plain http":     sub("http://fcm.googleapis.com/fcm/send/abc", goodKey, goodAuth),
		"off-curve key":  sub("https://fcm.googleapis.com/fcm/send/x", b64.EncodeToString(append([]byte{4}, make([]byte, 64)...)), goodAuth),
		"short auth":     sub("https://fcm.googleapis.com/fcm/send/y", goodKey, b64.EncodeToString(make([]byte, 8))),
		"missing fields": sub("", "", ""),
	} {
		if code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
	// Push endpoints need a session like everything else.
	resp, err := http.Get(ts.URL + "/v1/push/config")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated config: %d", resp.StatusCode)
	}
}

// The generated key pair is stored once and shared by every server on the database; configured
// keys take precedence.
func TestVAPIDKeysPersistAndOverride(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "push.db")
	open := func() *Server {
		db, dialect, err := OpenDB(dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return New(db, dialect)
	}
	a, b := open(), open()
	if a.vapid.publicKey() != b.vapid.publicKey() {
		t.Fatal("a restarted server generated a new VAPID key")
	}

	pinned, _ := newVAPIDKeys()
	t.Setenv("VAPID_PUBLIC_KEY", pinned.publicKey())
	t.Setenv("VAPID_PRIVATE_KEY", pinned.privateKey())
	t.Setenv("VAPID_SUBJECT", "mailto:ops@example.com")
	c := open()
	if c.vapid.publicKey() != pinned.publicKey() || c.vapidSubject != "mailto:ops@example.com" {
		t.Fatalf("configured keys ignored: %s %s", c.vapid.publicKey(), c.vapidSubject)
	}
}

// An account scheduled for deletion gets no reminders, whichever browsers are still subscribed
// (its devices were signed out server-side, so they can't unsubscribe), and a sign-in that takes
// the deletion back brings them back.
func TestPushPausedWhileAccountIsScheduledForDeletion(t *testing.T) {
	ts, srv, clk := pushTestServer(t)
	token := register(t, ts.URL, "leaving@b.co", "password")
	push := newFakePushService(t)
	push.subscribe(t, ts.URL, token, "/sub/phone", "phone-1")
	c := newClient(t, ts.URL, token, "devA")
	c.store.Tasks.Create(store.CreateTaskInput{Title: "During the grace period", DueAt: at(time.Hour)})
	later, _ := c.store.Tasks.Create(store.CreateTaskInput{Title: "After coming back", DueAt: at(3 * time.Hour)})
	if err := c.engine.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}

	if status, out := requestDeletion(t, ts.URL, token, "password"); status != http.StatusOK {
		t.Fatalf("delete status = %d %v", status, out)
	}
	clk.t = base.Add(time.Hour + 2*time.Second)
	if n := sweep(t, srv); n != 0 || len(push.take()) != 0 {
		t.Fatalf("sent %d reminder(s) to an account scheduled for deletion", n)
	}

	var login map[string]any
	if resp := postJSON(t, ts.URL+"/v1/auth/login", map[string]string{"email": "leaving@b.co", "password": "password"}, &login); resp.StatusCode != http.StatusOK || login["reactivated"] != true {
		t.Fatalf("login = %d %v, want a reactivating 200", resp.StatusCode, login)
	}
	clk.t = base.Add(3*time.Hour + 2*time.Second)
	if n := sweep(t, srv); n != 1 {
		t.Fatalf("sent %d after reactivation, want 1", n)
	}
	if got := push.take(); len(got) != 1 || got[0].payload.TaskID != later.ID {
		t.Fatalf("received %+v, want the task due after coming back", got)
	}
}
