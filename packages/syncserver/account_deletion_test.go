package syncserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/store"
)

// hookLog records the account lifecycle hooks a test server calls. purgeErr, when set, is what
// the Purge hook returns.
type hookLog struct {
	mu        sync.Mutex
	requested map[string]time.Time
	cancelled []string
	purged    []string
	purgeErr  error
}

func (h *hookLog) lifecycle() AccountLifecycle {
	return AccountLifecycle{
		DeletionRequested: func(_ context.Context, uid string, at time.Time) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.requested == nil {
				h.requested = map[string]time.Time{}
			}
			h.requested[uid] = at
		},
		DeletionCancelled: func(_ context.Context, uid string) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.cancelled = append(h.cancelled, uid)
		},
		Purge: func(_ context.Context, uid string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.purgeErr != nil {
				return h.purgeErr
			}
			h.purged = append(h.purged, uid)
			return nil
		},
	}
}

func (h *hookLog) setPurgeErr(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeErr = err
}

// The request-path hooks run on server goroutines, so reads go through the lock too.

func (h *hookLog) requestedAt(uid string) (time.Time, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	at, ok := h.requested[uid]
	return at, ok
}

func (h *hookLog) requestedCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.requested)
}

func (h *hookLog) cancelledIDs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.cancelled...)
}

func (h *hookLog) purgedIDs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.purged...)
}

// newDeletionServer is newServerAPI with a pinned clock and recorded lifecycle hooks.
func newDeletionServer(t *testing.T) (baseURL string, srv *Server, clk *testClock, hooks *hookLog) {
	t.Helper()
	ts, srv := newServerAPI(t)
	clk = &testClock{t: time.Date(2026, 9, 22, 15, 4, 5, 0, time.UTC)}
	srv.clock = clk
	hooks = &hookLog{}
	srv.lifecycle = hooks.lifecycle()
	return ts.URL, srv, clk, hooks
}

func registerUser(t *testing.T, baseURL, email string) authResponse {
	t.Helper()
	var reg authResponse
	if resp := postJSON(t, baseURL+"/v1/auth/register",
		map[string]string{"email": email, "password": "password", "firstName": "Dee"}, &reg); resp.StatusCode != http.StatusOK {
		t.Fatalf("register %s status = %d", email, resp.StatusCode)
	}
	return reg
}

// requestDeletion posts the deletion request and returns the status and decoded body.
func requestDeletion(t *testing.T, baseURL, token, password string) (int, map[string]string) {
	t.Helper()
	var out map[string]string
	resp := authedJSON(t, http.MethodPost, baseURL+"/v1/account/delete", token, map[string]string{"password": password}, &out)
	return resp.StatusCode, out
}

func deletingAtOf(t *testing.T, srv *Server, uid string) sql.NullString {
	t.Helper()
	var at sql.NullString
	if err := srv.queryRow(`SELECT deleting_at FROM users WHERE id = ?;`, uid).Scan(&at); err != nil {
		t.Fatalf("read deleting_at: %v", err)
	}
	return at
}

func countRows(t *testing.T, srv *Server, table, uid string) int {
	t.Helper()
	col := "user_id"
	if table == "users" {
		col = "id"
	}
	var n int
	if err := srv.queryRow(`SELECT COUNT(*) FROM `+table+` WHERE `+col+` = ?;`, uid).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// A wrong password (or a malformed body) changes nothing: the account stays active and the
// caller stays signed in.
func TestDeleteAccountRejectsWrongPassword(t *testing.T) {
	baseURL, srv, _, hooks := newDeletionServer(t)
	reg := registerUser(t, baseURL, "keep@b.co")

	req, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/account/delete", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+reg.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("malformed delete: %v", err)
	}
	var bad map[string]string
	json.NewDecoder(resp.Body).Decode(&bad)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || bad["error"] != "bad request" {
		t.Errorf("malformed body = %d %v, want 400 bad request", resp.StatusCode, bad)
	}

	status, out := requestDeletion(t, baseURL, reg.Token, "not-the-password")
	if status != http.StatusUnauthorized || out["error"] != "password is incorrect" {
		t.Fatalf("wrong password = %d %v, want 401 password is incorrect", status, out)
	}
	if at := deletingAtOf(t, srv, reg.UserID); at.Valid {
		t.Errorf("deleting_at = %q after a wrong password, want NULL", at.String)
	}
	if resp := authedJSON(t, http.MethodGet, baseURL+"/v1/account", reg.Token, nil, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("GET /v1/account after a wrong password = %d, want 200", resp.StatusCode)
	}
	if n := hooks.requestedCount(); n != 0 {
		t.Errorf("DeletionRequested ran %d time(s) for a wrong password", n)
	}
}

// A request schedules the purge 30 days out, signs every device out (the caller's included),
// pokes the user's live devices, and hands the date to the lifecycle hook. Asking again keeps
// the original date.
func TestDeleteAccountSchedulesAndSignsOut(t *testing.T) {
	baseURL, srv, clk, hooks := newDeletionServer(t)
	reg := registerUser(t, baseURL, "bye@b.co")
	otherDevice := login(t, baseURL, "bye@b.co", "password")

	events := srv.hub.subscribe(reg.UserID)
	defer srv.hub.unsubscribe(reg.UserID, events)

	status, out := requestDeletion(t, baseURL, reg.Token, "password")
	if status != http.StatusOK {
		t.Fatalf("delete status = %d %v, want 200", status, out)
	}
	want := clk.t.Add(accountDeletionGrace)
	got, err := time.Parse(time.RFC3339Nano, out["deletingAt"])
	if err != nil || !got.Equal(want) {
		t.Fatalf("deletingAt = %q (%v), want %s", out["deletingAt"], err, want.Format(timeFormat))
	}
	if at := deletingAtOf(t, srv, reg.UserID); at.String != want.Format(timeFormat) {
		t.Errorf("stored deleting_at = %q, want %q", at.String, want.Format(timeFormat))
	}

	// Signed out everywhere.
	for _, table := range []string{"sessions", "refresh_tokens"} {
		if n := countRows(t, srv, table, reg.UserID); n != 0 {
			t.Errorf("%s rows after the request = %d, want 0", table, n)
		}
	}
	for name, tok := range map[string]string{"caller": reg.Token, "other device": otherDevice} {
		if resp := authedJSON(t, http.MethodGet, baseURL+"/v1/account", tok, nil, nil); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s token after the request = %d, want 401", name, resp.StatusCode)
		}
	}
	if resp := postJSON(t, baseURL+"/v1/auth/refresh", map[string]string{"refreshToken": reg.RefreshToken}, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("refresh after the request = %d, want 401", resp.StatusCode)
	}

	select {
	case <-events:
	default:
		t.Error("the user's live devices were not poked to sync")
	}
	if at, ok := hooks.requestedAt(reg.UserID); !ok || !at.Equal(want) {
		t.Errorf("DeletionRequested got %s (called: %v), want %s", at, ok, want)
	}

	// A second request, a day later from a session that escaped the revocation (minted
	// directly, as a racing sign-in could), gets the same date back: the grace period is never
	// extended.
	clk.t = clk.t.Add(24 * time.Hour)
	raced, err := srv.newSession(reg.UserID)
	if err != nil {
		t.Fatalf("mint session: %v", err)
	}
	status, out = requestDeletion(t, baseURL, raced.token, "password")
	if status != http.StatusOK {
		t.Fatalf("repeat delete status = %d %v, want 200", status, out)
	}
	if again, _ := time.Parse(time.RFC3339Nano, out["deletingAt"]); !again.Equal(want) {
		t.Errorf("repeat request moved deletingAt to %q, want %s", out["deletingAt"], want.Format(timeFormat))
	}
}

// Signing in during the grace period restores the account and says so, once.
func TestLoginReactivatesScheduledAccount(t *testing.T) {
	baseURL, srv, clk, hooks := newDeletionServer(t)
	reg := registerUser(t, baseURL, "back@b.co")
	if status, out := requestDeletion(t, baseURL, reg.Token, "password"); status != http.StatusOK {
		t.Fatalf("delete status = %d %v", status, out)
	}

	clk.t = clk.t.Add(accountDeletionGrace - time.Hour)
	var first map[string]any
	if resp := postJSON(t, baseURL+"/v1/auth/login", map[string]string{"email": "back@b.co", "password": "password"}, &first); resp.StatusCode != http.StatusOK {
		t.Fatalf("login during grace = %d, want 200", resp.StatusCode)
	}
	if first["reactivated"] != true {
		t.Errorf("login during grace reactivated = %v, want true", first["reactivated"])
	}
	if at := deletingAtOf(t, srv, reg.UserID); at.Valid {
		t.Errorf("deleting_at = %q after reactivation, want NULL", at.String)
	}
	if got := hooks.cancelledIDs(); len(got) != 1 || got[0] != reg.UserID {
		t.Errorf("DeletionCancelled = %v, want [%s]", got, reg.UserID)
	}
	token, _ := first["token"].(string)
	if resp := authedJSON(t, http.MethodGet, baseURL+"/v1/account", token, nil, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("GET /v1/account with the new session = %d, want 200", resp.StatusCode)
	}

	var second map[string]any
	if resp := postJSON(t, baseURL+"/v1/auth/login", map[string]string{"email": "back@b.co", "password": "password"}, &second); resp.StatusCode != http.StatusOK {
		t.Fatalf("second login = %d, want 200", resp.StatusCode)
	}
	if _, ok := second["reactivated"]; ok {
		t.Errorf("a normal login carries reactivated: %v", second)
	}
	if got := hooks.cancelledIDs(); len(got) != 1 {
		t.Errorf("DeletionCancelled ran again for a normal login: %v", got)
	}
}

// Once the deletion instant has passed the account can't be restored: a sign-in is refused
// like an unknown address while the sweep finishes it off.
func TestLoginAfterGraceIsRefused(t *testing.T) {
	baseURL, srv, clk, hooks := newDeletionServer(t)
	reg := registerUser(t, baseURL, "late@b.co")
	if status, out := requestDeletion(t, baseURL, reg.Token, "password"); status != http.StatusOK {
		t.Fatalf("delete status = %d %v", status, out)
	}

	clk.t = clk.t.Add(accountDeletionGrace + time.Minute)
	var out map[string]string
	if resp := postJSON(t, baseURL+"/v1/auth/login", map[string]string{"email": "late@b.co", "password": "password"}, &out); resp.StatusCode != http.StatusUnauthorized || out["error"] != "invalid email or password" {
		t.Errorf("login after the grace period = %d %v, want 401 invalid email or password", resp.StatusCode, out)
	}
	if at := deletingAtOf(t, srv, reg.UserID); !at.Valid {
		t.Error("a refused login cleared deleting_at")
	}
	if got := hooks.cancelledIDs(); len(got) != 0 {
		t.Errorf("DeletionCancelled ran for a refused login: %v", got)
	}
}

// A refresh token that somehow survived the request is refused while the account is scheduled.
func TestRefreshRefusedWhileScheduled(t *testing.T) {
	baseURL, srv, clk, _ := newDeletionServer(t)
	reg := registerUser(t, baseURL, "race@b.co")
	if _, err := srv.exec(`UPDATE users SET deleting_at = ? WHERE id = ?;`,
		clk.t.Add(accountDeletionGrace).Format(timeFormat), reg.UserID); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	var out map[string]string
	resp := postJSON(t, baseURL+"/v1/auth/refresh", map[string]string{"refreshToken": reg.RefreshToken}, &out)
	if resp.StatusCode != http.StatusUnauthorized || out["error"] != "account scheduled for deletion" {
		t.Errorf("refresh while scheduled = %d %v, want 401 account scheduled for deletion", resp.StatusCode, out)
	}
}

// The sweep leaves a scheduled account alone until its instant, then deletes every row it owns
// in every per-user table, plus its document bytes, without touching anyone else's.
func TestPurgeDeletedAccounts(t *testing.T) {
	baseURL, srv, clk, hooks := newDeletionServer(t)
	ctx := context.Background()
	start := clk.t
	gone := registerUser(t, baseURL, "gone@b.co")
	keep := registerUser(t, baseURL, "keep@b.co")

	// Both users upload the same file (blob keys are per user); the leaving user also has a
	// second file behind a tombstoned row, whose bytes must go too.
	shared, extra := []byte("shared bytes"), []byte("tombstoned bytes")
	uploads := []struct {
		reg     authResponse
		content []byte
		deleted bool
	}{{gone, shared, false}, {gone, extra, true}, {keep, shared, false}}
	for i, u := range uploads {
		sha := sha256Hex(u.content)
		if status, body := blobReq(t, http.MethodPut, baseURL, u.reg.Token, sha, u.content); status != http.StatusOK {
			t.Fatalf("upload %d = %d %s", i, status, body)
		}
		var deletedAt any
		if u.deleted {
			deletedAt = start.Format(timeFormat)
		}
		if _, err := srv.exec(
			`INSERT INTO documents (id, user_id, filename, sha256, created_at, updated_at, deleted_at, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 1);`,
			u.reg.UserID+"-doc-"+sha[:8], u.reg.UserID, "file.pdf", sha, start.Format(timeFormat), start.Format(timeFormat), deletedAt); err != nil {
			t.Fatalf("insert document %d: %v", i, err)
		}
	}

	if status, out := requestDeletion(t, baseURL, gone.Token, "password"); status != http.StatusOK {
		t.Fatalf("delete status = %d %v", status, out)
	}
	// A row in every per-user table for both accounts, seeded after the request so the purge
	// also finds sessions and refresh tokens to clear.
	seedUserRows(t, srv, gone.UserID)
	seedUserRows(t, srv, keep.UserID)

	// Not due yet: the sweep leaves everything alone.
	clk.t = start.Add(accountDeletionGrace - time.Minute)
	if n, err := srv.PurgeDeletedAccounts(ctx); n != 0 || err != nil {
		t.Fatalf("early sweep = %d, %v; want 0, nil", n, err)
	}
	for _, table := range append([]string{"users"}, userTables...) {
		if countRows(t, srv, table, gone.UserID) == 0 {
			t.Errorf("early sweep deleted %s rows", table)
		}
	}
	if got := hooks.purgedIDs(); len(got) != 0 {
		t.Errorf("Purge ran before the deletion instant: %v", got)
	}

	// Due: everything the account owned is gone, and only that.
	clk.t = start.Add(accountDeletionGrace + time.Minute)
	if n, err := srv.PurgeDeletedAccounts(ctx); n != 1 || err != nil {
		t.Fatalf("sweep = %d, %v; want 1, nil", n, err)
	}
	for _, table := range append([]string{"users"}, userTables...) {
		if n := countRows(t, srv, table, gone.UserID); n != 0 {
			t.Errorf("%s still has %d row(s) for the deleted account", table, n)
		}
		if countRows(t, srv, table, keep.UserID) == 0 {
			t.Errorf("%s lost the other account's rows", table)
		}
	}
	for _, key := range []string{blobKey(gone.UserID, sha256Hex(shared)), blobKey(gone.UserID, sha256Hex(extra))} {
		if _, err := srv.blobs.Get(ctx, key); err != errBlobNotFound {
			t.Errorf("blob %s survived the purge (err %v)", key, err)
		}
	}
	if _, err := srv.blobs.Get(ctx, blobKey(keep.UserID, sha256Hex(shared))); err != nil {
		t.Errorf("the other account's blob was deleted: %v", err)
	}
	if got := hooks.purgedIDs(); len(got) != 1 || got[0] != gone.UserID {
		t.Errorf("Purge hook calls = %v, want [%s]", got, gone.UserID)
	}

	// The address is free again.
	registerUser(t, baseURL, "gone@b.co")
}

// A failing Purge hook (billing couldn't be stopped) skips the account, leaving every row and
// byte for the next sweep, which finishes the job once the hook succeeds.
func TestPurgeHookErrorSkipsAccount(t *testing.T) {
	baseURL, srv, clk, hooks := newDeletionServer(t)
	ctx := context.Background()
	reg := registerUser(t, baseURL, "stuck@b.co")
	content := []byte("still billed")
	sha := sha256Hex(content)
	if status, _ := blobReq(t, http.MethodPut, baseURL, reg.Token, sha, content); status != http.StatusOK {
		t.Fatalf("upload = %d", status)
	}
	now := clk.t.Format(timeFormat)
	if _, err := srv.exec(
		`INSERT INTO documents (id, user_id, filename, sha256, created_at, updated_at, server_seq) VALUES (?, ?, ?, ?, ?, ?, 1);`,
		"doc-stuck", reg.UserID, "bill.pdf", sha, now, now); err != nil {
		t.Fatalf("insert document: %v", err)
	}
	if status, out := requestDeletion(t, baseURL, reg.Token, "password"); status != http.StatusOK {
		t.Fatalf("delete status = %d %v", status, out)
	}

	hooks.setPurgeErr(errors.New("stripe is unreachable"))
	clk.t = clk.t.Add(accountDeletionGrace + time.Hour)
	n, err := srv.PurgeDeletedAccounts(ctx)
	if n != 0 || err == nil || !strings.Contains(err.Error(), "stripe is unreachable") {
		t.Fatalf("sweep with a failing hook = %d, %v; want 0 and the hook's error", n, err)
	}
	if countRows(t, srv, "users", reg.UserID) != 1 || countRows(t, srv, "documents", reg.UserID) != 1 {
		t.Error("a failing Purge hook still deleted rows")
	}
	if _, err := srv.blobs.Get(ctx, blobKey(reg.UserID, sha)); err != nil {
		t.Errorf("a failing Purge hook still deleted bytes: %v", err)
	}

	hooks.setPurgeErr(nil)
	if n, err := srv.PurgeDeletedAccounts(ctx); n != 1 || err != nil {
		t.Fatalf("retry sweep = %d, %v; want 1, nil", n, err)
	}
	if countRows(t, srv, "users", reg.UserID) != 0 {
		t.Error("the retry sweep left the account behind")
	}
	if _, err := srv.blobs.Get(ctx, blobKey(reg.UserID, sha)); err != errBlobNotFound {
		t.Errorf("the retry sweep left the bytes behind (err %v)", err)
	}
}

// The email names the recipient and the purge day in UTC (not the server's zone), with no
// placeholder left behind.
func TestAccountDeletionEmail(t *testing.T) {
	_, srv := newServerAPI(t)
	// 23:30 on October 21 at UTC-5 is already October 22 in UTC.
	at := time.Date(2026, 10, 21, 23, 30, 0, 0, time.FixedZone("UTC-5", -5*60*60))
	html, err := srv.accountDeletionEmail("Dee", at)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{"Your account is scheduled for deletion", "Dee", "October 22, 2026", "Sign in before then"} {
		if !strings.Contains(html, want) {
			t.Errorf("email is missing %q", want)
		}
	}
	if strings.Contains(html, "{{") {
		t.Error("email still has an unfilled placeholder")
	}
	if strings.Contains(html, "—") {
		t.Error("email copy has an em dash")
	}
	if html, _ := srv.accountDeletionEmail("  ", at); !strings.Contains(html, "there") {
		t.Error("a blank first name should greet the recipient as \"there\"")
	}
}

// Every table with a user_id column must be in userTables, or deleting an account would leave
// its rows behind. The check reads a freshly opened SQLite schema, so a table added later
// fails here until it is listed. (The cloud's own tables are its Purge hook's job and are not
// in this schema.)
func TestUserTablesCoverSchema(t *testing.T) {
	db, _, err := OpenDB(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT m.name FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p
		WHERE m.type = 'table' AND p.name = 'user_id' ORDER BY m.name;`)
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	defer rows.Close()
	listed := map[string]bool{}
	for _, table := range userTables {
		listed[table] = true
	}
	found := map[string]bool{}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatalf("scan: %v", err)
		}
		found[table] = true
		if !listed[table] {
			t.Errorf("table %s has a user_id column but is missing from userTables: deleting an account would leave its rows behind", table)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(found) == 0 {
		t.Fatal("found no tables with a user_id column; the schema query is broken")
	}
	for _, table := range userTables {
		if !found[table] {
			t.Errorf("userTables lists %s, which has no user_id column in the schema", table)
		}
	}
}

// Deleting a document for good on a device releases its bytes as soon as the tombstone is
// pushed, unless another live row of the same user still names the hash.
func TestPushedDocumentTombstoneReleasesBlob(t *testing.T) {
	ts, api := newServerAPI(t)
	token := register(t, ts.URL, "forever@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")

	content := []byte("attached twice")
	sha := sha256Hex(content)
	doc1, _ := a.store.Documents.Create(store.CreateDocumentInput{Filename: "a.pdf", Size: int64(len(content)), SHA256: sha})
	doc2, _ := a.store.Documents.Create(store.CreateDocumentInput{Filename: "a-copy.pdf", Size: int64(len(content)), SHA256: sha})
	a.store.Documents.MarkUploaded(doc1.ID)
	a.store.Documents.MarkUploaded(doc2.ID)
	if status, _ := blobReq(t, http.MethodPut, ts.URL, token, sha, content); status != http.StatusOK {
		t.Fatalf("blob upload = %d, want 200", status)
	}
	syncAll(t, a)
	key := blobKey(userIDForToken(t, api, token), sha)

	// Deleting one copy forever keeps the bytes the other still needs.
	if err := a.store.Documents.Delete(doc1.ID); err != nil {
		t.Fatalf("delete doc1: %v", err)
	}
	syncAll(t, a)
	if _, err := api.blobs.Get(context.Background(), key); err != nil {
		t.Fatalf("blob released while doc2 still references it: %v", err)
	}

	// Deleting the last copy forever releases them.
	if err := a.store.Documents.Delete(doc2.ID); err != nil {
		t.Fatalf("delete doc2: %v", err)
	}
	syncAll(t, a)
	if _, err := api.blobs.Get(context.Background(), key); err != errBlobNotFound {
		t.Errorf("blob should be released once its last row is deleted for good, got %v", err)
	}
}

// seedUserRows puts one row for uid into every table in userTables, filling each required
// column with a placeholder unique to the user, table and column. It reads the columns from the
// live schema, so a table added to userTables later is seeded without touching this helper.
func seedUserRows(t *testing.T, srv *Server, uid string) {
	t.Helper()
	for _, table := range userTables {
		var cols, marks []string
		var vals []any
		for _, c := range tableColumns(t, srv, table) {
			if c.name != "user_id" && (c.nullable || c.hasDefault) {
				continue
			}
			cols, marks = append(cols, c.name), append(marks, "?")
			switch typ := strings.ToUpper(c.typ); {
			case c.name == "user_id":
				vals = append(vals, uid)
			case strings.Contains(typ, "INT"):
				vals = append(vals, 1)
			case strings.Contains(typ, "DOUBLE"), strings.Contains(typ, "REAL"):
				vals = append(vals, 1.0)
			case strings.Contains(typ, "BYTEA"), strings.Contains(typ, "BLOB"):
				vals = append(vals, []byte("x"))
			default:
				vals = append(vals, uid+"-"+table+"-"+c.name)
			}
		}
		// ON CONFLICT: tables keyed by user_id alone (user_seq) already hold the user's row.
		q := `INSERT INTO ` + table + ` (` + strings.Join(cols, ", ") + `) VALUES (` + strings.Join(marks, ", ") + `) ON CONFLICT DO NOTHING;`
		if _, err := srv.exec(q, vals...); err != nil {
			t.Fatalf("seed %s: %v", table, err)
		}
		if countRows(t, srv, table, uid) == 0 {
			t.Fatalf("seed %s: no row for %s", table, uid)
		}
	}
}

type columnInfo struct {
	name, typ            string
	nullable, hasDefault bool
}

// tableColumns reads a table's columns from the live schema, on either dialect. A primary-key
// column counts as required even where SQLite doesn't mark it NOT NULL.
func tableColumns(t *testing.T, srv *Server, table string) []columnInfo {
	t.Helper()
	q := `SELECT name, type, "notnull" = 0 AND pk = 0, dflt_value IS NOT NULL FROM pragma_table_info(?);`
	if srv.dialect == "postgres" {
		q = `SELECT column_name, data_type, is_nullable = 'YES', column_default IS NOT NULL
		     FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?;`
	}
	rows, err := srv.query(q, table)
	if err != nil {
		t.Fatalf("columns of %s: %v", table, err)
	}
	defer rows.Close()
	var cols []columnInfo
	for rows.Next() {
		var c columnInfo
		if err := rows.Scan(&c.name, &c.typ, &c.nullable, &c.hasDefault); err != nil {
			t.Fatalf("scan columns of %s: %v", table, err)
		}
		cols = append(cols, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("columns of %s: %v", table, err)
	}
	if len(cols) == 0 {
		t.Fatalf("table %s has no columns (does it exist?)", table)
	}
	return cols
}
