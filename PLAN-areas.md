# Areas & project pages — Implementation Plan

Areas and projects stop being sidebar scaffolding and become pages. Each opens on a full-width
overview — an optional cover image, an optional emoji, the name, a rich-text description, then
cards of what matters in it — with a toolbar of sections beside it. An area now holds notes,
tasks and canvases directly, and content lives in **one** place: an area, or a project.

This follows `PLAN.md` (§6.6 is the section it amends): business logic in the Go core, one
JSON-over-`invoke` API, row-level sync, shared UI in `packages/app`.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Where content lives | **One container**: a note, task, habit or canvas is filed in at most one project **or** one area — never both, never several | Asked for. "Which project is this in?" has one answer; moving is one gesture; counts and roll-ups never double-count. Calendars are not content and can still sit in several projects. |
| What an area holds directly | **Notes, tasks and canvases** — not lists, not calendars, not habits | Asked for. Lists order a *project's* tasks and calendars feed a *project's* calendar; both stay project-scoped. |
| How an area membership is stored | **The existing `project_members` row**, with a new `container_type` (`'project'` default, `'area'`). For an area row, `project_id` holds the area's id | One table makes "one live membership per entity" a single-table invariant, reuses the deterministic `MemberID`, the sync handler, the server's repeat materializer and `memberEntityIds`. A second `area_members` table would have made exclusivity a cross-table rule. The column keeps its name for wire compatibility: an older client reads an area row as a membership of a project it doesn't know, and ignores it. |
| Enforcing one container | **A move in `Add`** (tombstone the other memberships, then file) **plus `EnforceSingleContainer`** after every sync pull and at store open | Local writes can't produce two live memberships; two devices filing the same entity before they sync can. The settle rule reads only synced fields, so every device picks the same winner. |
| Which membership wins | **The one created first** (earliest `created_at`, then lowest id) | Asked for ("leave items in the first project they're assigned to"). The same rule serves the migration and later conflicts, so a device that migrated and one that pulled pre-migration rows agree. |
| Push order | Membership **tombstones push before live rows** (`Dirty()` orders them first) | The server commits a push row by row, so another device can pull mid-push. With the "leave" half of a move always ahead of its "join" half, that device sees the entity unfiled for a moment — never filed twice, which the first-wins rule would settle by undoing the move. |
| Areas in the graph | **Still not nodes**; area memberships mirror no `member` edge | PLAN §6.6. An area is an address, not an idea. |
| Page fields | `icon` (one emoji), `cover_document_id` (a `documents` row), `description_md` on both `areas` and `projects` | The cover rides the existing document/blob pipeline — no new byte path. |
| Encryption | `icon` and `descriptionMd` are protected fields; `coverDocumentId` is a plaintext foreign key, like every other | "Content is encrypted, coordination metadata is not." The cover's *bytes* follow today's document rule (see §6). |
| Description editor | **The full note editor, `inline`** — a new `EditorProps.inline` that makes the full editor hug its content | The description links objects, embeds files, has tables and every mark, exactly like a note — but sits between a title and cards, where the page editor's 40vh minimum (web) and full-screen WebView (native) don't fit. |
| Area roll-up | An area's overview cards **and its sections** show its whole tree: what is filed directly in it plus what its projects hold; rows from a project name it | Asked for ("roll up everything"). The sections roll up too so "View all" opens a list that matches the card it came from. "Unsorted" is the one direct-only view. |
| Landing page | The bare `/project/<id>` and `/area/<id>` URL **is the overview**; sections are chips beside it | Asked for. It replaces "land on the first section". The old settings page (name, area, delete) folds into the overview's foot, so the header's gear is gone. |

---

## 1. Data model

### 1.1 Client SQLite — `core/store/migrations/0026_area_project_overviews.sql`

```sql
ALTER TABLE areas    ADD COLUMN icon TEXT;
ALTER TABLE areas    ADD COLUMN cover_document_id TEXT;
ALTER TABLE areas    ADD COLUMN description_md TEXT NOT NULL DEFAULT '';
-- the same three on projects
ALTER TABLE project_members ADD COLUMN container_type TEXT NOT NULL DEFAULT 'project';
```

`domain.Area` / `domain.Project` gain `Icon *string`, `CoverDocumentID *string`,
`DescriptionMd string`. On update an empty `icon` / `coverDocumentId` clears it (nil leaves it
alone). All three count in `MeaningfulDiff`, so a description edited on two devices forks a
conflicted copy rather than silently losing one.

`domain.ProjectMember` gains `ContainerType` (`json:"containerType,omitempty"`), with
`Container()` reading an absent one as `project` and `InArea()`. `Validate` refuses an area row
for anything but a note, task or canvas.

### 1.2 Server — `packages/syncserver`

The same columns on `areas`, `projects` and `project_members` (`db.go`: `CREATE TABLE` plus the
idempotent `ALTER`s), carried through the three entity handlers. The repeat materializer files
an occurrence where its seed lives — `seedContainers` returns the container's kind with its id,
keeping only the first if an older client left several — so a repeating task in an area
generates occurrences in that area.

---

## 2. Membership

`ProjectMembersRepo` (`core/store/projectmembers.go`):

- `Add(projectID, …)` / `AddToArea(areaID, …)` and their `AddMany` forms share one `add`.
- `ListForArea(areaID)` — filed directly in the area. `ListForAreaTree(areaID)` — that plus the
  content of every live project in it.
- `Remove` works for either container (the id derives from the tuple) and, for a task leaving a
  project, takes it out of that project's lists (this moved down from the bridge so every path
  — a move, the settle function — gets it).
- `MemberEntityIDs` now means "filed somewhere": an item in an area is not Unsorted.

### 2.1 One container

`add` tombstones every other live membership of a content entity before filing it. Revived
tombstones take the new `container_type`.

`EnforceSingleContainer()` finds content entities with more than one live membership, keeps the
first-created of each and `Remove`s the rest (dirty tombstones, so they sync; edges and list
items go with them). It runs:

1. in `store.New`, after migrations — **the migration** off the many-projects model. A no-op
   once settled;
2. at the end of every caught-up sync pull (`core/sync/sync.go`) — the convergence step.

Deleting an area (still only once it has no projects) tombstones its direct memberships; the
content falls back to Unsorted, or is trashed with `deleteContent`, as for a project.

### 2.2 Bridge

`areas.addMember`, `areas.addMembers`, `areas.removeMember`, `areas.members {areaId, tree}`;
`areas.delete` takes `deleteContent`. `projects.addMember(s)` are now moves, and announce
`lists.changed` for every project a moved task left. `projects.forEntity` returns the area row
too (`containerType: "area"`). `nav.sidebar` carries `icon` on areas and projects.

---

## 3. UI

Shared, in `packages/app`:

- `ContainerOverview` — the page: cover (pick / change / remove, through the platform's
  `DocumentSource`), emoji (`EmojiPicker`: a curated grid plus "type any emoji"), the name, the
  inline description editor with the formatting bar while it has focus, then cards and a foot.
- `ContainerHome` — the cards. **Project**: recently updated tasks, upcoming tasks, recently
  updated notes, recently updated canvases. **Area**: projects, unsorted tasks (filed in the
  area, in none of its projects), upcoming tasks, notes. Ten rows each (`OVERVIEW_LIMIT`), the
  true total beside the title, "View all" into the matching section — for tasks, pre-filtered
  (`unsorted`, `upcoming`). The foot holds the project's area chips and the delete button.
- `useContainerContent(container)` — a project's members, or an area's tree, resolved to notes,
  tasks, seeds and canvases, with `projectOf` naming the project of each rolled-up item.

Navigation (`nav-context.ts`): a `{kind: "area", areaId, section?, itemId?}` tab/location,
`/area/<id>[/<section>[/<itemId>]]`, `openArea`, and `openContainer(container, section?,
itemId?)`, which the shared page uses instead of branching on the kind. `ProjectView` is that
shared page for both.

Desktop/web: the sidebar's area heading opens the area (the chevron alone folds it), is a drop
target (a dragged note or task is filed in the area), and shows the emoji; project rows show
theirs in place of the folder. The membership picker is a pick-one **Move to** list of areas and
their projects (picking the current place takes the item out); calendars keep independent
toggles. Bulk assign is **Move to…** and offers areas.

Mobile web (`packages/app/src/mobile`): `ProjectScreen` gains an Overview tab (now the default);
`AreaScreen` is Overview / Notes / Tasks / Canvases; the list screens take an `areaId`. Home's
area headings open the area.

Native (`apps/mobile`): the same through `AreaContext` beside `ProjectContext`, an `Area` route
with its own bottom tabs, and `ContainerOverviewScreen`, which hosts the shared page behind a
small `NavContext` adapter (this shell has no `Navigator` of its own).

---

## 4. Editor

`EditorProps.inline` (full variant): web drops the page min-height (`.pm-inline`); native sizes
the WebView to its reported content height, as the simple field does, and skips the keyboard
toolbar (it assumes a full-screen editor — markdown shortcuts still format). `placeholder` now
works in the full editor too. The native bundle is regenerated
(`npm run build:editor -w @companion/editor`).

---

## 5. Tests

- `core/store/area_members_test.go` — page fields round-trip and clear; an area holds content
  and nothing else, mirrors no graph edge; filing moves (and leaves lists; tombstones push
  first; revive); `EnforceSingleContainer` keeps the first and spares calendars.
- `core/bridge/projects_test.go` — area membership over the bridge, the tree, area deletion.
- `packages/syncserver/area_members_sync_test.go` — pages and area members converge; two
  devices filing one note in two projects settle on the first; a repeating task in an area
  generates occurrences in it.

---

## 6. Known gaps

- **Description links are not in the graph.** Chips render and open, but a project's
  description isn't indexed as a link source: `LinksRepo.replaceSource` would wipe the project's
  `member` edges, so it needs a kind-scoped replace first. Areas aren't nodes at all.
- **Cover bytes are not end-to-end encrypted**, like every document's bytes today (only the
  filename is). Same follow-up as attachments generally.
- **Documents embedded in a description, and replaced covers, are never trashed** — the
  document cascade only runs when a *note* is trashed.
- **Older clients** that haven't taken this update still let an item join several projects;
  the next updated client to sync settles it (first wins). An older client that edits an area
  or project also pushes the row without the page fields, clearing them — the same exposure
  every added column has had.
- **Native descriptions have no formatting toolbar** (see §4).
- The AI tools (`core/llm/tools_store.go`) list projects and their items but don't know areas
  hold content yet.
