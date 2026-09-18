# CalDAV — Implementation Plan

Real, two-way calendars. Today a calendar is an ICS subscription: read-only, fetched on-device,
expanded into `calendar_events` rows that sync encrypted. This plan adds **CalDAV accounts**
(iCloud, Fastmail, Nextcloud, Radicale, …) whose events can be created, edited and deleted from
Companion and written back to the provider, **without the sync server ever seeing a credential,
a calendar URL, or an event**.

This plan follows `PLAN.md`: logic in the Go core, React as presentation, one JSON-over-`invoke`
API, row-level sync with E2EE, platform capabilities injected by the shell.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Protocol | **CalDAV (RFC 4791)** with Basic auth. | One client covers iCloud, Fastmail, Nextcloud, Radicale, Zimbra, Synology. Microsoft has no CalDAV and needs Graph; out of scope. |
| Google | **OAuth2 + PKCE, in the core** (§9). `auth_kind = oauth-google`; the refresh token lives where a password would. Offered only in a build that carries a Google client id. | Google's CalDAV endpoint accepts nothing else. |
| OAuth layer | **Generic, not calendar-specific**: `core/oauth` + `oauth.*` bridge methods with a *purpose* dispatch. Calendar is the first purpose. | The same sign-in is meant to serve "Sign in to Companion with Google" later (§9.4) without a second implementation. |
| Who talks to the provider | **Native clients only** (desktop, mobile), directly, over TLS. The sync server is never in the path. | Same principle as client-side ICS fetch (PLAN §E2EE). A proxy would terminate the request and see the Authorization header and the event body. |
| Web | Web **never speaks CalDAV**. It edits local rows, which sync (encrypted) to a native device that pushes them. | No proxy means no leak. Calendar writes are not interactive, so queuing is acceptable. Accounts can only be *added* from a native client. |
| CalDAV library | **Own client in `core/caldav`** (net/http + encoding/xml). | `emersion/go-webdav` has no `If-Match` / `If-None-Match` on PUT, no conditional DELETE and no etag-only listing. Safe write-back depends on all three. `go-ical` is still used for the format. |
| Unit of write | The **calendar object**: one `.ics` resource per UID, stored verbatim in a new synced `calendar_objects` table. Edits patch the properties we understand and leave the rest (attendees, alarms, X- props) intact. | Round-tripping through our flattened event model would destroy data we do not model. |
| Events | `calendar_events` stays **derived**, per occurrence, deterministic ids. For CalDAV feeds they are expanded from the object's ICS instead of from a feed body. | Keeps `Range`, every calendar UI, and the "derived rows never conflict" rule unchanged. |
| Pending writes | `push_state` on the object: `synced`, `pending_create`, `pending_update`, `pending_delete`. Any native device holding the credential pushes pending objects. | Offline-first, and the web case falls out for free. |
| Concurrency | `If-None-Match: *` on create, `If-Match: <etag>` on update and delete. On `412` the provider copy wins and is adopted; if it already equals what we meant to write, that is a silent success. | Two devices racing to push the same pending row is harmless. A genuine conflict never clobbers the provider. |
| Credentials | `credentialEnc` on the synced account row when E2EE is unlocked, else a device secret-store ref. Identical to agent API keys. | One password, entered once, on every device, opaque to the server. |
| Change detection | Per-feed **ctag** (device-local, not synced) to skip quiet calendars, then an etag listing diffed against local objects, then `calendar-multiget` for what changed. | Works on every server. `sync-collection` is an optimisation for later. |
| Recurrence | Author simple rules (every N days/weeks/months/years, optional last day). Every edit to a repeating event applies to the **whole series**: a time change is measured on the occurrence the user edited and applied to the series anchor on the wall clock in the event's zone, with `EXDATE`s and `RECURRENCE-ID`s moved along. Delete a series, or one occurrence via `EXDATE`. Rules that say more (count, "3rd Monday", several weekdays) are *custom*: preserved, replaceable, time-of-day editable, not movable to another day. | "This occurrence only" edits need `RECURRENCE-ID` override authoring; still not done. Wall-clock, not duration, because a DST change between the first occurrence and the edited one would otherwise drift the series an hour. |
| Older servers and clients | A feed row with **no `kind`** means "written by something that predates CalDAV", never "ics". The client keeps its local kind/account/read-only when applying one; the server keeps the stored ones when an old client pushes one. Rescan matches calendars by collection URL across all feeds, re-adopts orphans and collapses duplicates. | Found in the field: an old sync server echoed feeds back without the new columns, orphaning every calendar; each rescan then created them all again and doubled the events. |

---

## 1. Data model

### 1.1 Client SQLite — `0020_caldav.sql`

- `calendar_accounts` (synced): name, server_url, username, auth_kind, credential_enc,
  credential_ref, home_set_url, last_error.
- `calendar_feeds` gains `kind` (`ics` | `caldav`), `account_id`, `read_only`. For a CalDAV feed
  `url` holds the collection URL.
- `calendar_objects` (synced): id = UUIDv5(feed|uid), feed_id, uid, href, etag, ics, recurring,
  push_state, push_error.
- `caldav_feed_state` (local only): feed_id, ctag.

### 1.2 Encryption — `core/crypto/rows.go`

| Entity | Encrypted | Plaintext |
|---|---|---|
| `calendar_account` | name, serverUrl, username, credentialEnc, homeSetUrl, lastError | authKind |
| `calendar_feed` | name, url, icsText | kind, accountId, readOnly, color |
| `calendar_object` | uid, href, etag, ics, pushError | feedId, recurring, pushState |

### 1.3 Server — `packages/syncserver`

`calendar_accounts` and `calendar_objects` use the whole-body `row_json` pattern from agents.
`calendar_feeds` gains three plaintext columns.

---

## 2. `core/caldav` — the client

`Discover` (current-user-principal, calendar-home-set, `.well-known/caldav`), `Calendars`
(name, color, ctag, privileges, VEVENT support), `ListETags`, `MultiGet`, `Get`, `Put`, `Delete`.
Redirects are followed by hand so PROPFIND survives them; credentials only follow a redirect
to the same site over https. Plain http is allowed only for loopback, private and `.local` hosts.

## 3. `core/calendar` — the format

1. `edit.go`: `NewObject`, `ApplyEdit`, `ExcludeOccurrence`. Untouched properties are preserved;
   DTSTART/DTEND are only rewritten when the time actually changes, so a TZID survives a rename.
2. `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED` are bumped on every edit.
3. `expand.go` learns `RECURRENCE-ID`: an override suppresses the master's occurrence at that
   instant instead of duplicating it.

## 4. `core/caldav` — the engine

`SyncFeed`: push pending objects, then pull (ctag, etag diff, multiget), then re-derive the
events of every object that changed. Objects with a pending state are never overwritten by a pull.

## 5. Bridge API

`calendar.accounts.list|add|remove|rescan`, `calendar.events.create|update|delete`.
`calendar.range` items gain `feedId`, `editable`, `recurring`, `pending`.
`calendar.refresh` runs the CalDAV engine on native and is a no-op for CalDAV on web.

## 6. UI (phase 2)

Settings › Calendar: "Add account" beside "Subscribe to URL". Calendar screen: create by
click/drag, edit sheet, delete with occurrence/series choice, a pending marker.

## 7. Status (2026-09-18, branch `feat/caldav-writeback`)

Done and covered by Go tests: §1–§5 (data model, encryption, server entities, client, format
layer, engine, bridge API), including a sync-server test of the web → native hand-off with the
server holding only ciphertext. Done and type-checked, **not yet exercised at runtime**: §6 (account
settings, event editor dialog, drag-to-move, pending marker, conflict notice, mobile "Edit event").
On web the settings page and calendar were checked in a browser; the editor needs a CalDAV
calendar, which only arrives by signing in to sync from a device that has one.

Since then: repeat editing, separate date/time fields and a notes box in the editor; drag the
bottom edge of a one-off event to resize it; a hover detail card in the Today agenda; settings
split into Accounts and Subscriptions, each with one button opening its add flow in a dialog
(`Dialog.tsx`, portaled to the viewport). Browser-checked: the settings page and its dialog.
Not runtime-checked here: the editor, resize and agenda card (they need calendar data).

Known gaps:

- No real provider has been tried yet. iCloud and Fastmail are the first to test by hand.
- **Google (§9) is tested only against fakes** (`oauthtest`, `caldavtest` in bearer mode). It needs a
  real client id to try. The one guess to check first is discovery from the `/user` principal URL.
- Removing a Google account does not revoke the grant at Google; the user can at
  myaccount.google.com/permissions.
- Mobile needs the redirect scheme registered and a prebuild before Google sign-in can return to the app.
- Removing a single CalDAV calendar (rather than its account) lasts until the next rescan, which
  finds it again. Needs a per-calendar "hidden" flag.
- Mobile has no OS date picker (`DateTimeInput` is read-only there), so times are set through the
  natural-language field in the editor.
- The pull window is ±1y, matching expansion. An object that slides out of it is tombstoned locally.

## 8. Later

Sign in to Companion with Google (§9.4), Microsoft Graph, `sync-collection`, per-occurrence edits, recurrence authoring,
attendees and alarms, VTODO ↔ tasks.

## 9. Google and the OAuth layer

### 9.1 `core/oauth`

Authorization-code flow with PKCE (S256), `state`, and an OIDC `nonce`. Knows nothing about
calendars. `Provider.Begin` → a `Flow` (secrets stay on the device) and the URL to open;
`Flow.Exchange` → a `Grant`: subject, email, name, access + refresh token, granted scopes, **and the
raw ID token with its nonce**. `TokenSource` refreshes and caches access tokens; a dead refresh
token is `ErrReauthRequired`. `Loopback` is the desktop redirect listener: `127.0.0.1` only, OS-picked
port, one answer, fixed response page. Every flow requests `openid email profile` on top of what
its purpose asks for, so any grant identifies the user.

### 9.2 Bridge — `oauth.configure | providers | begin | complete | cancel`, event `oauth.done`

A flow is started for a **purpose**, which supplies the extra scopes and consumes the grant.
Desktop flows finish themselves over loopback and emit `oauth.done`; mobile (custom-scheme
redirect) hands the deep link to `oauth.complete`. Flows are single-use and expire after 10
minutes. Tokens never cross the bridge to the UI.

### 9.3 The `calendar` purpose

Requests `https://www.googleapis.com/auth/calendar`, then discovers
`https://apidata.googleusercontent.com/caldav/v2/<email>/user` with a bearer token and creates the
account — after that it is the ordinary CalDAV engine. The CalDAV client retries once on `401` with
a refreshed token. Reconnect (`args.accountId`) refuses a different Google user. Re-adding an
existing address updates it in place.

**Client ids are per platform, and a refresh token only works with the one that obtained it.** The
account records `oauth_client_id`; a device whose build has a different one treats the account as
"no credential here" and leaves syncing to the device that connected it — the same fallback as web.

### 9.4 Reuse for login / signup (not built)

What is already in place for it: identity scopes on every flow, `Grant.Subject` (the stable key —
emails change), `Grant.IDToken` + `Grant.Nonce`, the purpose registry, `oauth.complete` for
redirect-based platforms (which is what web needs), and `startOAuthFlow` in the UI.
What a login still needs: a `login` purpose (platform-neutral file) that posts the ID token to a
new sync-server endpoint; that endpoint **verifying the token itself** (signature against Google's
JWKS, `iss`, `aud` ∈ our client ids, `exp`, `nonce`) — `oauth.ParseIDToken` deliberately does not,
and says so; account linking by `sub`; and an answer to the E2EE question a password currently
answers — a Google login proves identity but derives no key, so the master key still needs a
passphrase or recovery code to unwrap.

### 9.5 Configuration

| Shell | Client type (Google Cloud) | How |
|---|---|---|
| Desktop | Desktop app | `-ldflags "-X main.googleClientID=… -X main.googleClientSecret=…"`, or `COMPANION_GOOGLE_CLIENT_ID` / `_SECRET` in dev. Loopback redirect. |
| iOS / Android | iOS / Android | `EXPO_PUBLIC_GOOGLE_CLIENT_ID` + `EXPO_PUBLIC_GOOGLE_REDIRECT_URI` (`com.googleusercontent.apps.<id>:/oauth2redirect`); add that scheme to `scheme` in `app.json`, then `expo prebuild`. |
| Web | — | Never talks to a calendar provider. |

The calendar scope is *sensitive*: beyond 100 test users Google requires app verification.
