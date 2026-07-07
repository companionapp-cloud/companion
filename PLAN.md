# Companion — Implementation Plan

A techie-centric, offline-first productivity app (notes, tasks, habits, calendar) with
local-or-cloud LLM assistance, one shared Go core, and clients for web, macOS, Windows,
Linux, Android, and iOS.

The data model is an **object graph**: notes, tasks, habits, and projects are nodes;
wikilinks, embeds, typed metadata references, habit stacks, and project memberships
are edges. Notes and tasks can be archetyped into "objects" with structured,
schema-validated metadata. **Areas** (a flat list of life areas) group projects;
**projects** collect notes, tasks, and habits and drive the sidebar navigation. Every
client can render the whole graph without parsing the knowledgebase, because the
graph is a materialized index maintained at write time — see §5.

---

## 1. Architecture at a glance

```
                        ┌─────────────────────────────────────────┐
                        │              Go core (core/)            │
                        │  domain models · object schemas · link  │
                        │  extraction · sqlite repos · sync       │
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
        │  apps/server (Go): auth · sync API · SSE change fanout · │
        │  repeat-task cron · ICS fetcher · Postgres. Imports      │
        │  core/ domain packages.                                  │
        └──────────────────────────────────────────────────────────┘
```

**The rule:** business logic is written once, in Go, in `core/`. React code is
presentation + platform glue only. The server reuses `core/` domain packages but has
its own Postgres persistence.

**The graph rule:** edges are either *derived* from synced content (computed locally
on every device by the same Go extractor — never synced) or *authored* (real synced
rows). Read-side graph queries touch only the link index and a slim node projection —
never entity bodies.

---

## 2. Repository layout

```
companion/
├── package.json              # npm workspaces: apps/*, packages/*
├── go.work                   # Go workspace: core, apps/desktop, apps/server
├── core/                     # Go module: the shared core (NOT an npm workspace)
│   ├── domain/               # entities, object schemas, link extraction, validation,
│   │                         # pure logic (streaks, recurrence)
│   ├── store/                # SQLite repos + migrations (client-side persistence)
│   ├── graph/                # graph queries over the link index (full / neighborhood /
│   │                         # backlinks / rebuild)
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
│   ├── mobile/               # Expo app + local expo-module wrapping gomobile lib;
│   │                         # own shell (src/MobileShell.tsx) reusing packages/app
│   │                         # screens/primitives — the desktop AppShell is not reused
│   └── server/               # Go API server, cron, ICS fetcher (Postgres)
├── packages/
│   ├── app/                  # ALL shared React Native UI (screens, state, hooks)
│   ├── editor/               # ProseMirror markdown editor (DOM component; on native it
│   │                         # ships as an esbuild bundle inside react-native-webview)
│   ├── core-bridge/          # TS CoreBridge interface + wails/wasm/native impls;
│   │                         # SyncNotifier SSE client (fetch-stream on web/desktop,
│   │                         # react-native-sse on mobile)
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

---

## 3. The Go core and the binding strategy

### 3.1 One API shape for every platform

The lowest common denominator across gomobile, wasm exports, and Wails bindings is
**"string method + JSON bytes in, JSON bytes out, plus an event stream"**. Everything
speaks it:

```go
// core/bridge/bridge.go
type Core struct { ... }

// Invoke dispatches "tasks.create", "notes.list", "graph.full", "sync.push", ...
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
| Desktop (Wails, all 3 OS) | **Direct Go import** — no cgo boundary at all. Wails service exposes `Invoke` to JS; events via Wails event bus. | `modernc.org/sqlite` (pure Go) | Simplest target; built first. |
| iOS / Android (Expo) | `gomobile bind` → `Core.xcframework` / `core.aar`, wrapped in a **local Expo Module** (Swift/Kotlin) exposing `invoke` + event emitter. | `modernc.org/sqlite` | gomobile restricts exported types — the string+bytes API is designed for exactly this. |
| Web | `GOOS=js GOARCH=wasm` build of `core/cmd/wasm`; JS wrapper implements `CoreBridge`. | **Injected**: core defines a `store.Driver` interface; the wasm build receives a JS-backed implementation over **wa-sqlite + OPFS**. Native builds bind the same interface to modernc. | Proven in milestone 2. |
| Server | Plain Go import of `core/domain` (+ recurrence, streaks, object schemas). | n/a — server uses Postgres via its own repo layer. | Server does **not** reuse the client sqlite store or client sync engine. |

Using `modernc.org/sqlite` (pure Go) everywhere native avoids fighting cgo
cross-compilation inside gomobile and keeps desktop builds trivially
cross-platform.

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

### 4.0 The object graph

Node types, each in its own typed table (they have genuinely different shapes, sync
behavior, and business logic — there is deliberately **no** generic `nodes` table):

- **Notes** — markdown documents. May be archetyped by an *object type* (§6.3), which
  attaches schema-validated structured metadata (`props_json`).
- **Tasks** — one-off, scheduled (repeating), or reminders. Also archetypable.
- **Habits** — builders (positive streaks) or breakers (absence streaks), with
  structured cadences, notification schedules, geofences, and stacking.
- **Projects** — collections of notes, tasks, and habits (§6.6). A project belongs to
  exactly one **area**; areas are a flat list of "areas of your life" that structure
  the sidebar. Areas are organizational scaffolding, not graph nodes — a project's
  area is a column, not an edge.

Membership rules: a note, task, or habit can belong to **many projects**
(`project_members`, a synced many-to-many table); a project belongs to **one area**
(`projects.area_id`, a plain column — modeling the 1:N as a column makes the
"only one area" invariant structural instead of validated).

Two edge categories:

- **Derived edges** — extracted from synced content by the Go core at write time:
  wikilinks (`[[note:<id>]]`), embeds (`![[task:<id>]]`), and `reference`-typed
  object-prop fields. Stored in the local-only `links` table (§4.1). Never synced:
  every device syncs the same content and runs the same extractor, so every device
  derives an identical index. No sync conflicts on derived data, no extra sync
  payload, and the whole table can be truncated and rebuilt (`graph.rebuild`).
- **Authored edges** — first-class user data in synced tables, mirrored into `links`
  on write so read-side graph queries hit one table: habit stacking (`habit_links`,
  kind `stack`) and project membership (`project_members`, kind `member`).

**Wikilink conventions (decided):**

- Canonical form: `[[<type>:<uuid>]]` and embed form `![[<type>:<uuid>]]`, with an
  optional display alias `[[task:<uuid>|Buy milk]]`. Types: `note`, `task`, `habit`.
- Refs carry the entity's UUIDv7 and the UI never shows it — editors render the alias
  or live title, and autocomplete inserts refs. (Short human-friendly ids like
  `task:1` would need a synced per-user counter — a sync-conflict machine two offline
  devices can break — for a string nobody sees.)
- One parser, in Go (`core/domain/links.go`), used by note saves, task-notes saves,
  and props extraction. The editor's wikilink/taskRef nodes serialize to exactly this
  syntax so markdown stays the canonical, portable format.

### 4.1 Client SQLite schema (owned by `core/store`, applied via embedded migrations)

Conventions for every **syncable** table:

- `id` — UUIDv7 (client-generated, time-ordered)
- `created_at`, `updated_at` — RFC3339 UTC. `updated_at` is set by whoever writes;
  after a successful sync the server's value is authoritative.
- `deleting_at` — **Trash** marker (§4.3): the future instant at which the row is due to
  be permanently deleted (set to `now + 30d` when a user deletes a note/task/habit). A row
  with a non-NULL `deleting_at` is in the Trash: it is excluded from every query except the
  Trash query and is still fully syncable. Restoring clears it. **Projects and areas do not
  have this column — they are never trashed** (deleting one takes effect immediately, §6.6).
- `deleted_at` — soft delete / tombstone (rows are never hard-deleted on clients). Reached
  either by "Delete forever" from the Trash or automatically when `deleting_at` elapses (the
  server's hourly collector, §4.3 / §7.6).
- `version` — the server version of the row the client last saw (`0` = never synced)
- `dirty` — client-only flag: has local changes not yet pushed

```sql
CREATE TABLE sync_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  device_id     TEXT NOT NULL,
  server_cursor INTEGER NOT NULL DEFAULT 0,   -- last server_seq pulled
  last_synced_at TEXT
);

CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  content_md     TEXT NOT NULL DEFAULT '',    -- canonical format is markdown
  date           TEXT,                        -- optional; surfaces note on calendar
  object_type_id TEXT,                        -- archetype (NULL = plain note)
  props_json     TEXT NOT NULL DEFAULT '{}',  -- schema-validated structured metadata
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash: due-to-be-purged instant (§4.3)
  deleted_at  TEXT,
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
  object_type_id TEXT,
  props_json     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash (§4.3)
  deleted_at  TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE areas (              -- flat list; category headings in the sidebar
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  area_id     TEXT NOT NULL,      -- exactly ONE area (column, not an edge table)
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE project_members (    -- AUTHORED edges: project ⇄ note/task/habit (synced)
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  entity_type TEXT NOT NULL,      -- 'note' | 'task' | 'habit'
  entity_id   TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, entity_type, entity_id)
);
CREATE INDEX idx_project_members_entity ON project_members (entity_type, entity_id);

CREATE TABLE object_types (       -- archetype definitions; synced across devices
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  applies_to     TEXT NOT NULL,   -- 'note' | 'task' | 'both'
  schema_version INTEGER NOT NULL DEFAULT 1,
  schema_json    TEXT NOT NULL,   -- field defs + validation + display config (§6.3)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habits (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  polarity     TEXT NOT NULL DEFAULT 'build',  -- 'build' (do-streak) | 'break' (absence-streak)
  cadence_json TEXT NOT NULL,     -- structured cadence, NOT an RRULE (§6.5):
                                  --   {"kind":"daily"} | {"kind":"times_per_week","n":3}
                                  --   {"kind":"weekdays","days":[1,3,5]}
                                  --   {"kind":"every_other_day"}
                                  --   {"kind":"as_often_as_possible"}
  target_count INTEGER NOT NULL DEFAULT 1,     -- completions per period
  notify_json  TEXT,              -- schedule times + optional geofence
                                  --   {"times":["08:00"],"geo":{"lat":..,"lng":..,
                                  --    "radius_m":100,"trigger":"enter"|"exit"}}
  color        TEXT,
  archived_at  TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash (§4.3)
  deleted_at  TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habit_links (        -- AUTHORED edges: habit stacking (synced)
  id            TEXT PRIMARY KEY,
  from_habit_id TEXT NOT NULL,    -- "when I finish this…"
  to_habit_id   TEXT NOT NULL,    -- "…suggest this"
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (from_habit_id, to_habit_id)
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

CREATE TABLE links (              -- DERIVED edge index; LOCAL-ONLY (never synced)
  source_type TEXT NOT NULL,      -- 'note' | 'task' | 'habit' | 'project'
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- 'ref' | 'embed' | 'prop:<field>' | 'stack' | 'member'
  PRIMARY KEY (source_type, source_id, target_type, target_id, kind)
);
CREATE INDEX idx_links_target ON links (target_type, target_id);  -- backlinks
-- No sync columns: derived data. Safe to truncate + rebuild (graph.rebuild).

CREATE VIEW graph_nodes AS        -- slim projection for graph queries; never bodies
  SELECT id, 'note'    AS type, title,      object_type_id, NULL   AS status
    FROM notes    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'task'    AS type, title,      object_type_id, status
    FROM tasks    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'habit'   AS type, name,       NULL,           polarity
    FROM habits   WHERE deleted_at IS NULL AND deleting_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'project' AS type, name,       NULL,           area_id
    FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL;
-- Trashed rows (deleting_at set) drop out of the graph just like tombstones do.
-- Areas are not graph nodes; they surface as sidebar headings and as an optional
-- clustering dimension in the graph view (via the project's area_id).

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

Same entities plus multi-tenancy and a per-row change sequence. The server does
**not** have a `links` table — derived edges are a client-side index. It does have
`areas`, `projects`, `project_members`, `object_types`, `habit_links`, and the
`object_type_id`/`props_json` columns, since those are user data.

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
client store and the server store both map to/from them. Object-prop validation (§6.3)
runs the same Go code on push.

### 4.3 Trash & 30-day retention

Deleting a **note, task, or habit** does not tombstone it immediately. Instead the store
sets `deleting_at = now + 30d` — the row enters the **Trash**. This is a first-class,
synced state, distinct from the `deleted_at` tombstone:

- **Excluded everywhere but the Trash.** Every normal read (`List`, `Get`, sidebar,
  `graph_nodes`, link extraction) filters `deleting_at IS NULL`. The single exception is
  the Trash query, `ListTrash`, which returns exactly the rows with `deleting_at` set (and
  no tombstone). A trashed source also drops its outgoing links, so it leaves the graph.
- **Reversible.** *Restore* clears `deleting_at` (and re-derives the row's links); the item
  reappears in its normal lists. *Delete forever* from the Trash tombstones it now
  (`deleted_at = now`), the same terminal state as before.
- **Syncs like any field.** `deleting_at` rides in the entity's JSON body, so trashing,
  restoring, and its eventual purge propagate to every device through the ordinary
  push/pull path. A trashed row is *not* a tombstone (`SyncDeleted()` stays false), so it
  keeps syncing until it is actually purged.
- **Server-driven expiry (§7.6).** An hourly collector on the server promotes any row whose
  `deleting_at` has elapsed to a tombstone (`deleted_at`, new `version`/`server_seq`),
  which then pulls down to clients as a normal delete. Clients therefore never need to run
  the clock themselves; they only ever *set* `deleting_at`.

**Projects and areas are never trashed.** They have no `deleting_at` column; deleting one
takes effect immediately (§6.6) and, per that section, does not cascade to member entities.

---

## 5. The graph: link extraction & queries

The requirement: render a graph of the entire knowledgebase **without parsing it at
read time**. The design: the graph is a covering index (`links` + `graph_nodes`)
maintained incrementally inside every write transaction.

### 5.1 Write path (extraction)

`core/store` is the single choke point for writes — local mutations *and* rows applied
by sync pulls go through the same repo functions, so extraction is impossible to skip.
On every `notes.create/update` and `tasks.create/update`, inside the entity's write
transaction:

1. Parse `content_md` / `notes_md` for `[[type:id]]` (kind `ref`) and `![[type:id]]`
   (kind `embed`).
2. Parse `props_json` fields whose schema type is `reference` (kind `prop:<field>`).
3. Diff against the existing `links` rows for that source; apply the delta.

Authored-edge tables mirror into `links` in the same transaction: `habit_links` →
kind `stack`, `project_members` → kind `member` (source `project`, target the member
entity). Deleting an entity deletes its outgoing `links` rows (incoming rows may
dangle — see below).

**Dangling targets are expected and fine**: a ref may point at an entity that hasn't
synced down yet, or was deleted. The edge is stored anyway; graph queries LEFT JOIN
against `graph_nodes`, and the UI renders ghosts or hides them. When the target
arrives via sync the edge starts resolving — no reprocessing needed.

**Rebuild**: `graph.rebuild` truncates `links` and re-extracts everything in batches.
Run it after schema migrations, imports, or extractor bug fixes. It is always safe
because `links` holds no user-authored data (`stack` and `member` rows re-mirror from
`habit_links` and `project_members`).

### 5.2 Read path (queries)

All in `core/graph`, exposed via the bridge; they read **only** `links` and
`graph_nodes` (id, type, title, object_type_id, status — never bodies):

| Method | Payload | Returns |
|---|---|---|
| `graph.full` | — | `{nodes: [{id,type,title,objectTypeId,status}], edges: [{source,target,kind}]}` |
| `graph.neighborhood` | `{type, id, depth}` | same shape; recursive CTE over `links` |
| `graph.backlinks` | `{type, id}` | sources referencing this entity (powers "linked mentions") |
| `graph.rebuild` | — | `{nodes, edges}` counts |

Even `graph.full` stays small: thousands of rows of ids/titles/kinds, no markdown, no
JSON decoding.

### 5.3 Graph view (React Flow)

- Lives in `packages/app` for web/desktop. On mobile the canvas gets the same
  treatment as the editor: a DOM component shipped in a webview (React Flow is
  DOM-only).
- Default view: `graph.neighborhood(current entity, depth 2)`. A "whole graph" mode
  uses `graph.full` with elkjs/d3-force layout — fine to a few thousand nodes; beyond
  that, cluster by `object_type_id` and expand on demand.
- Edge kinds get visual treatment: `embed` solid, `ref` dashed, `stack` arrows between
  habits, `member` hulls/containment from project nodes, `prop:*` labeled with the
  field name. Node click navigates. Clustering dimensions: `object_type_id`, or area
  (via each project node's `area_id`).
- Subscribes to `data.changed` events (§5.4) to stay live.

### 5.4 Change events

Every write (local mutation or applied pull batch) emits `data.changed
{entityType, id}` through the event stream. Consumers: the graph screen, list screens,
the sidebar (project indicators recompute on task/habit-entry changes, §6.6), and any
open editor whose NodeViews embed the changed entity (§6.2).

---

## 6. Feature design

### 6.1 Notes & the editor package

- `packages/editor` — a **DOM-only** React component built on ProseMirror with a
  markdown schema (`prosemirror-markdown`): props in → markdown string out via
  `onChange`.
- Web/desktop render it directly (it's just React DOM inside RNW layouts).
- Expo renders it inside **`react-native-webview`**, loading an esbuild-produced
  bundle (`editorBundle.generated.ts`). (Expo's `'use dom'` was tried and dropped:
  DomWebView crashes on mount under Fabric on Android.) Consequences that shape the
  editor's API: props must be serializable, callbacks are async, no synchronous calls
  back into native.
- The editor **cannot import `core-bridge`** (it must run inside a webview). Anything
  that needs live data comes in through an async **data-provider prop**:

  ```ts
  interface EditorDataProvider {
    resolveRef(type: string, id: string): Promise<{title: string; status?: string} | null>;
    searchRefs(query: string): Promise<RefSuggestion[]>;   // powers [[ autocomplete
    createTask(title: string): Promise<{id: string}>;      // powers [] input rule
    toggleTask(id: string): Promise<void>;
  }
  ```

  Each shell wires it to the bridge; on webview platforms the calls cross the
  postMessage boundary, which is fine because they're already async.
- Canonical storage format is **markdown text** (`notes.content_md`) — sync, search,
  link extraction, and LLM context all operate on markdown; ProseMirror state is an
  editor-local concern.

### 6.2 Embedded tasks in notes

Tasks can be visually embedded in notes as todo-list items whose checkbox is live —
backed by the real task row, not text.

- **Serialization**: an embedded task is `![[task:<uuid>]]` on its own list line in
  `content_md`. Markdown stays canonical and portable.
- **Checkbox state is never in the markdown** — it renders from the task row's
  `status` via `resolveRef`, and toggling calls `toggleTask` → `tasks.update`. The
  note's markdown doesn't change on toggle, so no note dirty-flag churn and no sync
  conflict between "checked the box" and "edited the note". This is the payoff of
  keeping state in the task row.
- **NodeView** (`taskRef`): checkbox + live title (+ due date chip), with an expand
  affordance for editing the full task.
- **Input rules**: typing `[] buy milk` + Enter creates a real task via `createTask`
  and replaces the text with a `taskRef` node. Typing `[[` opens ref autocomplete
  backed by `searchRefs`.
- `data.changed` events refresh NodeViews when an embedded task is edited elsewhere or
  synced down while the note is open.

### 6.3 Object types (archetypes)

- An **object type** turns a note or task into a structured object: `object_type_id`
  selects the archetype, `props_json` holds the metadata, and the type's
  `schema_json` defines fields, validation, and display. Definitions sync like any
  other entity, so archetypes are consistent across devices.
- `schema_json` is a **versioned custom document**, not JSON Schema. Start with a
  flat field list — `{key, type, label, required, options?}` with types
  `text | number | date | select | multi_select | reference | checkbox | url` — inside
  an envelope that leaves room for what's coming: `rules` (conditional show/require),
  `steps` (multi-step forms), `layout`. (Full JSON Schema would immediately need
  nonstandard extensions for display logic — worst of both worlds.)
- **Validation lives once, in Go** (`core/domain/objecttype.go`): `Validate(props,
  schema)` runs on every create/update; the server runs the identical code on push.
  The TS side is a form *renderer* reading the same schema. The rule: **TS decides
  what to show, Go decides what's valid.**
- `reference`-typed fields make objects graph participants:
  `{"key":"author","type":"reference","to":"note"}` produces a `prop:author` edge.
  That's how a Book note's author or a Project task's related notes appear in the
  graph with labeled edges.
- `schema_version` + migration note: editing a type does not rewrite existing rows;
  validation is applied on next write of each row, and the form renderer tolerates
  missing/extra keys. (Bulk re-validation is a later polish item.)

### 6.4 Tasks, reminders, repeating tasks

- **Kinds** collapse into columns, not subtypes: a one-off task has neither `due_at`
  nor `repeat_rule`; a scheduled task has `due_at`; a reminder has `remind_at`; any
  task may be archetyped via `object_type_id`.
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

### 6.5 Habits: cadences, polarity, stacking, streaks

- **Cadence** is structured JSON (§4.1), *not* an RRULE — `times_per_week` and
  `as_often_as_possible` aren't expressible as RRULEs. RRULE stays a tasks-only
  concept. Streak math (`core/domain/streaks.go`) switches on `cadence_json.kind`;
  streaks are computed on read, never stored, so sync can't corrupt them. Timezone
  rule: entries record the device-local calendar date.
- **Builders vs breakers** (`polarity`): for a builder, a streak day is a day the
  cadence was satisfied. For a breaker, a streak day is a day with **no** entry — an
  entry means "I slipped" and resets the streak. Same `habit_entries` table serves
  both.
- **Stacking** (`habit_links`): completing habit A (`habits.logEntry`) returns
  `stackSuggestions` — the `stack`-edge targets not yet completed today — so the shell
  can immediately prompt "next: X". Edges form a graph (DAGs and even cycles are
  allowed at the data level); the suggestion logic simply never re-suggests a habit
  already done today.
- **Notifications & geofencing**: `core/notify` stays pure — it emits time-based fires
  (from `notify_json.times` + cadence) and geofence *definitions*. Registration is
  shell work: `expo-notifications` + `expo-location` geofencing on mobile;
  desktop/web get time-based only (state this in the UI). Geofences enable location
  habit-stacking ("arrive at gym → suggest the gym stack").

### 6.6 Areas, projects & the sidebar

Areas and projects are the app's organizational layer, distinct from archetypes
(objects say what something *is*; projects say what it's *for*).

- **Areas** are a flat, ordered list ("Health", "Work", "Family"). They render as
  category headings in the sidebar — they are not nodes, pages, or containers of
  content, only of projects.
- **Projects** render as navigation items under their area's heading, each with two
  live indicators:
  - a **circular progress ring** — fraction of the project's member tasks completed;
  - a **fire icon** that fills bottom-up with color — how well the project's member
    habits' streaks are doing.
- Membership is edited from either end: a project screen has "add note/task/habit"
  pickers, and each entity's detail view has a project selector (multi-select).
  Member entities also appear as `member` edges in the graph view.

**Sidebar data is one bridge call, computed in core** so every client renders
identical numbers:

```
nav.sidebar -> {
  areas: [{ id, name, color, projects: [{
    id, name, color,
    taskProgress,   // 0..1: done / (open + done) member tasks, cancelled excluded;
                    //        null if the project has no tasks (ring hidden)
    habitHealth     // 0..1: mean streak-health of member habits; null if none
  }]}],
  unsorted: [ ...projects whose area_id dangles... ]
}
```

- `taskProgress` is a SQL aggregate over `project_members ⋈ tasks` — cheap, no bodies
  loaded. Repeating-task occurrences count individually; seeds don't count.
- `habitHealth` reuses the **streak-health** pure function in
  `core/domain/streaks.go`: per habit, the fraction of cadence obligations met over
  the trailing 7 days (builders: completions vs required; breakers: clean days / 7;
  `as_often_as_possible`: entry-days / 7). Project value is the mean across member
  habits. Defining this in core keeps the fire fill consistent everywhere and
  reusable on habit detail screens.
- The sidebar recomputes on `data.changed` for tasks, habit entries, projects,
  members, and areas (debounced).

**Deletion semantics**: areas and projects delete *immediately* — they never go to the
Trash (§4.3) and have no `deleting_at`. Deleting an area does not cascade — its projects
keep their dangling `area_id` and render under an implicit "Unsorted" heading until
reassigned (same philosophy as dangling wikilinks: tolerate, don't destroy). Deleting a
project tombstones its `project_members` rows but never touches the member entities.
Deleting a **note, task, or habit**, by contrast, moves it to the Trash for 30 days (§4.3);
its `project_members` rows are left intact so restoring returns it to its projects.

### 6.7 Calendar

- `calendar_feeds` are user data (synced). The **server** fetches each ICS URL every
  15–30 min (`emersion/go-ical`), expands recurrences over a ±1y window, and upserts
  `calendar_events` (server-owned, read-only on clients, delivered via normal sync).
  Clients never fetch ICS — one fetcher, no CORS problems, consistent clone.
- The calendar UI is a query in core: `calendar.range(from, to)` merges
  `calendar_events` + tasks with `due_at`/`remind_at` + notes with `date` + habit
  cadence occurrences — one shared implementation, every client gets the same view.

### 6.8 LLM

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
  against SQLite (`search_notes`, `list_tasks`, `list_projects`, `get_habit_stats`,
  `calendar_range` — and, thanks to the link index, `get_backlinks` /
  `get_neighborhood` for graph-aware answers like "what's connected to the Q3 launch
  project?"). The chat orchestration loop lives entirely in `core/llm`, so
  "ask my data" behaves identically on every platform, and private data only leaves
  the device as the context the user's chosen LLM receives.

---

## 7. Sync protocol

Client-side engine lives in `core/sync` (shared by all clients). Server endpoints:

```
POST /v1/auth/login|register     -> bearer token
GET  /v1/sync/pull?cursor=N&limit=500
POST /v1/sync/push
GET  /v1/sync/events             -> SSE stream: realtime change notifications (§7.5)
GET  /v1/secrets / PUT /v1/secrets/{key}
```

Entity types on the wire: `note`, `task`, `area`, `project`, `project_member`,
`object_type`, `habit`, `habit_link`, `habit_entry`, `calendar_feed`,
`calendar_event`, `llm_config`. **`links` rows never sync** — they are derived
locally (§5.1). Applied pull rows go through the store's
normal write path, so extraction runs on synced content too.

### 7.1 Pull

Response: ordered list of `{entity_type, row, server_seq}` with `server_seq > cursor`,
plus `next_cursor`. Client applies each row:

- If the local row is **not dirty** → overwrite local, set `version`, clear nothing.
- If the local row **is dirty** → conflict, resolved by the rules below.
- Advance `server_cursor` only after the batch is applied in one transaction.

### 7.2 Push

Client sends every dirty row: `{entity_type, id, base_version (=local version), fields, updated_at}`.
Server, per row, in a transaction:

1. Row doesn't exist → insert, `version = 1`, assign `server_seq`. **Accepted.**
2. Row exists, `row.version == base_version` → apply, `version++`, new `server_seq`. **Accepted.**
3. Row exists, `row.version > base_version` → **stale push**; apply the conflict rule:
   - If `server.updated_at >= client.updated_at` → **server wins.** Response:
     `{status: "conflict", server_row}`.
   - If `client.updated_at > server.updated_at` → client is newer → apply the client's
     fields anyway (`version++`). **Accepted.** (Server wins only *if it's newer*.)

### 7.3 Conflict handling on the client ("server wins → local becomes a copy")

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

Conflicted copies get fresh ids, so inbound wikilinks keep pointing at the canonical
row — links never dangle because of conflict resolution.

### 7.4 Sync loop

- Trigger: on app start, on any local mutation (debounced), on a realtime change
  event (§7.5), on periodic timer (fallback), on network regained.
- Order: **push first, then pull** (push may generate conflicts whose canonical rows
  arrive in the following pull; the conflicted copies push next round — the loop
  converges).
- All of this is `core/sync` code — identical on every platform; only the HTTP
  transport is injected (fetch on wasm, net/http elsewhere).

### 7.5 Realtime change notifications (SSE)

When one client pushes, the others should sync within about a second instead of
waiting for a timer. Mechanism: **server-sent events** — one long-lived HTTP stream
per online device, chosen over WebSockets because the channel is strictly one-way
(the trigger), auto-reconnect is built into the protocol, and it's plain HTTP
(friendly to proxies, auth middleware, and the wasm client story).

**Server** (`apps/server`):

- `GET /v1/sync/events` — authenticated, long-lived SSE response. An in-process
  per-user hub (`map[userID] → set of subscriber channels`) registers each
  connection.
- After **any** transaction that bumps `user_seq` commits — a client push, cron
  materializing repeat occurrences, the ICS fetcher upserting events — the hub
  publishes to that user's subscribers:

  ```
  event: change
  data: {"server_seq": 1234}
  ```

- Heartbeat comment (`: ping`) every ~25s keeps idle proxies from killing the
  stream; `retry: 5000` sets client reconnect backoff. Notifications are
  fire-and-forget — **delivery needn't be reliable**, because every reconnect
  triggers a full sync cycle (below), and the periodic-timer trigger remains as a
  belt-and-braces fallback. No Last-Event-ID bookkeeping, no replay buffer.
- v1 hub is in-process (single server instance). The scale-out path is Postgres
  `LISTEN/NOTIFY` fanning out to each instance's hub — documented, not built.

**Client** (`SyncNotifier` in `packages/core-bridge` — deliberately **not** in the Go
core: it's connection-lifecycle glue tied to app foreground/visibility, and the
core's job stays "run a sync cycle when poked"):

```ts
interface SyncNotifier {
  connect(baseUrl: string, token: string): void;
  disconnect(): void;
  onChange(cb: () => void): () => void;   // shell wires cb -> debounced sync.run
}
```

- **Web + desktop** (`.web.ts`): a fetch + `ReadableStream` SSE parser — *not* native
  `EventSource`, which cannot send an `Authorization` header (the alternative,
  tokens in query strings, leaks bearer tokens into server logs). Works identically
  in the browser and the Wails webview.
- **Mobile** (`.native.ts`): `react-native-sse` (an `EventSource` polyfill that does
  support custom headers) over the same endpoint.
- On `change`: debounce ~300ms, then invoke `sync.run`. The originating device hears
  its own echo, but that cycle is a cheap no-op — its cursor already advanced past
  the announced `server_seq` during its own push+pull. No origin-exclusion logic
  needed.
- **On every (re)connect: run `sync.run` immediately.** A reconnect means events may
  have been missed; this one rule covers server restarts, dropped connections, and
  laptop sleep without any delivery-tracking machinery.
- Lifecycle wiring per shell: web/desktop connect while the app runs and reconnect
  on `visibilitychange`; mobile connects on foreground and disconnects on background
  (the OS would sever it anyway) — foregrounding reconnects, which syncs. True
  background delivery is a later, separate mechanism: silent push via APNs/FCM
  (Polish milestone), the background complement to SSE, using the same "poke
  sync.run" contract.

End-to-end, the realtime pipeline composes entirely from existing pieces: remote
edit → push → SSE `change` → other clients `sync.run` → pull applies rows through
the normal store write path → link extraction → `data.changed` events → open
screens (graph, sidebar indicators, embedded-task NodeViews) update live.

### 7.6 Trash collector (server cron)

The server owns Trash expiry (§4.3). A background goroutine wakes **hourly** (and once at
startup) and, per user, promotes every trashable row whose `deleting_at` has elapsed to a
tombstone: `deleted_at = deleting_at`, a fresh `version` and `server_seq`. Because that is
an ordinary row bump, the change flows out through the normal pull path — and, if any rows
were purged for a user with live devices, the same `change` SSE that a push triggers (§7.5)
so their next `sync.run` pulls the tombstones. Clients never run the retention clock; they
only set `deleting_at` (delete) or clear it (restore). Only entities that carry
`deleting_at` are swept — projects and areas are never touched.

---

## 8. What lives where (the reuse matrix)

| Logic | core (Go, shared) | Client shell (per platform) | Server (Go) |
|---|---|---|---|
| Entity models, validation | ✅ single source | — | ✅ imports core/domain |
| Object schemas: validation | ✅ | — | ✅ same code on push |
| Object schemas: form rendering | — | ✅ packages/app renderer | — |
| Wikilink parsing + link extraction | ✅ | — | — |
| Graph queries (full/neighborhood/backlinks) | ✅ | — | — |
| Graph canvas (React Flow) | — | ✅ packages/app (webview on mobile) | — |
| SQLite schema + migrations + repos | ✅ | — | — (own Postgres repos) |
| Sync engine (client side) | ✅ | — | ✅ counterpart endpoints |
| Realtime change fanout (SSE hub) | — | — | ✅ |
| SSE client + reconnect/app-lifecycle | — | ✅ core-bridge (fetch-stream / react-native-sse) | — |
| Conflict resolution + conflicted copies | ✅ | — | ✅ version check + rule |
| RRULE parsing / next-occurrence (tasks) | ✅ | — | ✅ same package (cron) |
| Repeat occurrence **generation** | — | — | ✅ cron only |
| Habit cadence + streak computation (incl. streak-health) | ✅ | — | — |
| Habit stack suggestions | ✅ | — | — |
| Sidebar stats (`nav.sidebar`: task %, habit health) | ✅ | — | — |
| Sidebar rendering (headings, ring, fire fill) | — | ✅ packages/app + shells | — |
| Notification **planning** (incl. geofence defs) | ✅ | — | — |
| Notification **scheduling/display**, geofence registration | — | ✅ Wails / expo-notifications+location / Web API | — |
| ICS fetch + parse + clone | — | — | ✅ |
| Calendar merge query | ✅ | — | — |
| LLM chat orchestration + retrieval tools | ✅ | — | — |
| Secret storage | — | ✅ keychain/SecureStore/DPAPI | ✅ encrypted secrets table |
| Auth token persistence | — | ✅ | ✅ issue/verify |
| UI, navigation, state presentation | — | ✅ packages/app (+ per-platform shells) | — |
| Editor | — | ✅ packages/editor (DOM; webview bundle on Expo) | — |

Rule of thumb: **if it touches data or decisions, it's Go in `core/`; if it touches
the OS or pixels, it's in the shell; if it must run when devices are asleep
(repeats, ICS), it's on the server.**

---

## 9. Build & tooling

- **Root scripts** (npm) orchestrate everything; Go builds via `make` or `task`:
  - `build:core:wasm` → `GOOS=js GOARCH=wasm go build -o build/core.wasm ./core/cmd/wasm`
  - `build:core:android` → `gomobile bind -target=android -o build/core.aar ./core/cmd/mobile`
  - `build:core:ios` → `gomobile bind -target=ios -o build/Core.xcframework ./core/cmd/mobile`
  - Desktop needs no artifact — `apps/desktop` imports `core/` via `go.work`.
  - `packages/editor` additionally builds its webview bundle with esbuild
    (`editorBundle.generated.ts`).
- **CI matrix**: `go test ./core/... ./apps/server/...` (the payoff of core-heavy
  design: business logic — including extraction, graph queries, schema validation,
  streaks — is tested once, headlessly, fast), TS typecheck/lint, wasm build,
  gomobile builds on a mac runner, Wails builds per OS.
- **Versioning**: core bridge methods are versioned (`core.version` invoke); clients
  refuse to run against an incompatible artifact.

---

## 10. Milestones

Done:

1. ✅ **Skeleton** — go.work; `core/bridge` invoke dispatcher; SQLite store +
   migrations; Notes CRUD end-to-end on **desktop (Wails)**.
2. ✅ **Web + wasm** — Vite RNW app; `core.wasm`; wa-sqlite/OPFS driver behind
   `store.Driver`. Notes work offline in the browser.
3. ✅ **Server + sync** — auth, push/pull, conflict rule + conflicted copies, sync
   loop in core. Notes sync everywhere.
4. ✅ **Mobile (basic)** — Expo app; gomobile + local expo module; editor via
   react-native-webview bundle; own mobile shell. Notes on all six platforms.
5. ✅ **Graph substrate** — `links` table + migration; wikilink parser
   (`core/domain/links.go`); extraction wired into the note write path *including
   sync-apply*; `graph.*` bridge methods; `graph.rebuild`; `data.changed` events;
   React Flow view over notes only. *Small, and proves the whole pattern before
   tasks exist.*
6. ✅ **Realtime sync** — `GET /v1/sync/events` + per-user SSE hub on the server
   (`apps/server/hub.go`, `events.go`), publishing after every `user_seq`-bumping
   push; `SyncNotifier` in core-bridge (`notifier.ts` fetch-stream web/desktop,
   `notifier.native.ts` react-native-sse mobile, injected by the shell); SyncProvider
   lifecycle wiring (visibility / foreground) + sync-on-(re)connect + reconnect on
   token rotation. Notes edited on one device appear on the others in ~a second.
   *Small, and every later milestone inherits it.*
7. **Areas + projects** — `areas`/`projects`/`project_members` entities + sync;
   `member` edge mirroring; sidebar with area headings and project nav items;
   note membership pickers; `nav.sidebar` (indicators return null until tasks and
   habits exist and simply light up as later milestones land).

8. ✅ **Tasks + reminders** — `tasks` entity + sync (`core/domain/task.go`,
   `core/store/tasks.go`, server `taskHandler`); task nodes join the graph via the same
   `notes_md` extraction path; Trash lifecycle like notes; task↔project membership (the
   sidebar progress ring is now live); `core/notify` notification planning +
   `RemindersProvider` (web `Notification` scheduler, native injection point); task UI
   (global Tasks splitview, project Tasks section, mobile list + editor); due/reminder via
   natural-language parsing (`core/dates` over `olebedev/when`) + a concrete date/time
   picker + quick presets.
9.  **LLM** — provider configs (device vs account scope), secrets sync, chat with
    local retrieval tools (including graph + project tools), streaming UI.
10.  ✅ **Objects** — `object_types` entity + sync (`core/domain/objecttype.go`,
    `core/store/objecttypes.go`, server `objectTypeHandler`); `object_type_id`/`props_json`
    on notes and tasks; Go schema + props validation (`domain.Validate`/`ValidateProps`,
    run identically on the client write path and the server push); TS form renderer
    (`ObjectForm`/`ArchetypeSection`) + type management UI (`ObjectTypeSettings`, an Objects
    settings tab); `prop:<field>` reference edges derived on every write and sync-apply
    (`links.SyncEntitySource`, so extraction still equals `graph.rebuild`); graph nodes
    colored/clustered by `object_type_id` with labeled `prop:*` edges.


Next:
11.  **Repeating tasks** — RRULE on seeds, server cron materialization, regeneration
    on rule edit (occurrences reach other devices instantly via SSE → sync).
12.  **Habits** — cadence kinds + polarity + streak math + streak-health; entries UI;
    `habit_links` stacking + suggestions; `stack` edges in the graph; habit
    membership; the sidebar fire icon goes live; notification schedules; geofence
    registration on mobile.
13.  **Calendar** — feeds, server ICS fetcher, event clone, merged calendar view.
14.  **Polish** — silent push (APNs/FCM) as the background complement to SSE,
    tombstone retention + full-resync path, E2E-encrypted secrets, bulk
    re-validation on schema edits, import/export.

---

## 11. Risks & open questions

- **Web wasm size/perf.** Go-wasm binaries are large (several MB — mitigable with
  `-ldflags="-s -w"` + wasm-opt + gzip/brotli); the injected wa-sqlite driver crosses
  the JS↔wasm boundary per query (fine for this workload, but measure); OPFS requires
  cross-origin isolation headers. Fallback if it becomes untenable: web runs
  "online mode" against the server API (server reuses core logic), sacrificing web
  offline only. *Milestone 2 shipped; keep measuring as the schema grows.*
- **Webview components on native.** The editor (and later the graph canvas) live in
  `react-native-webview` with esbuild bundles — Expo's `'use dom'` crashed on Fabric
  on Android and was dropped. Keyboard/IME behavior and the postMessage boundary need
  testing per feature; all editor↔shell APIs must stay async + serializable.
- **Wails v3** (needed for clean service bindings + notifications) is still
  alpha-ish; pin a known-good version. v2 fallback: bind the same `Invoke` method.
- **Extraction-on-apply is load-bearing.** The guarantee that every device derives an
  identical `links` table depends on sync-applied rows going through the same store
  write path as local mutations. Guard it with a test: apply a pull batch, assert
  extracted links match a from-scratch `graph.rebuild`.
- **Object schema evolution.** Editing a type's `schema_json` can invalidate existing
  rows; v1 policy is validate-on-next-write + tolerant rendering. Revisit if types
  get heavy use (bulk migration tooling in Polish).
- **Geofencing platform limits.** OS caps on simultaneous geofences (~20 on iOS,
  ~100 on Android) mean the shell registers only the nearest/active habit geofences;
  core's plan output should be prioritized. Desktop/web have no geofencing — UI must
  say so.
- **Graph scale.** `graph.full` + force layout is fine to a few thousand nodes;
  beyond that, default to neighborhood views and cluster-by-type. The link index
  itself scales fine (it's a covering index with two small B-trees).
- **Clock skew**: conflict rule compares `updated_at` from different devices. Server
  clamps client timestamps to `now()` when they arrive from the future; document that
  "newer" is best-effort.
- **SSE in production dress.** Reverse proxies buffer streaming responses unless
  told not to (nginx: `proxy_buffering off` / `X-Accel-Buffering: no`); idle
  timeouts need the ~25s heartbeat; browsers cap concurrent HTTP/1.1 connections
  per host at ~6 (a user with several tabs open can starve the pool — serve over
  HTTP/2, where streams are effectively unlimited). None of this is exotic, but it
  all needs to be in the deployment docs, and the periodic-timer fallback means a
  misbehaving proxy degrades to slow sync, not broken sync.
- **Mobile realtime is foreground-only.** SSE dies when the app backgrounds (by
  design — the OS would kill the socket). Until silent push lands (Polish), the
  contract is: foreground = realtime, background = catch up on next foreground.
  State this in the UI copy rather than fighting iOS background-execution limits.
- **Sidebar stat freshness vs cost.** `nav.sidebar` recomputes aggregates on every
  relevant `data.changed`. The queries are index-only and per-project, so this is
  cheap at realistic scale; if it ever isn't, memoize per-project stats keyed on the
  underlying tables' max `updated_at` before reaching for stored counters (stored
  counters + sync is how numbers drift).
- Open: multi-user vs single-user self-hosted first (plan assumes multi-user-capable
  but ships single-user auth); Anthropic vs OpenAI-compatible-only at launch;
  Postgres vs server-side SQLite for self-hosters (schema above ports easily);
  whether `habit_entries` for breakers should record "slip severity" (count already
  covers it loosely); whether area deletion should be blocked while non-empty
  (current plan: allow it, projects fall into "Unsorted"); whether the exact
  streak-health window (trailing 7 days) is the right fire-icon signal or should be
  configurable per habit.
