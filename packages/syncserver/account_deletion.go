package syncserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Account deletion (shared by the open-core server and the cloud). A signed-in user asks for
// their sync account to be deleted: every device is signed out at once, and the account and
// everything in it are purged accountDeletionGrace later by the hourly sweep. Until then the
// data is left exactly as it was, and signing in with the account's email and password takes
// the request back (handleLogin → cancelAccountDeletion). Nothing else does: every session is
// revoked, and a password reset mints none, so the next sign-in is the only way back in.

// accountDeletionGrace is how long a scheduled account waits before it is purged.
const accountDeletionGrace = 30 * 24 * time.Hour

// accountHookTimeout bounds one lifecycle hook call (the cloud's reach Stripe), so a slow
// billing provider can delay a response or a sweep but never hang it.
const accountHookTimeout = 30 * time.Second

// userTables lists every table holding a user's rows, keyed by user_id, in the order an
// account purge deletes them; the users row itself goes last. The entity tables have no
// foreign keys between them, but children still precede their parents, and devices and agents
// (which REFERENCES users(id)) precede the users row, as Postgres requires. A table added with
// a user_id column belongs here: TestUserTablesCoverSchema fails until it is listed.
var userTables = []string{
	// Credentials.
	"sessions",
	"refresh_tokens",
	"email_verification_tokens",
	// Synced content.
	"note_ink",
	"notes",
	"notification_reads",
	"tasks",
	"list_items",
	"lists",
	"project_members",
	"projects",
	"areas",
	"documents",
	"object_types",
	"canvas_edges",
	"canvas_nodes",
	"canvases",
	"chat_messages",
	"chats",
	"calendar_events",
	"calendar_feeds",
	"calendar_objects",
	"calendar_accounts",
	"git_exports",
	"folder_exports",
	"onboarding",
	"pomodoros",
	// Devices and what is routed through them.
	"relay_requests",
	"push_deliveries",
	"push_subscriptions",
	"agents",
	"devices",
	// Account-level state.
	"user_secrets",
	"user_keys",
	"user_seq",
}

type deleteAccountRequest struct {
	// Password is exactly the credential /v1/auth/login takes: the raw password, or for an
	// end-to-end-encrypted account the derived auth key (PLAN §E2EE).
	Password string `json:"password"`
}

// handleDeleteAccount schedules the caller's account for deletion once their password checks
// out. One transaction stamps users.deleting_at (asking again keeps the first date, so the grace
// period is never extended) and revokes every session and refresh token, the caller's included.
// Then it pokes the user's other live devices so they sync, find their session gone and sign
// out; runs the DeletionRequested hook; and emails the date. It is not sync-guarded, so a
// lapsed subscriber can still delete their account.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req deleteAccountRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	var hash, email, first string
	if err := s.queryRow(`SELECT password_hash, email, first_name FROM users WHERE id = ?;`, uid).
		Scan(&hash, &email, &first); err != nil {
		writeErr(w, http.StatusInternalServerError, "account lookup failed")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "password is incorrect")
		return
	}
	deletingAt, err := s.scheduleAccountDeletion(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not schedule deletion")
		return
	}
	// The other devices' tokens are already dead; this makes them notice now rather than on
	// their next timer. Any seq will do: a change event is only a "sync now" poke.
	s.hub.publish(uid, s.currentSeq(uid))
	if hook := s.lifecycle.DeletionRequested; hook != nil {
		runAccountHook(r.Context(), "deletion requested", func(ctx context.Context) { hook(ctx, uid, deletingAt) })
	}
	s.sendAccountDeletionEmailAsync(uid, email, first, deletingAt)
	writeJSON(w, http.StatusOK, map[string]string{"deletingAt": deletingAt.Format(timeFormat)})
}

// scheduleAccountDeletion stamps the account's purge instant and revokes all of its sessions and
// refresh tokens in one transaction, returning the instant in effect. An account already
// scheduled keeps its original date.
func (s *Server) scheduleAccountDeletion(uid string) (time.Time, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback()
	due := s.clock.Now().UTC().Add(accountDeletionGrace).Format(timeFormat)
	if _, err := tx.Exec(s.rebind(
		`UPDATE users SET deleting_at = COALESCE(deleting_at, ?) WHERE id = ?;`), due, uid); err != nil {
		return time.Time{}, err
	}
	var stored string
	if err := tx.QueryRow(s.rebind(`SELECT deleting_at FROM users WHERE id = ?;`), uid).Scan(&stored); err != nil {
		return time.Time{}, err
	}
	deletingAt, err := time.Parse(timeFormat, stored)
	if err != nil {
		return time.Time{}, err
	}
	if _, err := tx.Exec(s.rebind(`DELETE FROM sessions WHERE user_id = ?;`), uid); err != nil {
		return time.Time{}, err
	}
	if _, err := tx.Exec(s.rebind(`DELETE FROM refresh_tokens WHERE user_id = ?;`), uid); err != nil {
		return time.Time{}, err
	}
	if err := tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return deletingAt, nil
}

// currentSeq reads a user's latest server_seq (0 when they have none yet), for a change poke
// that isn't tied to a write of its own.
func (s *Server) currentSeq(uid string) int64 {
	var seq int64
	_ = s.queryRow(`SELECT seq FROM user_seq WHERE user_id = ?;`, uid).Scan(&seq)
	return seq
}

// sendAccountDeletionEmailAsync tells the owner when their account will be deleted and how to
// stop it, without holding up the response. Failures are only logged; Send itself just logs
// the message when SMTP is unconfigured.
func (s *Server) sendAccountDeletionEmailAsync(uid, email, first string, deletingAt time.Time) {
	go func() {
		html, err := s.accountDeletionEmail(first, deletingAt)
		if err == nil {
			err = s.mailer.Send(email, "Your Companion account will be deleted", html)
		}
		if err != nil {
			slog.Error("account deletion: send email", "user", uid, "err", err)
		}
	}()
}

// accountDeletionEmail renders the "scheduled for deletion" email. The date is the UTC calendar
// day of the purge instant, written out for humans ("October 22, 2026").
func (s *Server) accountDeletionEmail(first string, deletingAt time.Time) (string, error) {
	return s.mailer.Template("account-deletion.html", map[string]string{
		"firstName":  greetingName(first),
		"deleteDate": deletingAt.UTC().Format("January 2, 2006"),
	})
}

// cancelAccountDeletion takes back a pending deletion for a user who has just proved their
// password at sign-in, then runs the DeletionCancelled hook. It reports false when the account
// can no longer be restored: its deletion instant has passed (the sweep is only carrying out a
// deletion already due, so the account counts as gone), or the sweep erased it while the
// sign-in was in flight. Refusing past the instant also means a sign-in can never revive an
// account the sweep has started on (billing cancelled, bytes deleted) but not yet finished.
func (s *Server) cancelAccountDeletion(ctx context.Context, uid, deletingAt string) (bool, error) {
	if due, err := time.Parse(timeFormat, deletingAt); err == nil && !s.clock.Now().UTC().Before(due) {
		return false, nil
	}
	res, err := s.exec(`UPDATE users SET deleting_at = NULL WHERE id = ?;`, uid)
	if err != nil {
		return false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return false, err
	}
	if hook := s.lifecycle.DeletionCancelled; hook != nil {
		runAccountHook(ctx, "deletion cancelled", func(ctx context.Context) { hook(ctx, uid) })
	}
	return true, nil
}

// runAccountHook runs a lifecycle hook on behalf of a request that must not fail because of
// it: the context is detached from the request (the client may disconnect as soon as it has
// its answer) and bounded by accountHookTimeout, and a panic is logged instead of propagated.
func runAccountHook(ctx context.Context, name string, fn func(context.Context)) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), accountHookTimeout)
	defer cancel()
	defer func() {
		if p := recover(); p != nil {
			slog.Error("account lifecycle hook panicked", "hook", name, "panic", p)
		}
	}()
	fn(ctx)
}

// PurgeDeletedAccounts permanently deletes every account whose deletion grace period has run
// out, returning how many it deleted. Each account goes in three steps: the Purge hook (the
// cloud ends billing), then the bytes of its documents in object storage, then every row it
// owns in one transaction. A failed step leaves that account for the next sweep and is
// reported in the returned error; the sweep carries on with the other accounts.
func (s *Server) PurgeDeletedAccounts(ctx context.Context) (int, error) {
	due, err := s.accountsDueForPurge(ctx)
	if err != nil {
		return 0, err
	}
	purged := 0
	var errs []error
	for _, a := range due {
		switch ok, err := s.purgeAccount(ctx, a.id, a.deletingAt); {
		case err != nil:
			errs = append(errs, fmt.Errorf("account %s: %w", a.id, err))
		case ok:
			purged++
		}
	}
	return purged, errors.Join(errs...)
}

// dueAccount is an account whose deletion instant has passed, with the deleting_at value the
// sweep saw (the final delete is conditioned on it still being there).
type dueAccount struct{ id, deletingAt string }

// accountsDueForPurge lists the accounts whose deletion instant has passed. The instants are
// compared as parsed times, not as text, because RFC3339Nano has variable-width fractions.
func (s *Server) accountsDueForPurge(ctx context.Context) ([]dueAccount, error) {
	now := s.clock.Now().UTC()
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT id, deleting_at FROM users WHERE deleting_at IS NOT NULL;`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var due []dueAccount
	for rows.Next() {
		var a dueAccount
		if err := rows.Scan(&a.id, &a.deletingAt); err != nil {
			return nil, err
		}
		if at, err := time.Parse(timeFormat, a.deletingAt); err == nil && !at.After(now) {
			due = append(due, a)
		}
	}
	return due, rows.Err()
}

// purgeAccount erases one account whose grace period is over. The Purge hook runs first, so
// billing is settled before anything is deleted: an error from it skips the account (it is
// retried next sweep) and nothing is lost. It reports false with no error when the account
// turned out to be restored after all, leaving everything in place.
func (s *Server) purgeAccount(ctx context.Context, uid, deletingAt string) (bool, error) {
	if err := s.runPurgeHook(ctx, uid); err != nil {
		return false, fmt.Errorf("purge hook: %w", err)
	}
	// Bytes before rows: object storage can't be listed, so a document's bytes can only be found
	// through its row. A failure keeps the rows, so the next sweep can find the bytes again
	// rather than orphaning them for good.
	if err := s.deleteAccountBlobs(ctx, uid); err != nil {
		return false, fmt.Errorf("document bytes: %w", err)
	}
	return s.deleteAccountRows(ctx, uid, deletingAt)
}

// runPurgeHook calls the optional Purge hook under accountHookTimeout, turning a panic into an
// error so a misbehaving hook skips its account instead of taking the sweep down with it.
func (s *Server) runPurgeHook(ctx context.Context, uid string) (err error) {
	if s.lifecycle.Purge == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, accountHookTimeout)
	defer cancel()
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return s.lifecycle.Purge(ctx, uid)
}

// deleteAccountBlobs removes from object storage the bytes of every document the user synced,
// live or tombstoned. An object that is already gone is fine (bytes can be withheld from
// upload, or released earlier by a delete). Bytes uploaded for a row that was never pushed
// have no row to name them and can't be found.
func (s *Server) deleteAccountBlobs(ctx context.Context, uid string) error {
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT DISTINCT sha256 FROM documents WHERE user_id = ?;`), uid)
	if err != nil {
		return err
	}
	var shas []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return err
		}
		shas = append(shas, sha)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var errs []error
	for _, sha := range shas {
		if err := s.blobs.Delete(ctx, blobKey(uid, sha)); err != nil && !errors.Is(err, errBlobNotFound) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// deleteAccountRows deletes every row the user owns across userTables, then the users row, in
// one transaction. The users row goes only if it still carries the deleting_at the sweep saw;
// if a sign-in cleared it in the meantime, everything rolls back and it reports false.
func (s *Server) deleteAccountRows(ctx context.Context, uid, deletingAt string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	for _, table := range userTables {
		// Table names come from the compile-time list above, never input, so splicing is safe.
		if _, err := tx.ExecContext(ctx, s.rebind(`DELETE FROM `+table+` WHERE user_id = ?;`), uid); err != nil {
			return false, fmt.Errorf("delete %s: %w", table, err)
		}
	}
	res, err := tx.ExecContext(ctx, s.rebind(`DELETE FROM users WHERE id = ? AND deleting_at = ?;`), uid, deletingAt)
	if err != nil {
		return false, fmt.Errorf("delete user: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return false, err // restored since the sweep looked: roll it all back
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}
