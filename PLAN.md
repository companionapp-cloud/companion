# Companion — Implementation Plan

A techie-centric, offline-first productivity app (notes, tasks, habits, calendar) with
local-or-cloud LLM assistance, one shared Go core, and clients for web, macOS, Windows,
Linux, Android, and iOS.

---

## 1. Architecture at a glance

```
                        ┌─────────────────────────────────────────┐
                        │              Go core (core/)            │
                        │  domain models · sqlite repos · sync    │
                        │  engine · recurrence · streaks · LLM    │
                        │  client · notification planning         │
                        └───────┬──────────┬──────────┬───────────┘
              direct Go import  │  gomobile bind      │  GOOS=js GOARCH=wasm
                        ┌───────▼───┐  ┌───▼───────┐  ┌▼──────────┐
                        │  Wails v3 │  │ .aar /    │  │ core.wasm │
                        │  desktop  │  │ .xcframe- │  │  (web)    │
                        │  (Go bin) │  │ work      │  │           │
                        └───────┬───┘  └───┬───────┘  └┬──────────┘
                                │          │           │
                        ┌───────▼──────────▼───────────▼───────────┐
                        │   packages/core-bridge (TS interface)    │
                        │   one CoreBridge API, 3 implementations  │
                        └───────────────────┬──────────────────────┘
                                            │
                        ┌───────────────────▼──────────────────────┐
                        │   packages/app (React Native UI, RNW)    │
                        │   screens · navigation · state · hooks   │
                        └──────┬───────────────┬───────────────────┘
                          Vite + RNW        Expo (Metro)
                     (apps/web, apps/desktop) (apps/mobile)

        ┌──────────────────────────────────────────────────────────┐
        │  apps/server (Go): auth · sync API · repeat-task cron ·  │
        │  ICS fetcher · Postgres. Imports core/ domain packages.  │
        └──────────────────────────────────────────────────────────┘
```

**The rule:** business logic is written once, in Go, in `core/`. React code is
presentation + platform glue only. The server reuses `core/` domain packages but has
its own Postgres persistence.

---

## 2. Repository layout

```
companion/
├── package.json              # npm workspaces: apps/*, packages/*
├── go.work                   # Go workspace: core, apps/desktop, apps/server
├── core/                     # Go module: the shared core (NOT an npm workspace)
│   ├── domain/               # entities, validation, pure logic (streaks, recurrence)
│   ├── store/                # SQLite repos + migrations (client-side persistence)
│   ├── sync/                 # client-side sync engine
│   ├── llm/                  # OpenAI-compatible client, prompt building, retrieval
│   ├── notify/               # notification planning (pure computation)
│   ├── bridge/               # invoke() dispatcher: method string + JSON in/out
│   └── cmd/
│       ├── wasm/             # main for GOOS=js build
│       └── mobile/           # gomobile-bindable package (Invoke/SetEventHandler)
├── apps/
│   ├── web/                  # Vite + react-native-web, loads core.wasm
│   ├── desktop/              # Wails v3 (Go main imports core directly)
│   │   └── frontend/         # thin Vite build of packages/app with wails bridge
│   ├── mobile/               # Expo app + local expo-module wrapping gomobile lib
│   └── server/               # Go API server, cron, ICS fetcher (Postgres)
├── packages/
│   ├── app/                  # ALL shared React Native UI (screens, state, hooks)
│   ├── editor/               # react-prosemirror markdown editor (DOM component)
│   ├── core-bridge/          # TS CoreBridge interface + wails/wasm/native impls
│   └── config/               # shared tsconfig, eslint
└── build/                    # gitignored: core.wasm, core.aar, Core.xcframework
```

Notes:

- `core/` sits at the top level because it is a Go module, not an npm package.
  npm workspaces skip directories without a `package.json`, but keeping it out of
  `packages/` avoids confusion.
- `go.work` ties `core`, `apps/desktop`, `apps/server` together so local edits to
  `core/` are picked up without publishing.
- Shared React code must be bundleable by **both** Vite (web/desktop) and Metro
  (Expo). Keep `packages/app` free of bundler-specific features; support
  `.web.tsx` / `.native.tsx` platform extensions in both configs
  (Vite: `resolve.extensions` order; Metro handles it natively).

### Setup steps

```bash
# Go workspace
go work init ./core ./apps/desktop ./apps/server

# JS packages (each gets a package.json in the npm workspace)
npm init -y -w packages/app -w packages/editor -w packages/core-bridge -w packages/config
npm create vite@latest apps/web            # then add react-native-web
npx create-expo-app apps/mobile
wails3 init apps/desktop                   # Wails v3 alpha; frontend points at packages/app build
mkdir -p apps/server && (cd apps/server && go mod init companion/server)
```

---

## 3. The Go core and the binding strategy

### 3.1 One API shape for every platform

The lowest common denominator across gomobile, wasm exports, and Wails bindings is
**"string method + JSON bytes in, JSON bytes out, plus an event stream"**. Everything
speaks it:

```go
// core/bridge/bridge.go
type Core struct { ... }

// Invoke dispatches "tasks.create", "notes.list", "sync.push", "llm.chat", ...
func (c *Core) Invoke(method string, payload []byte) ([]byte, error)

// Events: LLM token streams, sync progress, "data changed" notifications for UI refresh
type EventHandler interface{ OnEvent(name string, payload []byte) }
func (c *Core) SetEventHandler(h EventHandler)
```

```ts
// packages/core-bridge/src/index.ts
export interface CoreBridge {
  invoke<T>(method: string, payload: unknown): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}
```

Typed TS wrappers (`core.tasks.create(...)`) are generated or hand-written once in
`core-bridge` on top of `invoke`. UI code never calls `invoke` directly.

### 3.2 Per-platform bindings

| Platform | Binding | SQLite driver | Notes |
|---|---|---|---|
| Desktop (Wails, all 3 OS) | **Direct Go import** — no cgo boundary at all. Wails service exposes `Invoke` to JS; events via Wails event bus. | `modernc.org/sqlite` (pure Go) | Simplest target; build first. |
| iOS / Android (Expo) | `gomobile bind` → `Core.xcframework` / `core.aar`, wrapped in a **local Expo Module** (Swift/Kotlin) exposing `invoke` + event emitter. | `modernc.org/sqlite` | gomobile restricts exported types — the string+bytes API is designed for exactly this. |
| Web | `GOOS=js GOARCH=wasm` build of `core/cmd/wasm`; JS wrapper implements `CoreBridge`. | **Injected**: core defines a `store.Driver` interface; the wasm build receives a JS-backed implementation over **wa-sqlite + OPFS**. Native builds bind the same interface to modernc. | The riskiest binding — see §10. |
| Server | Plain Go import of `core/domain` (+ recurrence, streaks). | n/a — server uses Postgres via its own repo layer. | Server does **not** reuse the client sqlite store or client sync engine. |

Using `modernc.org/sqlite` (pure Go) everywhere native avoids fighting cgo
cross-compilation inside gomobile and keeps desktop builds trivially
cross-platform. (Ironically, "cgo shared libraries" mostly reduces to: Wails needs
no FFI, mobile uses gomobile — which is cgo under the hood — and web uses wasm.)

### 3.3 Interfaces the core *requires* from each platform

The core stays pure by depending on small interfaces the shell injects:

```go
type Driver interface { Exec(...) ; Query(...) }        // sqlite access (web only overrides)
type SecretStore interface { Get(k string) ; Set(k, v string) }  // OS keychain / SecureStore
type Clock interface { Now() time.Time }                 // testability
type HTTP interface { Do(*Request) (*Response, error) }  // wasm uses fetch under the hood
```

---

## 4. Data model

Conventions for every **syncable** table:

- `id` — UUIDv7 (client-generated, time-ordered)
- `created_at`, `updated_at` — RFC3339 UTC. `updated_at` is set by whoever writes;
  after a successful sync the server's value is authoritative.
- `deleted_at` — soft delete / tombstone (rows are never hard-deleted on clients)
- `version` — the server version of the row the client last saw (`0` = never synced)
- `dirty` — client-only flag: has local changes not yet pushed

### 4.1 Client SQLite schema (owned by `core/store`, applied via embedded migrations)

```sql
CREATE TABLE sync_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  device_id     TEXT NOT NULL,
  server_cursor INTEGER NOT NULL DEFAULT 0,   -- last server_seq pulled
  last_synced_at TEXT
);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content_md  TEXT NOT NULL DEFAULT '',       -- canonical format is markdown
  date        TEXT,                           -- optional; surfaces note on calendar
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes_md       TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',   -- open | done | cancelled
  due_at         TEXT,
  remind_at      TEXT,                           -- reminder -> local notification
  completed_at   TEXT,
  repeat_rule    TEXT,           -- RFC5545 RRULE; set ONLY on seed tasks
  repeat_seed_id TEXT,           -- occurrences point at their seed; NULL on seeds/one-offs
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habits (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cadence      TEXT NOT NULL,     -- RRULE subset: daily / weekly on M,W,F / etc.
  target_count INTEGER NOT NULL DEFAULT 1,   -- completions per period
  color        TEXT,
  archived_at  TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habit_entries (
  id         TEXT PRIMARY KEY,
  habit_id   TEXT NOT NULL,
  date       TEXT NOT NULL,       -- local calendar date 'YYYY-MM-DD'
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (habit_id, date)
);
-- Streaks are COMPUTED (core/domain/streaks.go), never stored.

CREATE TABLE calendar_feeds (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  url   TEXT NOT NULL,            -- ICS URL; fetched by the SERVER, not clients
  color TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE calendar_events (      -- server-owned clone; READ-ONLY on clients
  id        TEXT PRIMARY KEY,
  feed_id   TEXT NOT NULL,
  ics_uid   TEXT NOT NULL,
  title     TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at   TEXT,
  all_day   INTEGER NOT NULL DEFAULT 0,
  location  TEXT, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0
  -- no dirty column: clients never write these
);

CREATE TABLE llm_configs (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,      -- 'device' (local LLM) | 'account' (remote LLM)
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,      -- e.g. http://localhost:11434/v1 or https://api.anthropic.com
  provider    TEXT NOT NULL,      -- 'openai-compatible' | 'anthropic' | ...
  model       TEXT NOT NULL,
  api_key_ref TEXT,               -- key lives in OS keychain / SecureStore, NOT in the DB
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
-- scope='device' rows are NEVER pushed to the server (local LLM URLs are per-machine).
-- scope='account' rows sync; the api key itself syncs via the secrets endpoint (§7.3).
```

### 4.2 Server schema (Postgres)

Same entities plus multi-tenancy and a per-row change sequence:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE devices (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  name TEXT, platform TEXT, last_seen_at TIMESTAMPTZ
);

-- Every syncable table gains:
--   user_id    UUID NOT NULL
--   server_seq BIGINT NOT NULL       -- from a per-user monotonic counter,
--                                    -- bumped on EVERY server-side write
--   version    BIGINT NOT NULL       -- optimistic concurrency counter for the row
-- e.g.:
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  -- ...same business columns as client...
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
);
CREATE INDEX ON tasks (user_id, server_seq);

CREATE TABLE user_seq (user_id UUID PRIMARY KEY, seq BIGINT NOT NULL DEFAULT 0);

CREATE TABLE user_secrets (         -- synced LLM API keys, encrypted at rest
  user_id UUID NOT NULL, key TEXT NOT NULL, value_enc BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (user_id, key)
);
```

`server_seq` per row (rather than a separate change-log table) keeps pulls simple and
idempotent: `WHERE user_id = $1 AND server_seq > $cursor ORDER BY server_seq LIMIT $n`,
across all tables merged by seq. Tombstones (`deleted_at`) are retained so deletes
propagate; a retention job can hard-delete tombstones older than N months and force
full resync for cursors older than that.

Shared Go structs in `core/domain` are the single definition of these entities; the
client store and the server store both map to/from them.

---

## 5. Sync protocol

Client-side engine lives in `core/sync` (shared by all clients). Server endpoints:

```
POST /v1/auth/login|register     -> bearer token
GET  /v1/sync/pull?cursor=N&limit=500
POST /v1/sync/push
GET  /v1/secrets / PUT /v1/secrets/{key}
```

### 5.1 Pull

Response: ordered list of `{entity_type, row, server_seq}` with `server_seq > cursor`,
plus `next_cursor`. Client applies each row:

- If the local row is **not dirty** → overwrite local, set `version`, clear nothing.
- If the local row **is dirty** → conflict, resolved by the rules below.
- Advance `server_cursor` only after the batch is applied in one transaction.

### 5.2 Push

Client sends every dirty row: `{entity_type, id, base_version (=local version), fields, updated_at}`.
Server, per row, in a transaction:

1. Row doesn't exist → insert, `version = 1`, assign `server_seq`. **Accepted.**
2. Row exists, `row.version == base_version` → apply, `version++`, new `server_seq`. **Accepted.**
3. Row exists, `row.version > base_version` → **stale push**; apply the conflict rule:
   - If `server.updated_at >= client.updated_at` → **server wins.** Response:
     `{status: "conflict", server_row}`.
   - If `client.updated_at > server.updated_at` → client is newer → apply the client's
     fields anyway (`version++`). **Accepted.** (Server wins only *if it's newer*.)

### 5.3 Conflict handling on the client ("server wins → local becomes a copy")

When a push returns `conflict` (or a pull lands on a dirty row and the server copy is
newer):

1. Snapshot the local (losing) row.
2. Overwrite the local row with the server's canonical row; `dirty = 0`.
3. If the losing row differed in **meaningful fields** (not just timestamps), create a
   **new entity** with a fresh UUIDv7 carrying the local content, titled
   `"<title> (conflicted copy 2026-07-04)"`, `dirty = 1` — it pushes on the next cycle
   as a brand-new row, so nothing the user typed is ever silently lost.
4. Deletes: if the server deleted and the client edited → server delete wins, edited
   content resurrects as a conflicted copy. If the client deleted and the server
   edited → same rule via timestamps.

### 5.4 Sync loop

- Trigger: on app start, on any local mutation (debounced), on push notification /
  periodic timer, on network regained.
- Order: **push first, then pull** (push may generate conflicts whose canonical rows
  arrive in the following pull; the conflicted copies push next round — the loop
  converges).
- All of this is `core/sync` code — identical on every platform; only the HTTP
  transport is injected (fetch on wasm, net/http elsewhere).

---

## 6. Feature design

### 6.1 Notes & the editor package

- `packages/editor` — a **DOM-only** React component built on
  `@handlewithcare/react-prosemirror` with a markdown schema
  (`prosemirror-markdown`): props in → markdown string out via `onChange`.
- Web/desktop render it directly (it's just React DOM inside RNW layouts).
- Expo renders it with **`'use dom'`** (Expo SDK 52+). Constraints that shape the
  component's API: props must be serializable, callbacks are async, no synchronous
  calls back into native. Keep the editor self-contained (its own styles, no imports
  from `packages/app`).
- Canonical storage format is **markdown text** (`notes.content_md`) — sync, search,
  and LLM context all operate on markdown; ProseMirror state is an editor-local
  concern.

### 6.2 Tasks, reminders, repeating tasks

- **Reminders**: `remind_at` on a task. `core/notify` computes the *notification plan*
  (upcoming `{task_id, fire_at, title, body}` for the next N days). After every sync
  or mutation, the platform shell reconciles:
  - Desktop: Wails v3 notifications API (app or its tray process must be running —
    ship a "launch at login / run in menu bar" option).
  - Mobile: `expo-notifications` scheduled local notifications (cancel-and-reschedule
    by tag).
  - Web: best-effort `Notification` API while a tab is open.
- **Repeating tasks**: the user creates a **seed task** with `repeat_rule` (RRULE,
  parsed with `teambition/rrule-go` — the same package used by core for "next
  occurrence" previews). **Only the server generates occurrences**: a cron job
  (hourly + on seed write) materializes occurrence rows (`repeat_seed_id = seed.id`)
  over a rolling 60-day window, idempotently (unique on `(repeat_seed_id, due_at)`).
  Occurrences sync down as ordinary tasks; completing one is a normal client edit.
  Editing a seed's rule regenerates future *uncompleted* occurrences.
  Consequence to document in the UI: with no server configured, repeats don't
  materialize (the seed still shows its next-occurrence preview from core).

### 6.3 Habits & streaks

- `habits` + `habit_entries` (one row per habit per local date, `UNIQUE`).
- Streak math (`current streak`, `best streak`, period completion vs `cadence` +
  `target_count`) is a **pure function** in `core/domain/streaks.go` — computed on
  read, never stored, so sync can't corrupt it. Timezone rule: entries record the
  device-local calendar date.

### 6.4 Calendar

- `calendar_feeds` are user data (synced). The **server** fetches each ICS URL every
  15–30 min (`emersion/go-ical`), expands recurrences over a ±1y window, and upserts
  `calendar_events` (server-owned, read-only on clients, delivered via normal sync).
  Clients never fetch ICS — one fetcher, no CORS problems, consistent clone.
- The calendar UI is a query in core: `calendar.range(from, to)` merges
  `calendar_events` + tasks with `due_at`/`remind_at` + notes with `date` + habit
  cadence occurrences — one shared implementation, every client gets the same view.

### 6.5 LLM

- `core/llm` implements an OpenAI-compatible chat client (covers Ollama, LM Studio,
  llama.cpp server, OpenRouter, etc.) plus an Anthropic provider. Streaming tokens go
  out through the event channel (`llm.token` events).
- **Local LLM** (`scope='device'`): base URL like `http://localhost:11434/v1`.
  Configured on desktop primarily; mobile can point at a LAN IP. Never synced.
- **Remote LLM** (`scope='account'`): config row syncs normally; the API key syncs
  via `PUT /v1/secrets/llm.<id>` (TLS in transit, AES-GCM at rest server-side) and is
  stored in the OS keychain/SecureStore on each device (`api_key_ref`). E2E
  encryption of secrets is a documented later upgrade.
- **Query-your-data**: core implements retrieval as tool-calls executed *locally*
  against SQLite (`search_notes`, `list_tasks`, `get_habit_stats`, `calendar_range`).
  The chat orchestration loop (prompt assembly → tool round-trips → final answer)
  lives entirely in `core/llm`, so "ask my data" behaves identically on every
  platform, and private data only leaves the device as the context the user's chosen
  LLM receives.

---

## 7. What lives where (the reuse matrix)

| Logic | core (Go, shared) | Client shell (per platform) | Server (Go) |
|---|---|---|---|
| Entity models, validation | ✅ single source | — | ✅ imports core/domain |
| SQLite schema + migrations + repos | ✅ | — | — (own Postgres repos) |
| Sync engine (client side) | ✅ | — | ✅ counterpart endpoints |
| Conflict resolution + conflicted copies | ✅ | — | ✅ version check + rule |
| RRULE parsing / next-occurrence | ✅ | — | ✅ same package (cron) |
| Repeat occurrence **generation** | — | — | ✅ cron only |
| Streak computation | ✅ | — | — |
| Notification **planning** | ✅ | — | — |
| Notification **scheduling/display** | — | ✅ Wails / expo-notifications / Web API | — |
| ICS fetch + parse + clone | — | — | ✅ |
| Calendar merge query | ✅ | — | — |
| LLM chat orchestration + retrieval tools | ✅ | — | — |
| Secret storage | — | ✅ keychain/SecureStore/DPAPI | ✅ encrypted secrets table |
| Auth token persistence | — | ✅ | ✅ issue/verify |
| UI, navigation, state presentation | — | ✅ packages/app (shared React) | — |
| Editor | — | ✅ packages/editor (DOM, `use dom` on Expo) | — |

Rule of thumb: **if it touches data or decisions, it's Go in `core/`; if it touches
the OS or pixels, it's in the shell; if it must run when devices are asleep
(repeats, ICS), it's on the server.**

---

## 8. Build & tooling

- **Root scripts** (npm) orchestrate everything; Go builds via `make` or `task`:
  - `build:core:wasm` → `GOOS=js GOARCH=wasm go build -o build/core.wasm ./core/cmd/wasm`
  - `build:core:android` → `gomobile bind -target=android -o build/core.aar ./core/cmd/mobile`
  - `build:core:ios` → `gomobile bind -target=ios -o build/Core.xcframework ./core/cmd/mobile`
  - Desktop needs no artifact — `apps/desktop` imports `core/` via `go.work`.
- **CI matrix**: `go test ./core/... ./apps/server/...` (the payoff of core-heavy
  design: business logic is tested once, headlessly, fast), TS typecheck/lint, wasm
  build, gomobile builds on a mac runner, Wails builds per OS.
- **Versioning**: core bridge methods are versioned (`core.version` invoke); clients
  refuse to run against an incompatible artifact.

---

## 9. Milestones

1. **Skeleton** — go.work; `core/bridge` invoke dispatcher; SQLite store + migrations;
   Notes CRUD end-to-end on **desktop (Wails)** — the cheapest binding proves the
   architecture.
2. **Web + wasm** — Vite RNW app; `core.wasm`; wa-sqlite/OPFS driver behind
   `store.Driver`. Notes work offline in the browser. *(De-risks the hardest binding
   early.)*
2.  **Server + sync** — auth, push/pull, conflict rule + conflicted copies, sync loop
   in core. Notes sync everywhere.
4. **Mobile** — Expo app; gomobile + local expo module; editor via `use dom`. Notes
   on all six platforms.
5. **Tasks + reminders** — task CRUD, notification planning in core, per-platform
   scheduling.
6. **Repeating tasks** — RRULE on seeds, server cron materialization, regeneration on
   rule edit.
7. **Habits** — entries, streak math, UI.
8. **Calendar** — feeds, server ICS fetcher, event clone, merged calendar view.
9. **LLM** — provider configs (device vs account scope), secrets sync, chat with
   local retrieval tools, streaming UI.
10.  **Polish** — background sync triggers, tombstone retention + full-resync path,
    E2E-encrypted secrets, import/export.

---

## 10. Risks & open questions

- **Web is the hard target.** Go-wasm binaries are large (several MB — mitigable with
  `-ldflags="-s -w"` + wasm-opt + gzip/brotli); the injected wa-sqlite driver crosses
  the JS↔wasm boundary per query (fine for this workload, but measure); OPFS requires
  cross-origin isolation headers. Fallback if it becomes untenable: web runs
  "online mode" against the server API (server reuses core logic), sacrificing web
  offline only.
- **gomobile + Expo** adds native build complexity (EAS custom dev clients, no Expo
  Go). Budget time in milestone 3.
- **Wails v3** (needed for clean service bindings + notifications) is still
  alpha-ish; pin a known-good version. v2 fallback: bind the same `Invoke` method.
- **`use dom`** editor is a webview on native — test keyboard/IME behavior early;
  props/callbacks are async-only.
- **Clock skew**: conflict rule compares `updated_at` from different devices. Server
  clamps client timestamps to `now()` when they arrive from the future; document that
  "newer" is best-effort.
- Open: multi-user vs single-user self-hosted first (plan assumes multi-user-capable
  but ships single-user auth); Anthropic vs OpenAI-compatible-only at launch;
  Postgres vs server-side SQLite for self-hosters (schema above ports easily).
