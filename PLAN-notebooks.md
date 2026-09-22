# Notebooks: scope and spike

Branch `feat/notebooks`, 2026-09-21. Nothing is committed. Started as a spike; on "do the
whole thing" it was built through every layer: core, sync, sync server, TS bridge, ink layer,
desktop shell, mobile web shell, native app, command palette and Trash (§10 has the status).

**Decided by Chris, 2026-09-21:** notebook pages are their own thing, separate from notes, and
never show under Notes or open in the note editor. Ink is anchored to the page. Phones get the
scrolling list. In notebooks the Apple Pencil always draws. Pages are A5. Pages are searchable
by their text. A conflicted page becomes the next page.

## 1. What it is

A new top-level tool. A notebook is an ordered run of pages shown as paper: a fixed-size sheet
with a ruling, typed text and ink on the same surface. Pages are written like notes (the same
editor, markdown underneath) but they are not notes.

- **Shelf.** No split view. Notebooks appear as journals with their covers: one per row on a
  phone, two or three across on wider windows.
- **Covers.** A solid colour by default, or an uploaded image.
- **Pages.** Each page is blank, lined, grid or dots, with a rule pitch. A new page takes the
  paper of the page you are on.
- **Editor.** Full width, a back button to the shelf, pages two-up or as a vertical list, and a
  bottom toolbar for typing, inking, zoom and page navigation.
- **Rulers and guides.** Toggle rulers; drag guides out of them.

## 2. Try it

```bash
npm run dev -w @companion/web -- --port 5418 --strictPort
```

Open `http://localhost:5418/notebooks` (launch config `web-notebooks`); `?shell=mobile` for the
phone shell. Notebooks is in the rail and on the mobile home. The spike's stand-alone page and
localStorage host are gone.

| File | What |
|---|---|
| `packages/app/src/notebooks/paper.ts` | Page geometry (A5), rulings, baseline-grid CSS, cover colours |
| `packages/app/src/notebooks/host.ts`, `viewTypes.ts` | `NotebookHost` and the page view's contract (JSON only, WebView-ready) |
| `packages/app/src/notebooks/useNotebookHost.ts` | The host over `notebooks.*`, with the 3 s ink write debounce and held-ink overlay |
| `packages/app/src/notebooks/NotebooksProvider.tsx` | The shelf store (list, create, update, trash, reorder) |
| `packages/app/src/notebooks/NotebookView.web.tsx` | DOM page view: sheets, zoom, spread/scroll, virtualization, rulers, guides, host-routed undo |
| `packages/app/src/notebooks/NotebookView.tsx` | Native: the same view in a WebView over postMessage (`notebookBundle.generated.ts`, `scripts/build-notebook.mjs`, `webview/notebook-main.tsx`) |
| `packages/app/src/notebooks/NotebookEditor.tsx` | The editor chrome: top bar, bottom toolbar (pointer and touch layouts), paper popover, delete page |
| `packages/app/src/notebooks/NotebookShelf.tsx`, `CoverDialog.tsx` | Cover art, the responsive shelf, title/colour/image dialog |
| `packages/app/src/notebooks/NotebooksScreen.tsx` | Desktop: shelf ⇄ editor; `/notebooks/:id[@page]` |
| `packages/app/src/mobile/NotebookScreens.tsx` | Mobile web shell routes `notebooks`, `notebooks/:id` |
| `apps/mobile/src/screens/Notebook{sList,}Screen.tsx` | Native app routes `Notebooks`, `Notebook` |
| `packages/editor/src/ink/*` | Ink page mode, pen tool, host-routed keys, pinch hook (all opt-in) |

## 3. The page model

**A page is its own entity laid on a fixed-size sheet.** It holds markdown text and ink, is
edited with the same editor as a note, and exists only inside its notebook: it is not in the
Notes list, not in Unsorted, and never opens in the note editor. The sheet is **A5**: 559 x 794
logical px (148 x 210 mm at 96 dpi), so 100% zoom is life size on a screen and PDF export maps
1:1. Margins are 40 px sides and 48 px head and foot, leaving a 479 px text column. It is zoomed
with a CSS transform and never reflows to the window. Two pages fit at 93% in a 1400 px window.

Why fixed: ink drawn on a phone lands in the same place on a desktop, guides and rulers mean
something, and two-up layout is just two boxes.

**Ink is fixed to the page.** A stroke is stored in page coordinates and nothing typed on the
page moves it. This is only sound because a page never reflows: there is no other width or
editor for the ink to be wrong in. Typed text still flows; ink does not follow it.

**Overflow.** A page has a minimum height. When its text runs past the bottom margin the sheet
grows by whole rules, and it never shrinks above its lowest ink. There is no pagination engine
and a page never splits. Rejected: hard pagination and scrolling inside a fixed sheet.

**Text sits on the rules.** On a page the editor's line height is the rule pitch, block margins
are zero or one whole rule, and larger type is lifted so every baseline rests the same distance
above its rule. Pitches: 24, 28, 32 px with 14, 15, 16 px body type.

**Pencil.** In a notebook a stylus always draws, with the last drawing tool, whether or not
drawing mode is on. Fingers and the mouse type, tap and scroll. Drawing mode still exists for
drawing with a finger or mouse. Note ink keeps its current rule (pencil draws only in drawing
mode).

**Phones.** Scrolling list only, zoomed so the text column fills the screen (73% on a 375 px
phone, so 15 px type shows at 11 px); the side margins scroll off either edge. No two-up under
900 px.

**Search.** Pages are found by their text. Two surfaces:
- The command palette gets a "Pages" section from a new `notebooks.searchPages` core method
  (LIKE over `content_md`, like `SearchRepo`; returns notebook id, page index, a snippet).
  Rows read "<Notebook> · p. 12" with the snippet, and open the notebook at that page. Unlike
  the palette's other sections, which filter titles already in memory, this one asks the core
  per keystroke (debounced) because it searches bodies.
- `SearchRepo.Search` gains a third table so the AI's `search_notes` finds pages; hits carry a
  new node type and `get_page(id)` reads the full text. `[[` autocomplete stays title-based and
  cannot offer pages (they have no title); links to pages are not in v1.

## 4. Data model (built 2026-09-21, uncommitted)

Migration **0031** (0005, 0006, 0022, 0028 are gaps; never reuse 0028). Every layer below is
in place and tested: `core/domain/notebook.go`, `core/store/notebooks.go`,
`core/bridge/notebooks.go`, sync registration, protected fields, re-encryption list, the sync
server (`packages/syncserver/notebook_entities.go`, schema, registry, purge cascade), the TS
API (`packages/core-bridge/src/notebooks.ts`, on `CoreContext` as `notebooks`), and the AI's
`search_notes` / `get_page`. The web wasm was rebuilt and the flow driven end to end in the
browser. The migration has run on the dev DB, so it now has 0031 (see the dev-DB gotcha in
memory if the schema changes before release).

```sql
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',            -- E2EE
  cover_color TEXT NOT NULL DEFAULT 'ink',
  cover_document_id TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',  -- E2EE: guides
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at, updated_at, deleting_at, deleted_at, version, dirty
);
CREATE TABLE notebook_pages (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  paper_kind TEXT NOT NULL DEFAULT 'lined',
  paper_spacing INTEGER NOT NULL DEFAULT 28,
  content_md TEXT NOT NULL DEFAULT '',       -- E2EE
  created_at, updated_at, deleted_at, version, dirty
);
CREATE TABLE notebook_page_ink (             -- the note_ink shape, keyed to a page
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  data_json TEXT NOT NULL,                   -- E2EE; same payload format, anchor {page:true}
  created_at, updated_at, deleted_at, version, dirty
);
```

As built, `notebook_page_ink` also carries `notebook_id`, so a purged notebook takes its ink in
one `purgeChildren` pass on the server (and one `DeleteForNotebook` on the client). `notebooks`
carries `settings_json` (guides) and `sort_order` for the shelf.

Bridge methods: `notebooks.{list,get,create,update,reorder,delete}`,
`notebooks.pages.{add,get,update,reorder,delete,search}`, `notebooks.ink.{list,upsert,delete}`.
Events: `notebooks.changed {notebookId}` for book and page structure, `data.changed` only for
a text save, `notebooks.ink.changed {pageId}` for ink. `notebooks.create` makes the first page;
`pages.delete` refuses the last one; `pages.add` shifts later pages down and marks them dirty.

- **Nothing touches `notes` or `project_members`.** Pages being separate removes the whole
  class of problems the first draft had: no Notes list or Unsorted filtering, no
  `EnforceSingleContainer` hazard, no double listing in export, graph or the AI tools. The cost
  is that pages are invisible to those surfaces until each is taught about them (see §7).
- **A new ink table rather than reusing `note_ink`.** `note_ink.note_id` is a plaintext FK that
  the server's purge cascade keys on; a second owner type would complicate both. The payload
  format and the 128 KiB row cap carry over unchanged.
- **Page text conflicts** (decided). Notes fork a conflicted copy on a meaningful diff
  (`MeaningfulDiff` / `ConflictedCopy`). A conflicted page's copy is inserted as the next page
  with the same paper, its first line marked "Conflicted copy from <device>, <date>". Ink stays
  with the original page. `ConflictedCopy` for pages must bump the following pages'
  `sort_order`, which the note version never has to do.
- **Ordering** follows the house convention: dense integer `sort_order`, full rewrite on
  reorder or mid-notebook insert, read as `ORDER BY sort_order, created_at, id`. Concurrent
  reorders are last-writer-wins per row, as lists already are.
- **Trash.** Notebooks get `deleting_at` and a `trash.go` case. Pages and ink follow their
  notebook and tombstone directly, the way canvas nodes follow their board, so a deleted page
  is gone (behind a confirm); only whole notebooks can be restored.
- **Checklist** (from the `note_ink` and canvases additions): migration, domain structs with
  the five `SyncEntity` methods, store repos plus `store.go` wiring, the `bridge.go` switch
  (`notebooks.*`, `notebooks.pages.*`, `notebooks.ink.*`), `protocol.go` tags, `sync.go`
  registration (notebook, then pages, then ink), `crypto/rows.go` protected fields,
  **`reencrypt.go` table list**, syncserver schema const plus handlers plus registry plus
  `trashTables` and the purge cascade plus the test TRUNCATE list, `core-bridge` API and types,
  `CoreContext`.

## 5. Architecture

- **Renderer behind a host.** `NotebookView` imports nothing from the provider tree and talks to
  a `NotebookHost` whose arguments and results are all JSON. Web and desktop wrap the core
  APIs; native runs the same component in a WebView over postMessage, built as a third bundle
  beside the canvas and graph bundles. One WebView holds the whole notebook, not one per page.
- **Toolbar outside the renderer**, in React Native, driving it through a controller. The spike
  stacks the existing `FormattingBar` / `DrawingBar` over a notebook row; the real one merges
  them.
- **Shell.** `notebooks` is a surface view in `VIEW_SCREENS` (full bleed, like Graph), not a
  `WorkspaceSection`. The open notebook rides in the view's `section` (the URL
  `/notebooks/:id`, or `/notebooks/:id@N` to land on page N from a search hit), the way a
  Settings section does; mobile routes are `notebooks` and `notebooks/:id`. `TOOLS` has the
  entry and `notebook` is a new icon.
- **Per-page plumbing.** `useNotebookHost` carries the 3 s ink write debounce and the held-ink
  overlay from `useNoteInk` (the `MarkPushed` race applies to pages too). There is no
  per-page sync guard or conflict dialog: page text conflicts resolve as a next page (§4), and
  a synced change re-reads the notebook (`notebooks.changed` / `data.changed`), remounting
  nothing; ProseMirror keeps local unsaved edits since the editor owns its content.
- **Covers** reuse the project overview pattern (`useCoverUrl`, `pickCoverImage` in
  `ContainerOverview.tsx`); lift those out to share.

## 6. Spike findings

Measured in Chromium in the browser pane. Nothing here was run in WebKit, which is what the
desktop app (Wails) and the iOS WebView use.

| # | Finding | Status |
|---|---|---|
| F1 | **Zoom by CSS transform works with the editor and ink as they are.** At 64% a synthetic stroke landed within 1 px of the pointer. At 150% browser hit-testing returned the exact character offsets and a real click then typing put the caret where expected. | Confirmed |
| F2 | **Two visible pages both answered the keyboard.** Each ink layer listens on `window`; one cmd-Z undid a stroke on both pages of a spread. | Fixed: `ink.keyboard: false`, the view routes undo/redo/Escape to the current page. Re-tested: only the active page undoes |
| F3 | **Ink was pinned to text.** Two lines inserted above some handwriting moved it down 56 page px. | Fixed: page mode stores `anchor: {page: true}` in sheet coordinates. Re-tested: 0 px movement, identical coordinates after reload |
| F4 | **The ink layer overshot the sheet** (1045 px layer on a 736 px sheet) and ink could end up below the sheet's bottom. | Fixed: in page mode the sheet sizes the layers (736 = 736) and the layer reports its lowest ink. Re-tested: a sheet grown to 1322 px by text fell back to 1226 px, not 1154, when the text was deleted, because ink sat at 1181 |
| F5 | **A scrolling list virtualizes cleanly.** 24 pages, 2 to 3 live editors; off-screen pages are blank sheets of the remembered height. | Confirmed |
| F6 | **A fixed page is small on a phone.** Whole-sheet fit on 375 px is 38% (type near 6 px). | Mitigated: phones fit the text column, 50% (type near 7.5 px). Still a zoom-and-pan surface, as GoodNotes is on a phone |
| F7 | **1 px rules vanish when zoomed out.** | Fixed: rule thickness is a device hairline (`1 / scale`, capped) |
| F8 | **Rulers and guides work as specified.** Dragged guides out of both rulers, moved one, dropped one on the ruler to delete it; they persist and show on every page. Ruler labels rescale with zoom. | Confirmed |
| F9 | **No pinch zoom while drawing.** In drawing mode the ink layer owned touches (two fingers pan, nothing zooms). | Fixed: `ink.onPinch` reports the two-finger factor; the view zooms. Re-tested with synthetic touches: 1.06 → 2.66 for a 2.5× spread, no stroke drawn. Wheel zoom still isn't anchored under the pointer |
| F10 | **Paper follows the theme.** Dark mode gives a dark sheet with light rules and ink. Required while the `ink` colour is the theme's text colour. | Confirmed |
| F11 | **New pages inherit paper; shelf columns respond** (1 under 640 px, 2 under 1100, else 3). | Confirmed |
| F12 | The bottom toolbar overflowed at phone width. | Fixed: on touch the mode switch is pinned and the rest scrolls sideways |
| F13 | **Pencil always draws.** With drawing mode off, a synthetic `pointerType: "pen"` drag over the text drew a stroke and left the text editable; the same drag as a mouse drew nothing. Caught on the ink host in the capture phase, before ProseMirror. | Confirmed with synthetic events only |
| F14 | **Hidden pages deliver no resize observations** (same family as the hidden-pane animation-frame gotcha). The sheet also re-measures on every reported edit. | Fixed |

Ink layer changes are opt-in (`page`, `keyboard`, `penTool`). Re-checked in the real web app:
a note's ink is still text-anchored with no `page` flag, the layer's own cmd-Z works, and draw
space below the text is intact.

Verified in the real app (web, Chromium): rail entry, shelf, create + cover dialog, open at
`/notebooks/:id`, typing, pen ink in Type mode persisted through the core with a page anchor,
add page inheriting paper, palette "Pages" hit opening the notebook on page 1 (`…@1`), the
mobile web shell (shelf, pushed editor at 73%), dark mode, Trash list/restore/purge.

Not tested: **anything on a real Apple Pencil**, including the iPadOS Scribble guard (stylus
touches are cancelled so Scribble does not turn strokes into typing; written from the existing
drawing-mode guard, never run); WebKit text sharpness and caret under transform; the native
WebView bundle, where `penTool`, `page` and `keyboard` are not yet passed through
(`webview/main.ts`, `Editor.tsx`, though notebooks don't need them: the native notebook
WebView embeds the DOM editor directly); **the native app at all** (the bundle builds and the
screens typecheck, nothing was run on a simulator); tables, images, task items and embeds on the baseline grid
(they will break it; heights could be snapped to whole rules); ink-heavy pages in a long list.

## 7. Decisions

Settled (2026-09-21): pages are separate from notes; ink is page-anchored; phones get the
scrolling list; the pencil always draws in notebooks only; A5 pages; pages are searchable by
text; a conflicted page becomes the next page. Page titles are moot (pages have none).

Still open, recommendation first:

- **D1. Links from pages.** Text search is settled (§3); this is the rest. Recommended for
  v1: links written *inside* a page work as they do in a note (chips, open on click), and
  notebooks appear in the command palette by title. Backlinks *from* pages, pages in the
  graph and the `[[` menu wait; backlinks need a new link source type in the `links` index.
- **D2. Deleting a page.** Recommended: a confirm, then gone (no per-page Trash), as canvas
  nodes are. Whole notebooks go to the Trash for 30 days with everything in them.
- **D3. Guides.** I read "add guides to the notebook" as per notebook, shown on every page, and
  hidden with the rulers. Guides do not snap ink or text yet. Per-page guides are the
  alternative.
- **D4. Cover colours.** The spike uses ten muted journal colours of my own, fixed across
  themes. The alternative is the existing `swatches` tokens and `SwatchPicker`.
- **D5. Bringing a note in.** With pages separate, "collect notes into a notebook" can only
  mean copying a note's text onto a new page (its ink cannot come: that ink is text-anchored
  at another width). Recommended: leave it out of v1.

Deferred, no decision needed yet: filing a notebook in a project or area, notebooks as graph
nodes, export (v1 exports nothing from notebooks; a later format is a folder per notebook with
a page per file plus a sidecar for paper, guides and cover, and ink has no markdown form).

## 8. Known costs

- **Cover images load full size.** There is no thumbnail support anywhere; the shelf would pull
  every cover's original bytes. Downscale on ingest (about 1024 px).
- **Cover bytes are not encrypted** under E2EE, like every attachment today (known, separate
  task).
- **The native build is the big one:** a third WebView bundle, the host over postMessage, and
  wikilink autocomplete, document embeds and the table menu bridged inside it.

## 9. Build status (2026-09-21)

Done: core (§4); ink layer page mode, host-owned keys, pen tool, pinch hook; `useNotebookHost`
over the core; desktop shell (rail, `/notebooks/:id`), mobile web shell, native app screens
and WebView bundle (unrun); shelf, cover dialog (colour + uploaded image via documents),
editor chrome with touch layout; palette "Pages" section and notebooks by title; AI
`search_notes` + `get_page`; Trash.

Left: docs (help center); export (v1 exports nothing from notebooks); wheel zoom anchored
under the pointer; running the native app; the open decisions in §7.
