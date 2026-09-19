# Drawing on notes — Implementation Plan

Freehand ink anywhere on a note, including over its text: a pen that draws above the words,
a highlighter that paints beneath them, and an eraser. Synced, end-to-end encrypted, and
the same on web, desktop (Wails) and mobile (Expo).

This follows `PLAN.md`: business logic in the Go core, one JSON-over-`invoke` API, row-level
sync, and the shared editor (`packages/editor`) that runs as DOM on web/desktop and inside a
WebView on mobile.

---

## 0. Decisions up front

| Decision | Choice | Why |
|---|---|---|
| Where ink lives on screen | **Two SVG layers inside the editor's own DOM** (`packages/editor/src/ink`), highlighter under the text, pen over it | The editor is DOM on every platform, so one implementation covers all three. It must sit inside the editor: the native WebView scrolls itself, so a React Native overlay couldn't track it. |
| What ink is attached to | **The text under it** (a text anchor), not page coordinates | The note reflows (720px desktop column, ~335px phone) and is edited above the ink. Page coordinates drift off their words at once; a fixed-width page would make notes paper. |
| Unit of anchoring and sync | **Ink groups**: strokes drawn in quick succession near each other, or on top of an existing group | A handwritten word must never split across lines on another device, so its strokes share one anchor. |
| Anchor format | The text before and after the point (24 chars each) + an offset hint, re-found by exact then partial matching | Survives edits made anywhere (another device, the AI, an import) with no markers in the markdown. While the note is open, ProseMirror position mapping keeps it exact. |
| Ink in empty space | **`free` anchors**: follow their line's height, keep their place across the column, stay put when text is typed at their point | A drawing below the text or in a margin shouldn't slide sideways as you type next to it. |
| Storage | **A synced `note_ink` entity**, one row per group, keyed by `note_id` | `content_md` is saved whole on every edit, forks or prompts on conflicts, remounts the open editor on remote edits, is re-parsed for links, and is shipped in full by `notes.list`. Ink in it would hurt all of that. |
| Conflicts | Last writer wins per group, no conflicted copies (`MeaningfulDiff = false`) | Same as canvas nodes. Two devices drawing different groups merge; the same group edited on both keeps the newer. |
| Encryption | The whole payload (`data`) is encrypted; only ids, `note_id` and timestamps are plaintext | Strokes are handwriting and the anchor quotes the note's text. |
| Not document blobs | — | Blobs are immutable (every edit would orphan one) and their bytes are not end-to-end encrypted today. |
| Stroke rendering | `perfect-freehand` 1.2.3 (MIT, no deps) → filled SVG paths; colours are theme roles (CSS vars) | Pressure-sensitive strokes; ink follows dark mode. A `<canvas>` can't read CSS variables. |
| Input | Explicit drawing mode on every platform; while on, the editor isn't editable and the ink layer takes all pointer input | A mouse drag otherwise selects text. Non-editable also stops iPadOS Scribble from turning Pencil strokes into text. |

---

## 1. Data model

### 1.1 Client SQLite — `core/store/migrations/0025_note_ink.sql`

```sql
CREATE TABLE note_ink (
  id TEXT PRIMARY KEY,               -- chosen by the editor (a UUID)
  note_id TEXT NOT NULL,             -- plaintext parent
  data_json TEXT NOT NULL DEFAULT '{}',  -- {v, anchor, strokes}; ENCRYPTED on the wire
  created_at, updated_at, deleted_at, version, dirty
);
CREATE INDEX idx_note_ink_note ON note_ink (note_id);
```

`0022` was never used on `main`; this skips to `0025` to stay clear of numbers other
branches or dev databases may hold.

### 1.2 Payload (owned by the editor, opaque to the core)

```ts
interface InkGroupData {
  v: 1;
  anchor: { before: string; after: string; offset: number; free?: boolean };
  strokes: {
    id: string;                      // stable, so undo finds a stroke after reloads
    tool: "pen" | "highlighter";
    color: "ink" | "red" | "orange" | "yellow" | "green" | "blue";  // theme roles
    width: number;                   // CSS px
    sim?: boolean;                   // pressure simulated from speed (mouse, finger)
    points: number[];                // [x, y, p] triples, delta-encoded ints: 0.1px, percent
  }[];
}
```

Points are relative to the group's anchor point. Row size is capped at 128 KiB
(`domain.MaxNoteInkData`); the editor starts a new group at ~96 KiB.

### 1.3 Core and server

- Domain `core/domain/noteink.go`, repo `core/store/noteink.go` (mirrors `CanvasNodesRepo`),
  protocol entity `note_ink`, encrypted field `data`, `reencryptTables`, sync registration
  after notes.
- Server: `note_ink` table and handler (`packages/syncserver/noteink_entities.go`). The
  trash collector now tombstones a purged note's ink (`purgeChildren`, generalised from the
  canvas cascade).

## 2. Core API

| Method | Payload → Result |
|---|---|
| `noteInk.list` | `{noteId}` → `NoteInk[]` (drawing order) |
| `noteInk.upsert` | `{noteId, groups: [{id, data}]}` → `NoteInk[]` (note must be live; a tombstoned id comes back, which is how an undone erase is restored) |
| `noteInk.delete` | `{noteId, ids}` → `{count}` |

Writes emit `noteInk.changed {noteId}` and deliberately skip `data.changed` (nothing else
shows ink). Pulled ink arrives with the bulk `data.changed` every sync emits. Trashing a
note keeps its ink; "Delete forever" and the server's retention sweep tombstone it.

## 3. Editor

`packages/editor/src/ink/`: `types.ts` (payload + tools), `stroke.ts` (codec, outlines,
geometry), `anchor.ts` (text index, snapshot, resolve), `layer.ts` (the layer).

- `createEditor({ ink })` builds an `InkLayer`; `EditorHandle` gains `setInkGroups`,
  `setInkTool`, `inkUndo`, `inkRedo`.
- `EditorProps.ink = { groups, tool, onSave, onDelete, onStateChange, onExitRequest }`.
  The host owns persistence; the editor reports whole groups.
- Native: the WebView posts `inkSave` / `inkDelete` / `inkState` / `inkExit`; the host
  injects `__inkSetGroups`, `__inkSetTool`, `__inkUndo`, `__inkRedo` after `ready`.
  Native writes each stroke immediately (a WebView can be torn down right after one).
- Layout: each group is placed at its anchor (`coordsAtPos`) on every edit, resize, font load
  and visibility change. A group wider than the layers is scaled down; one sticking out
  (drawn on a wider screen) is nudged back in.
- The layers reach a gutter past the text column (`--pm-ink-gutter`: 12px on web/desktop;
  8px *inside* the native `.pm-wrap`, whose own padding is the margin), so the margins are
  drawable. Layer coordinates start at the layers' top-left; free ink is placed from the
  text column's left edge, so it lines up the same on every platform.
- While drawing, the drawable area is highlighted: tinted (`accentSoft`) behind the text and
  ringed with a dashed `borderFocus` outline, reaching down into the room left to draw in.
- Anchors are re-pinned 1.5s after nearby text is edited. Anchors whose text is deleted
  outright (a selection spanning them) are **orphaned**, not re-pinned: they stay where the
  text was and snap back if it returns (undo, a late sync).
- Undo/redo is ink-only and separate from text history; in drawing mode ⌘Z / ⇧⌘Z / ⌘Y act on
  ink and Esc leaves drawing mode.
- Touch: one finger draws until a pen is used, then only the pen draws; two fingers (or one,
  after a pen) scroll; a resting palm never scrolls under a live pen stroke. `touchmove` is
  cancelled on the layer (the known iPadOS Scribble workaround).

## 4. App

- `useNoteInk(noteId, ensureNoteId?)` loads, follows and writes a note's ink.
- `DrawingBar` + `useDrawingTool` (tool, per-tool colour/size, undo/redo, Done) replaces the
  formatting bar while drawing.
- Pen toggles: note sub-toolbar (desktop/web), Today sub-toolbar, mobile-web nav bar and
  Today actions, native note header and Today actions.
- A daily note with no note yet is created by its first stroke, like its first keystroke.

## 5. Status (2026-09-19)

Built on `feat/note-drawing`, uncommitted.

| Area | State | Verified |
|---|---|---|
| Entity, migration, repo, sync, encryption, re-encrypt | done | Go tests (store, bridge, server: two-device merge, ciphertext on server, LWW, purge cascade) |
| Editor ink layer (pen, highlighter, eraser, undo/redo, grouping) | done | web: drawing, erase/undo/redo round-trip through the store |
| Anchoring (text + free, re-pin, orphans) | done | scratch unit tests; web: edits above ink, reflow (desktop column, the column narrowed by the side panel, a 375px phone), reload, select-all + delete + undo |
| Web/desktop UI (toggles, drawing bar, Esc) | done | web preview; desktop frontend typechecks and builds |
| Mobile web (touch bar, one/two-finger) | done | web preview at 375px with synthetic touch |
| Native bridge + screens | done, **not run on a device** | WebView bundle exercised in a browser iframe with a fake bridge; `apps/mobile` typechecks (apart from a pre-existing missing `expo-notifications`) |

Also fixed along the way: the editors' `clearSignal` effect wiped the open note on a Fast
Refresh (a "skip first run" flag; now compares with the last value).

## 6. Open questions

1. Apple Pencil: it draws only in drawing mode today. Should a Pencil start drawing without
   the toggle (GoodNotes-style)?
2. Scope: task notes (simple editor) and canvases have no ink yet.
3. Titles can't be drawn over (the title field sits outside the editor).
4. "Save as new note" from the conflict dialog doesn't copy ink.
5. Native editor has no dark mode, so ink there is always light-theme.
6. Nothing yet shows that a note has a drawing in lists, previews, or the AI's `get_note`.
