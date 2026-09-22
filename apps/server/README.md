# Companion — Server (auth + sync)

Milestone 3 (Server + sync). A Go HTTP API that authenticates users and syncs their
rows via **push/pull with optimistic concurrency** (PLAN §5). It reuses `core/domain`
entities and the `core/sync/protocol` wire types, and keeps its own store — it never
touches the client SQLite store or the client sync engine (PLAN §7).

## Endpoints

```
POST /v1/auth/register     {email, password}    -> {token, userId}
POST /v1/auth/login        {email, password}    -> {token, userId}
POST /v1/auth/verify/send  (bearer)             -> {sent, verified}   emails a confirmation link
POST /v1/auth/verify       {token}              -> {verified}
POST /v1/auth/forgot       {email}              -> {sent}             always 200 (no enumeration)
POST /v1/auth/reset/info   {token}              -> {encrypted, recoveryWrapped?}
POST /v1/auth/reset        {token, newPassword, keyMaterial?} -> {reset}
GET  /v1/auth/verify?token=… / /v1/auth/reset?token=…  landing pages the emailed links open
GET  /v1/sync/pull?cursor=N&limit=500           -> {changes:[{entityType,row,serverSeq}], nextCursor}
POST /v1/sync/push          {changes:[…]}       -> {results:[{id,status,version?,serverRow?}]}
GET  /v1/push/config        (bearer)            -> {publicKey}        the VAPID key to subscribe with
POST /v1/push/subscribe     {deviceId, subscription}  -> {ok}         PushSubscription.toJSON()
POST /v1/push/unsubscribe   {endpoint}          -> {ok}
POST /v1/push/test          {endpoint}          -> {ok}               sends this device a test notification
```

- **Push** (`applyPush`, PLAN §5.2): per row, in a transaction —
  insert (version 1) / apply if `version == baseVersion` (version++) / on a stale push
  the **server wins only if it's at least as new**, else the client's newer row is
  applied. Every write bumps a per-user monotonic `server_seq`.
- **Pull** (PLAN §5.1): `WHERE user_id = ? AND server_seq > cursor ORDER BY server_seq
  LIMIT n`, returning `next_cursor`. Tombstones (`deleted_at`) propagate.
- Client-side conflict resolution + **conflicted copies** live in `core/sync`
  (shared by every client).

## Email

Verification and forgot-password emails go over SMTP (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`); with `SMTP_HOST` unset the links are
logged instead of sent. `COMPANION_PUBLIC_URL` (the API base users enter in the app)
anchors the emailed links; `COMPANION_APP_URL` optionally overrides where the reset page
hands off (default: the app's `companion://reset` deep link). Registration sends the
first verification email automatically when SMTP is configured. Templates live in
`packages/syncserver/emails` (React Email); their rendered `dist/` is committed and
embedded, so `go build` needs no Node — run `make emails` after editing one.

## Web push (reminders to the web app)

Browsers that turn on **Settings → Notifications** in the web app register a Web Push
subscription here, and the server pushes each task reminder as it comes due — the only way an
installed web app is reminded while closed, and on iPhone/iPad the only way at all. The same
code runs in the cloud binary (it mounts this API under `/api`). Once a device is registered,
the web app stops showing its own local reminder notifications, so each reminder arrives once.

How it works (`packages/syncserver/push.go`, `webpush.go`):

- Every 15 s the dispatcher computes the reminders due since the last sweep with the apps' own
  planner (`core/notify`) over each subscribed account's open tasks, and sends each one once
  (claimed in `push_deliveries`, so several instances never double-send). Fires more than
  10 minutes late are dropped; a reminder set into the past is not sent.
- Payloads are encrypted to the browser (RFC 8291, aes128gcm) and signed with VAPID (RFC 8292),
  on the Go standard library. An end-to-end encrypted account's task titles never leave the
  server: the service worker fills them in from the device's own cached plan.
- Subscriptions must be HTTPS endpoints on a known push service (Apple, Google FCM, Mozilla,
  Microsoft), so the server can't be steered at other hosts. A subscription the push service
  reports gone (404/410) is deleted. The cloud's subscription gate applies to pushes like sync.
- New tables (`push_subscriptions`, `push_deliveries`, `server_settings`) are created at boot on
  Postgres and SQLite alike; there is nothing to migrate by hand.

### Production setup

1. **Set `VAPID_SUBJECT`** to a contact the push services can reach: `mailto:ops@yourdomain` or
   an `https://` URL. It defaults to `COMPANION_PUBLIC_URL` (the cloud: `SYNC_API_URL`) when that
   is `https://`, else `mailto:$SMTP_FROM`. **Apple rejects placeholders** such as
   `mailto:no-reply@localhost` with `403 BadJwtToken`, so iPhone and iPad reminders fail until
   this is real; the server logs a `push: VAPID contact is …` warning at boot while it isn't.
2. **Keys: nothing to do, or pin them.** Left unset, the server generates a VAPID key pair on
   first boot and stores it in `server_settings` — every instance on that database shares it, and
   it survives restarts and redeploys. To manage it yourself (e.g. keep it across a database
   rebuild), generate a pair with `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY`
   and `VAPID_PRIVATE_KEY` (base64url, as that tool prints them). **Never change the pair once
   people have turned notifications on**: every subscription is bound to it. Devices re-subscribe
   by themselves the next time they open Companion; until then they get nothing.
3. **Allow outbound HTTPS** (443) from the server to `*.push.apple.com`, `fcm.googleapis.com`,
   `*.push.services.mozilla.com` and `*.notify.windows.com`, if egress is restricted.
4. **Serve the web app over HTTPS** at the root of its origin, with `sw.js` and
   `manifest.webmanifest` revalidated on every load (`apps/web/Caddyfile` already does both), and
   list its origin in `CLOUD_CORS_ORIGINS` (the cloud) — the push calls ride the same CORS policy
   as sync.
5. **Deploy the server/cloud before (or with) the web app**: a web app ahead of its server finds
   no `/v1/push/*` and can't turn notifications on.

### Checking it in production

- Boot logs: no `push: VAPID contact is …` warning.
- Desktop Chrome: sign in to sync → **Settings → Notifications** → **Turn on notifications** →
  **Send a test**. The notification should appear within seconds.
- iPhone/iPad on iOS 16.4+: open the web app in Safari → the banner's **Show me how** → follow
  the steps → open Companion from the Home Screen → **Turn on notifications** → allow → **Send a
  test** from Settings.
- End to end: make a task due two minutes out, close the app, and wait — the reminder arrives
  within about 15 seconds of its time (`push: sent N reminder(s)` in the logs).
- Failures are logged per push service, e.g. `push: reminder to web.push.apple.com failed: push
  service: 403 {"reason":"BadJwtToken"}` — that one means `VAPID_SUBJECT` (or the server clock).

## Storage

The driver is chosen from the DSN: a `postgres://` URL uses **pgx** (production,
PLAN §4.2); anything else is a **SQLite** path (`modernc.org/sqlite`) for zero-config
dev and fast headless tests. The queries are written once with `?` placeholders and
rebound to `$N` on Postgres; the schema (TEXT / BIGINT / BYTEA + `ON CONFLICT …
EXCLUDED`) is valid on both. Passwords are bcrypt-hashed; sessions are opaque tokens.

```bash
make db-up                # start the compose Postgres (compose.yaml / .env)
make server-run           # loads .env -> DATABASE_URL, so it runs on Postgres
# or explicitly:
DATABASE_URL=postgres://companion:companion@localhost:5432/companion?sslmode=disable go run ./apps/server
```

Precedence: `DATABASE_URL` (Postgres) → `COMPANION_DB` (SQLite path) → a default
SQLite file. `make test-go` runs on in-memory SQLite; set `COMPANION_TEST_DB` to a
`postgres://` URL to run the same suite against Postgres.

## Run / test

```bash
make test-go                              # includes ./apps/server/... (e2e sync test)
COMPANION_ADDR=:8080 go run ./apps/server # or: go build -o build/companion-server ./apps/server
```

`apps/server/sync_test.go` is the end-to-end proof: two client stores (`core/store`)
driving the real `core/sync` engine over HTTP against this server — verifying
propagation, tombstone deletes, and conflicted copies converge.
