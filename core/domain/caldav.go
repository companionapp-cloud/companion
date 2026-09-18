package domain

import (
	"errors"
	"strings"
	"time"
)

// Auth kinds for a CalendarAccount: a username and (app) password, or an OAuth grant.
const (
	CalendarAuthBasic = "basic"
	// CalendarAuthOAuthGoogle authenticates with a Google OAuth refresh token (PLAN-caldav.md §9).
	CalendarAuthOAuthGoogle = "oauth-google"
)

// OAuthProvider is the core/oauth provider id behind an auth kind, or "" for basic auth.
func OAuthProvider(authKind string) string {
	if authKind == CalendarAuthOAuthGoogle {
		return "google"
	}
	return ""
}

// CalendarAccount is a login on a CalDAV server (PLAN-caldav.md §1). Each calendar the account
// exposes is a CalendarFeed of kind caldav pointing back here. The account syncs like any entity
// so every device can push changes, but only native clients ever talk to the provider — the sync
// server never sees the URL, the username, the credential or an event.
type CalendarAccount struct {
	ID string `json:"id"`
	// Name is the display label ("iCloud", "Fastmail").
	Name string `json:"name"`
	// ServerURL is what the user entered; discovery starts here.
	ServerURL string `json:"serverUrl"`
	Username  string `json:"username"`
	AuthKind  string `json:"authKind"`
	// OAuthClientID is the OAuth client that obtained the credential of an OAuth account. A refresh
	// token only works with the client id it was issued to, and client ids are per platform
	// (Google gives desktop, iOS and Android each their own) — so a device whose build carries a
	// different client id cannot use this credential and leaves the syncing to one that can.
	OAuthClientID string `json:"oauthClientId,omitempty"`
	// CredentialEnc is the password (an app-specific password on iCloud/Fastmail), or the OAuth
	// refresh token of an OAuth account. On the wire it
	// is an enc$v1$ envelope; locally it is plaintext, decrypted on pull — the same convention as
	// Agent.APIKeyEnc. Nil when the credential lives only in the device secret store.
	CredentialEnc *string `json:"credentialEnc,omitempty"`
	// CredentialRef is the device secret-store handle used when the account is not end-to-end
	// encrypted, so the password never syncs in the clear.
	CredentialRef *string `json:"credentialRef,omitempty"`
	// HomeSetURL is the discovered calendar-home-set, kept so a rescan can skip discovery.
	HomeSetURL string `json:"homeSetUrl"`
	// LastError is the most recent sync failure, shown in settings; nil when healthy.
	LastError *string    `json:"lastError,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidCalendarAccount is returned when an account fails validation.
var ErrInvalidCalendarAccount = errors.New("invalid calendar account")

// Validate checks the invariants that must hold before an account is persisted.
func (a *CalendarAccount) Validate() error {
	if strings.TrimSpace(a.ID) == "" {
		return errors.Join(ErrInvalidCalendarAccount, errors.New("id is required"))
	}
	if strings.TrimSpace(a.Name) == "" {
		return errors.Join(ErrInvalidCalendarAccount, errors.New("name is required"))
	}
	if strings.TrimSpace(a.ServerURL) == "" {
		return errors.Join(ErrInvalidCalendarAccount, errors.New("server url is required"))
	}
	switch a.AuthKind {
	case CalendarAuthBasic:
	case CalendarAuthOAuthGoogle:
		if strings.TrimSpace(a.OAuthClientID) == "" {
			return errors.Join(ErrInvalidCalendarAccount, errors.New("an oauth account records its client id"))
		}
	default:
		return errors.Join(ErrInvalidCalendarAccount, errors.New("unknown auth kind "+a.AuthKind))
	}
	return nil
}

// IsOAuth reports whether the account signs in with an OAuth grant rather than a password.
func (a *CalendarAccount) IsOAuth() bool { return OAuthProvider(a.AuthKind) != "" }

// HasCredential reports whether a credential is available in either storage.
func (a *CalendarAccount) HasCredential() bool {
	return (a.CredentialEnc != nil && *a.CredentialEnc != "") || (a.CredentialRef != nil && *a.CredentialRef != "")
}

// SyncEntity implementation (PLAN §7).
func (a *CalendarAccount) SyncID() string           { return a.ID }
func (a *CalendarAccount) SyncVersion() int64       { return a.Version }
func (a *CalendarAccount) SyncUpdatedAt() time.Time { return a.UpdatedAt }
func (a *CalendarAccount) SyncDeleted() bool        { return a.DeletedAt != nil }
func (a *CalendarAccount) SyncDirty() bool          { return a.Dirty }

// PushState is where a CalendarObject stands relative to the provider.
type PushState string

const (
	// PushSynced: the local ICS is what the provider has (as of the last pull).
	PushSynced PushState = "synced"
	// PushPendingCreate: created locally, not on the provider yet.
	PushPendingCreate PushState = "pending_create"
	// PushPendingUpdate: edited locally since the stored etag.
	PushPendingUpdate PushState = "pending_update"
	// PushPendingDelete: deleted locally; the row stays live until the provider confirms, then
	// it is tombstoned. Its occurrences are hidden immediately.
	PushPendingDelete PushState = "pending_delete"
)

// Pending reports whether the object carries a local change the provider has not seen.
func (s PushState) Pending() bool { return s != PushSynced && s != "" }

// CalendarObject is one calendar object resource of a CalDAV feed: every VEVENT sharing a UID
// (the master plus its RECURRENCE-ID overrides), kept as the verbatim ICS the provider served.
// It is the unit of write-back (PLAN-caldav.md §0): an edit patches the properties Companion
// understands and leaves attendees, alarms and X- properties untouched. CalendarEvent rows are
// derived from ICS and never written to the provider directly.
type CalendarObject struct {
	ID     string `json:"id"`
	FeedID string `json:"feedId"`
	UID    string `json:"uid"`
	// Href is the resource URL on the provider; empty until a locally-created object is pushed.
	Href string `json:"href"`
	// ETag is the provider's version of the resource, sent back as If-Match on write.
	ETag string `json:"etag"`
	ICS  string `json:"ics"`
	// Recurring is derived from ICS (an RRULE or RDATE on the master) and mirrored in plaintext
	// so the merged calendar query can flag occurrences without decrypting anything.
	Recurring bool      `json:"recurring"`
	PushState PushState `json:"pushState"`
	// PushError is the last failure pushing this object, shown beside the event; nil when none.
	PushError *string    `json:"pushError,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// SyncEntity implementation (PLAN §7).
func (o *CalendarObject) SyncID() string           { return o.ID }
func (o *CalendarObject) SyncVersion() int64       { return o.Version }
func (o *CalendarObject) SyncUpdatedAt() time.Time { return o.UpdatedAt }
func (o *CalendarObject) SyncDeleted() bool        { return o.DeletedAt != nil }
func (o *CalendarObject) SyncDirty() bool          { return o.Dirty }
