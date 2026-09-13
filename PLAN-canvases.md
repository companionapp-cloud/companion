# Canvases — Implementation Plan

An infinite 2D canvas that holds notes, tasks, calendar events, images, link previews,
sticky notes and colored groups, with arrows between them. Synced, E2E-encrypted, and
identical on web, desktop (Wails) and mobile (Expo).

This plan follows the conventions in `PLAN.md`: business logic in the Go core, React as
presentation, one JSON-over-`invoke` API, row-level sync, and the existing "DOM component
on web, same bundle inside a WebView on mobile" pattern already used by the editor and the
graph view.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Renderer | **React Flow** (`@xyflow/react` 12.8.6, already a dependency) | Already ships in `GraphView.web.tsx`; gives pan/zoom, drag, multi-select, box-select, custom nodes/edges, arrowheads, resize, minimap. No new gesture/animation libraries. |
| Mobile | **Same React Flow bundle inside `react-native-webview`**, cloned from `scripts/build-graph.mjs` / `GraphCanvas.tsx` | React Flow is DOM-only. Native RN gesture code would be a second renderer to maintain, and the repo deliberately has no gesture-handler/reanimated/skia. Bonus: ProseMirror inside note nodes is plain DOM there, not nested WebViews. |
| Persistence | **Three synced entities: `canvas`, `canvas_node`, `canvas_edge`** (not one JSON blob per canvas) | The sync engine resolves conflicts per row. A single-blob canvas would fork a "conflicted copy" canvas every time two devices nudged different nodes. Per-row lets concurrent edits of different nodes merge cleanly. |
| Conflicts on nodes/edges | Server wins, **no conflicted copy** (`MeaningfulDiff` → `false`, like `calendar_event`) | Positions churn constantly; forked sticky notes would be noise. Lost-write window is one edit of one node. |
| Groups | **Geometric containment, no `parent_id`** | Obsidian's model: a group is a rect drawn behind; dragging it translates whatever is inside. Keeps coordinates absolute everywhere (DB, wire, JSON Canvas export) and avoids reparent math on sync. |
| Coordinates | Absolute canvas units, top-left origin, `x y width height` floats | Matches React Flow node positions and the JSON Canvas spec. |
| Embedded entities | Reference by id (`ref_type` + `ref_id`); content hydrated by the core on read | Never duplicate note/task/event content into the canvas. `canvases.get` returns the resolved titles/excerpts in one call. |
| Link previews | **Parsed in Go** (`core/unfurl`), fetched directly on native, via a **blind server proxy** on web | Same split as ICS feeds under E2EE. One parser, tested once. The server never stores or parses page content. |
| Encryption | `canvas.name`, `canvas_node.dataJson`, `canvas_edge.label` encrypted; geometry, ids, refs plaintext | "Content encrypted, coordination metadata not." Refs are plaintext exactly like `project_members.entity_id`. |
| Interop | Node kinds map 1:1 to the **JSON Canvas** spec (`text`, `file`, `link`, `group`) plus `note`/`task`/`event` | Free `.canvas` export/import for Obsidian users later; the repo already has an Obsidian vault importer. |

---

## 1. Data model

### 1.1 Client SQLite — `core/store/migrations/0015_canvases.sql`

```sql
CREATE TABLE canvases (
  id          TEXT PRIMARY KEY,               -- UUIDv7
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash (30d), like notes
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE canvas_nodes (
  id         TEXT PRIMARY KEY,
  canvas_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,                    -- text | group | note | task | event | image | link
  x REAL NOT NULL, y REAL NOT NULL,
  width REAL NOT NULL, height REAL NOT NULL,
  z          INTEGER NOT NULL DEFAULT 0,       -- stacking; groups default to -1
  color      TEXT,                             -- optional swatch (text, group, edge accents)
  ref_type   TEXT,                             -- note | task | event | document  (plaintext, like project_members)
  ref_id     TEXT,
  data_json  TEXT NOT NULL DEFAULT '{}',       -- kind-specific content, ENCRYPTED (see 1.3)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes (canvas_id);
CREATE INDEX idx_canvas_nodes_ref    ON canvas_nodes (ref_type, ref_id);

CREATE TABLE canvas_edges (
  id           TEXT PRIMARY KEY,
  canvas_id    TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL,
  from_side    TEXT,                           -- top | right | bottom | left | NULL (auto/floating)
  to_side      TEXT,
  from_end     TEXT NOT NULL DEFAULT 'none',   -- none | arrow
  to_end       TEXT NOT NULL DEFAULT 'arrow',
  label        TEXT NOT NULL DEFAULT '',       -- ENCRYPTED
  color        TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_canvas_edges_canvas ON canvas_edges (canvas_id);

-- Local-only, never synced: last viewport per canvas on this device.
CREATE TABLE canvas_views (
  canvas_id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, zoom REAL NOT NULL
);

-- Canvases become graph nodes: DROP VIEW graph_nodes; CREATE VIEW graph_nodes AS ... UNION
-- SELECT 'canvas', id, name ... (same pattern as 0011_documents.sql).
```

`data_json` per kind:

| kind | `data_json` | `ref_type`/`ref_id` |
|---|---|---|
| `text` (sticky) | `{ "text": "markdown" }` | — |
| `group` | `{ "label": "Q3 launch" }` | — |
| `note` | `{}` | `note` / note id |
| `task` | `{}` | `task` / task id |
| `event` | `{ "startsAt": "...", "title": "..." }` cached fallback | `event` / `calendar_events.id` |
| `image` | `{ "alt": "" }` | `document` / document id |
| `link` | `{ "url", "title", "description", "imageUrl", "siteName", "faviconUrl", "fetchedAt" }` | — |

Event refs cache a title/start in `data_json` because `calendar_events` rows are derived from
feeds and can be re-expanded away; the node degrades to its cached label instead of a ghost.

### 1.2 Domain — `core/domain/canvas.go`

`Canvas`, `CanvasNode`, `CanvasEdge` structs with JSON tags mirroring the columns, each
implementing `SyncEntity` (`SyncID/SyncVersion/SyncUpdatedAt/SyncDeleted/SyncDirty`) plus
`Validate()`:

- kind ∈ allowed set; `width/height > 0`; `ref_type` required iff kind ∈ {note, task, event, image}
- edge: `from_node_id != to_node_id`, sides/ends in allowed sets
- `data_json` must be a JSON object; `text` capped (e.g. 20 kB); link fields capped

Add `NodeCanvas = "canvas"` to `linkTypes` and `typeAliases` in `core/domain/links.go` so
`[[canvas:<id>]]` becomes a valid wikilink and canvases appear in the graph.

### 1.3 Encryption — `core/crypto/rows.go`

```go
protocol.EntityCanvas:     {"name"},
protocol.EntityCanvasNode: {"dataJson"},
protocol.EntityCanvasEdge: {"label"},
```

Add the three tables to `reencryptTables` in `core/store/reencrypt.go`. Geometry, `kind`,
`color`, `ref_*` stay plaintext: the server needs none of them, but they carry no user
content beyond what `project_members` already exposes.

### 1.4 Graph edges

Mirror node refs into the local `links` index as an **authored** edge, exactly like
`project_members` → `KindMember`:

- `source = canvas:<canvas_id>`, `target = <ref_type>:<ref_id>`, `kind = "canvas"`
- Written on local create/delete and on sync-apply; re-derived in `LinksRepo.Rebuild`
- `event` refs are **not** indexed (events aren't graph nodes); `document` refs are

Result: the backlinks panel on a note shows "On canvas: Q3 launch", and the graph view
draws canvas hubs.

### 1.5 Server — `packages/syncserver`

- `db.go`: `canvases`, `canvas_nodes`, `canvas_edges` tables (add `user_id`, `server_seq`,
  drop `dirty`), `idx_*_user_seq` indexes; add to the Postgres `TRUNCATE` list in
  `sync_test.go`.
- `server_entities.go`: `canvasHandler`, `canvasNodeHandler`, `canvasEdgeHandler`
  (`upsert` / `loadRaw` / `pull` closures + scanners), registered in `sync.go` `handlers()`.
- `trash.go`: add `canvases` to `trashTables`; when a canvas is purged, tombstone its
  nodes and edges in the same transaction so children stop syncing.
- New route `POST /v1/proxy/fetch` (section 4.3).
- Tests: `canvas_sync_test.go` — two devices each move a *different* node of the same
  canvas and converge; two devices move the *same* node and the newer `updated_at` wins
  with no forked row; trashing then purging a canvas tombstones its children.

---

## 2. Core API (bridge methods)

`core/bridge/canvases.go`, cases added to `Invoke` in `core/bridge/bridge.go`. Every
mutation emits `canvases.changed` and `data.changed {entityType, id}`.

| Method | Payload → Result |
|---|---|
| `canvases.list` | → `Canvas[]` (excludes trashed), with `nodeCount` |
| `canvases.create` | `{name}` → `Canvas` |
| `canvases.update` | `{id, name}` → `Canvas` |
| `canvases.delete` / `deleteMany` | `{id}` → trash (sets `deleting_at`), like notes |
| `canvases.get` | `{id}` → `CanvasDocument` (below) |
| `canvases.nodes.upsert` | `{canvasId, nodes: CanvasNodeInput[]}` → `CanvasNode[]` (batch; creates or updates) |
| `canvases.nodes.delete` | `{ids}` → `{count}` (tombstone; also tombstones attached edges) |
| `canvases.edges.upsert` | `{canvasId, edges: CanvasEdgeInput[]}` → `CanvasEdge[]` |
| `canvases.edges.delete` | `{ids}` → `{count}` |
| `canvases.view.get` / `view.set` | local-only viewport persistence |
| `canvases.linkPreview` | `{url}` → `LinkPreview` (section 4.3) |
| `canvases.export` | `{id}` → JSON Canvas document (phase 7) |

```ts
interface CanvasDocument {
  canvas: Canvas;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  refs: {                                   // hydrated by the core in one query each
    notes:     Record<string, { title: string; excerpt: string; objectTypeId?: string; missing?: boolean }>;
    tasks:     Record<string, { title: string; status: TaskStatus; dueAt?: string; missing?: boolean }>;
    events:    Record<string, CalendarItem | { missing: true }>;
    documents: Record<string, { filename: string; mime: string; missing?: boolean }>;
  };
}
```

`excerpt` is the first ~300 chars of the note's markdown with wikilink syntax rendered to
its alias/title (reuse `domain.ParseRefs`). Trashed or deleted targets come back as
`missing: true` so the node renders a "not found" state instead of vanishing.

Trash integration: add `"canvas"` to `TrashEntityType`, list/restore/purge branches in
`core/bridge/trash.go`, and the canvas row to `TrashScreen`.

Project membership: allow `entity_type = 'canvas'` in `project_members` (validation in
`core/domain/projectmember.go`, `MembershipPicker`, sidebar sections). No schema change.

TypeScript: `packages/core-bridge/src/canvases.ts` (`canvasesApi(core)` factory, nested
`nodes`/`edges`/`view` namespaces like `calendar.ts`), types in `types.ts`, exported from
`index.ts`, registered in `CoreContext.tsx`.

---

## 3. UI architecture

### 3.1 Files

```
packages/app/src/canvas/
  host.ts                  CanvasHost interface — the ONLY seam CanvasView talks through
  CanvasView.web.tsx       React Flow renderer (DOM-only; the whole feature's UI)
  nodes/
    TextNode.tsx           sticky note: colored card, inline-editable markdown-lite
    GroupNode.tsx          labeled rect behind other nodes, NodeResizer
    NoteNode.tsx           title + excerpt, "open" affordance
    TaskNode.tsx           reuses TaskRow/Checkbox shape; toggles status through host
    EventNode.tsx          reuses CalendarItemInfo shape; opens calendar day
    ImageNode.tsx          <img> via host.resolveDocument, aspect-locked resize
    LinkNode.tsx           og:image, title, description, site chip; loading/error states
  edges/CanvasEdge.tsx     bezier with per-end arrowheads, inline label editor
  geometry.ts              containment, nearest-side, bounds, snapping (pure, unit-testable)
  useCanvasDocument.ts     load + revision-driven refetch + held-node merge
  useCanvasHistory.ts      bounded undo/redo stack of node/edge snapshots
  CanvasToolbar.tsx        add-node menu, zoom, fit, undo/redo
  CanvasCanvas.web.tsx     web/desktop wrapper: CanvasView + core-backed host
  CanvasCanvas.tsx         native wrapper: WebView + postMessage RPC host
  CanvasScreen.tsx         route screen (list of canvases / open canvas)
  webview/canvas-main.tsx  WebView entry (mirrors webview/graph-main.tsx)
packages/app/scripts/build-canvas.mjs      esbuild → src/canvasBundle.generated.ts
```

`CanvasView.web.tsx` imports nothing from the provider tree. Everything it needs to read or
write goes through `CanvasHost`, so the identical component runs in the DOM (web/desktop)
and inside the mobile WebView.

### 3.2 `CanvasHost`

```ts
interface CanvasHost {
  load(canvasId): Promise<CanvasDocument>;
  upsertNodes(canvasId, nodes: CanvasNodeInput[]): Promise<CanvasNode[]>;
  deleteNodes(ids: string[]): Promise<void>;
  upsertEdges(canvasId, edges: CanvasEdgeInput[]): Promise<CanvasEdge[]>;
  deleteEdges(ids: string[]): Promise<void>;
  getView / setView(canvasId, viewport);
  onChanged(cb: () => void): () => void;          // canvases.changed + data.changed

  openRef(ref: { type; id }): void;                // nav.openNote / openTask / calendar day
  toggleTask(id, status): Promise<void>;
  pickRef(type: "note" | "task" | "event"): Promise<{ id; label } | null>;   // picker UI
  pickImage(): Promise<{ documentId } | null>;
  ingestImage?(file: File): Promise<{ documentId }>; // web/desktop paste + drop
  resolveDocument(id): Promise<{ url; mime } | null>;
  linkPreview(url): Promise<LinkPreview>;
  createNote(title): Promise<{ id }>;              // "new note here" from the canvas
  createTask(title): Promise<{ id }>;
}
```

- **Web/desktop host** (`CanvasCanvas.web.tsx`): wraps `useCore()`, `useNav()`, the app's
  `DocumentSource`, and the existing `useLinkSource` search for `pickRef`.
- **Native host** (`CanvasCanvas.tsx`): the WebView side posts `{type, requestId, payload}`
  and awaits `window.__resolve(requestId, result)`; copy the `Map<requestId, resolve>` +
  timeout idiom from `packages/editor/src/webview/main.ts`. `pickRef` opens the existing
  native `LinkPicker` modal; `pickImage` uses `expo-document-picker` + `documents.ingestFile`;
  `resolveDocument` reuses `useNativeDocumentSource`.

### 3.3 Rendering and interaction (React Flow)

- `nodeTypes`/`edgeTypes` registered at module scope. Groups get `zIndex: -1` and
  `selectable` but not `connectable`.
- **Handles**: four (`top/right/bottom/left`) per non-group node, visible on hover or
  selection. `from_side/to_side` persisted from the handle ids; `NULL` side means "auto":
  `geometry.nearestSides()` picks the pair at render time.
- **Edges**: `CanvasEdge` custom edge, `markerStart/markerEnd` from `from_end/to_end`,
  double-click to edit the label, edge context menu to flip direction / toggle ends /
  recolor / delete.
- **Groups**: on `onNodeDrag` of a group, apply the same delta to every node whose bounds
  are inside the group's bounds at drag start (`geometry.contained()`); on `onNodeDragStop`
  upsert the whole moved set in one batch. `NodeResizer` when selected.
- **Sticky (`text`)**: card with the swatch color; single-click selects, double-click enters
  edit mode (contentEditable/textarea, 400 ms debounced save as `NotesProvider` does).
  Escape / click-outside exits.
- **Add nodes**: toolbar menu; double-click empty canvas → new sticky at that point; paste
  handling on the pane: URL → link node (preview fetched async), image file → image node
  via `ingestImage`, plain text → sticky. Drag-and-drop of files on web/desktop. Drop of a
  note/task from the sidebar or lists: extend `DndContext`'s `DragPayload.kind` usage with
  a `useDropTarget("canvas")` on the canvas frame that converts the drop point through
  `screenToFlowPosition` (web/desktop only).
- **Selection**: React Flow box select (`selectionOnDrag`), shift-click, `Delete`/`Backspace`
  deletes selected nodes+edges, `Cmd/Ctrl+D` duplicates, `Cmd/Ctrl+Z / Shift+Z` undo/redo,
  arrow keys nudge, `Cmd/Ctrl+0` fit view.
- **Undo/redo**: `useCanvasHistory` keeps ≤ 100 snapshots of `{nodes, edges}` diffs and
  replays them through the host as upserts/deletes (React Flow has no history built in).
- **Persistence**: positions/sizes flush on `dragStop`/`resizeEnd` as one
  `nodes.upsert` batch; edits debounce 400 ms; connections upsert immediately. `dirty` rows
  then ride the normal sync loop; call `syncTrigger()` after each write like the other
  providers.
- **Live updates**: `useCanvasDocument` subscribes via `host.onChanged`, debounces 100 ms,
  refetches `load()`, and merges: any node currently dragged, resized or in text-edit is
  in a `heldIds` set and keeps its local state until released. Everything else adopts
  the server state, so a second device's moves appear live.
- **Performance**: reuse `GraphView.web.tsx`'s gates (`onlyRenderVisibleElements`, the
  ~250-node "large" threshold). Image nodes lazy-load their URL when first visible and
  revoke object URLs on unmount.
- **Layout gotcha** (from `GraphView.web.tsx`): React Flow must sit in an absolutely
  positioned fill box; `height:100%` collapses inside RNW flex.

### 3.4 Navigation

- `nav-context.ts`: add `"canvases"` to `ViewId`; add `openCanvas(id)` to `Navigator`.
- Desktop `AppShell.tsx`: `TOOLS` entry `{ id: "canvases", label: "Canvases", icon: "canvas" }`,
  `webLinking` screens `canvases: "canvases"`, `canvas: "canvases/:id"`, `<Nav.Screen>`s;
  workspace tabs can hold a canvas (`TabRef` gains `{ type: "canvas", id }`).
- Mobile-web `mobile/MobileShell.tsx`: same three edits plus `TITLES`/`ACTIVE_VIEW`.
- Native `apps/mobile/src/MobileShell.tsx`: `Canvases` list + `Canvas: { id }` routes,
  Home section entry, project tab.
- New `IconName` `"canvas"` in `packages/design-system/src/iconPaths.ts`; `"sticky"`,
  `"group"`, `"image"`, `"arrow"` for the toolbar.
- Editor wikilinks: add `canvas` to `LINK_TYPES` in `packages/editor/src/wikilink.ts` so
  `[[canvas:<id>]]` resolves and opens via `onOpenRef`. Native `LinkPicker` `TYPES` gains
  `canvas`.
- Sidebar: canvases show under a project when added through `project_members` (same
  code path as notes); "New canvas" in the project "+" menu and in capture.

---

## 4. Node-kind specifics

### 4.1 Notes and tasks

- `NoteNode` renders `refs.notes[id].title` + excerpt, with the archetype chip/color if
  `objectTypeId` is set (reuse `useStyledGraph`'s host-side resolution: the WebView has
  no providers, so the host enriches before pushing). Double-click → `host.openRef`.
  Phase 7 upgrades this to a live ProseMirror instance (read-only, then editable).
- `TaskNode` mirrors `TaskRow` (checkbox, strike-through, due chip). Checkbox →
  `host.toggleTask`; optimistic flip, revert on error.
- Missing refs render a dashed "Deleted note" card with a remove button.

### 4.2 Calendar events

- `pickRef("event")` opens a day/agenda picker built from `calendar.range` (reuse
  `CalendarAgenda`); the chosen `CalendarItem` of kind `event` yields `SourceID`.
- `EventNode` mirrors `CalendarItemInfo` (dot, title, `formatWhen`, location). Refresh
  through `refs.events`; fallback to the cached `data_json` title when the feed dropped it.
- Open → `nav` to the calendar at that date (extend `Navigator` with `openCalendarDay(date)`
  if absent).

### 4.3 Links with previews

- `core/unfurl/unfurl.go` (pure, tested): parse `<title>`, `og:title/description/image/
  site_name`, `twitter:*` fallbacks, `<link rel="icon">`, resolve relative URLs, cap at
  2 MB and `text/html` only. Uses `golang.org/x/net/html` (check `core/go.mod`; otherwise
  the regex approach in `core/llm/tools_web.go`).
- Fetch split, same as `fetchICS`:
  - `core/bridge/unfurlfetch_native.go` (`!js`): direct GET with a browser-like UA, 15 s
    timeout.
  - `core/bridge/unfurlfetch_js.go` (`js`): `POST /v1/proxy/fetch {url}` on the sync
    server. Generalize `handleCalendarProxy`: shared `guardProxyURL` (SSRF), configurable
    accept header and byte cap, no logging of the URL or body.
- `canvases.linkPreview` returns the `LinkPreview`; the view writes it into the node's
  `data_json` (encrypted at rest and in transit). Re-fetch on demand only (a "refresh
  preview" action), never automatically.
- `LinkNode` hot-links `imageUrl` in an `<img>`. Note the privacy trade-off: rendering
  fetches the third-party image from the viewer's device. Later option: cache the image
  into a document blob at preview time.

### 4.4 Images

- Storage is the existing document/blob pipeline: `ref_type = "document"`.
- Web/desktop: paste or drop → `host.ingestImage(file)` → `documentSource.ingest` →
  `documents.create`; picker via the same `<input type=file>` trick the editor uses.
- Mobile: `host.pickImage` → `expo-document-picker` (images filter) → `documents.ingestFile`.
- Rendering: `host.resolveDocument(id)` → object URL (web), data URL (desktop/native).
  Initial node size from the image's natural aspect ratio, capped to 480 px wide;
  `NodeResizer keepAspectRatio`.
- Image documents get the `canvas` authored edge, so they show in the graph and are
  protected from blob GC while referenced.

### 4.5 Sticky notes and groups

- Palette: hoist the triplicated swatch list (`GraphView.web.tsx`, `ObjectTypeSettings.tsx`,
  `CalendarSettings.tsx`) into `design-system/tokens.ts` as `swatches` and reuse it for
  sticky/group/edge colors. Sticky background = swatch at ~18 % alpha, border at full.
- Group label is editable inline in its top-left corner; groups can be nested visually
  (containment computed by area, smallest containing group wins for drag).

---

## 5. Mobile specifics

- `scripts/build-canvas.mjs` clones `build-graph.mjs` with entry `webview/canvas-main.tsx`
  and output `canvasBundle.generated.ts`; `npm run build:canvas -w @companion/app`.
  Bundle stays separate from the graph bundle so each WebView loads only what it needs.
- `CanvasCanvas.tsx` hosts the WebView (`scrollEnabled={false}`, viewport meta
  `user-scalable=no`, React Flow `zoomOnPinch panOnDrag`), builds HTML once, and implements
  the RPC host (3.2). Selection/drag on touch works out of the box; connecting edges on
  touch uses `connectOnClick` (tap a handle, tap a target).
- Native chrome around the WebView: a bottom toolbar (add sticky/group/note/task/event/
  image/link, undo/redo, fit) that posts commands into the WebView (`window.__command`),
  so buttons are real RN controls and don't fight the canvas gestures.
- Keyboard: text editing inside the WebView uses the WebView keyboard; the height message
  pattern from the editor isn't needed because the canvas is full-screen.
- Mobile-web (narrow browsers) uses `CanvasCanvas.web.tsx` directly; the same touch
  settings apply.

---

## 6. Phases

Each phase ends green on `make test` and `npm run typecheck` in every workspace.

### Phase 1 — Core, sync, server (no UI)
- `core/domain/canvas.go` + tests; migration `0015_canvases.sql`; `core/store/canvases.go`
  (repos for all three tables, `SyncableRepo` impls, trash ops, view persistence); `store.go`
  wiring; `protocol.go` entity tags; `sync.go` registration; `rows.go` + `reencrypt.go`;
  `links.go` authored edge + `Rebuild`; `graph_nodes` view.
- `core/bridge/canvases.go` with all methods except `linkPreview`; `bridge.go` cases;
  trash branches.
- Server tables, handlers, trash cascade, `canvas_sync_test.go`.
- `packages/core-bridge/src/canvases.ts` + types + exports.

### Phase 2 — Web/desktop canvas: stickies, groups, edges
- `CanvasHost`, `CanvasView.web.tsx`, `TextNode`, `GroupNode`, `CanvasEdge`, `geometry.ts`,
  `useCanvasDocument`, `useCanvasHistory`, `CanvasToolbar`, `CanvasCanvas.web.tsx`,
  `CanvasScreen` (list + open), navigation edits, icons, swatch hoist.
- Persistence, live updates, undo/redo, keyboard shortcuts, viewport persistence, trash.

### Phase 3 — Embedded notes, tasks, events
- `pickRef` pickers (search modal over `graph.search`; agenda picker for events),
  `NoteNode`, `TaskNode`, `EventNode`, host-side archetype enrichment, missing states,
  drop from sidebar/lists via `DndContext`, "create note/task here" actions,
  `[[canvas:]]` wikilinks, project membership + sidebar.

### Phase 4 — Images and links
- Image ingest/pick/resolve, `ImageNode`; `core/unfurl` + fetch split + `/v1/proxy/fetch`
  + `LinkNode`; paste/drop routing (URL / image / text).

### Phase 5 — Mobile
- `build-canvas.mjs`, `canvas-main.tsx`, `CanvasCanvas.tsx` RPC host, native pickers,
  native toolbar, `MobileShell` routes, mobile-web routes; touch tuning.

### Phase 6 — Polish and hardening
- Minimap, snap-to-grid toggle, alignment guides, multi-select color/z-order actions,
  edge auto-sides, LOD for large canvases, empty states, canvas rename inline, search
  index (`canvases.name` and sticky text in `LIKE` search), keyboard help.

### Phase 7 — Stretch
- Live ProseMirror inside `NoteNode` (read-only first; editable keyed by note id, never
  re-injecting markdown — see `NoteEditorScreen.tsx` warning).
- JSON Canvas export/import (`canvases.export`, Obsidian `.canvas` files in the vault
  importer).
- Cache `og:image` into a document blob at preview time.
- Export canvas as PNG (web/desktop via `html-to-image` on the React Flow viewport).

---

## 7. Testing

- **Go** (where the repo's test culture lives): domain validation; store CRUD/trash/
  authored-edge mirroring/`Rebuild`; sync convergence (different-node merge, same-node
  last-writer, cascade on purge, encryption round-trip via `core/sync/encryption_test.go`
  pattern); `unfurl` parser fixtures (og-only, twitter-only, relative image URLs, no
  metadata, oversized body); proxy SSRF guard.
- **TypeScript**: `tsc --noEmit` in every workspace. `geometry.ts` is pure; if the team
  wants the first JS tests, vitest on that file is a cheap start (no JS tests exist today).
- **Manual matrix**: web (Vite), desktop (Wails), iOS/Android simulators; two devices
  syncing the same canvas; E2EE on/off; offline edit then reconnect.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| React Flow DOM cost on big canvases / mobile WebView | Reuse `GraphView` LOD gates; lazy image loading; cap nodes per canvas softly (warn > 500). |
| Lost writes when two devices edit the same sticky | Accept last-writer per row; document it. Phase 6 can add a merge for `text` via a three-way diff if it turns out to matter. |
| Third-party image hot-linking leaks viewer IP | Documented; Phase 7 blob caching. Never proxy previews through the server *at rest*. |
| WebView bundle growth (React Flow + node UIs, later ProseMirror) | Separate canvas bundle; measure size in CI (`build-canvas.mjs` prints kB); code-split ProseMirror only when Phase 7 lands. |
| Touch edge creation is fiddly | `connectOnClick` + larger handle hit areas on touch; "connect selected" toolbar action as a fallback. |
| `calendar_events` rows disappear when feeds re-expand | Cached label in `data_json`; node shows stale badge with "re-pick" action. |
| Project deletion / trash semantics for canvases | Canvases follow notes' trash rules; project deletion only removes memberships (existing behavior). |
