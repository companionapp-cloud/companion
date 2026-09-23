import type { FormatName, FormatState } from "./formatCommands";
import type { TableMenuPresenter } from "./tableMenu";
import type { InkGroupRecord, InkState, InkTool } from "./ink/types";
import type { AiApplyMode, AiTarget } from "./ai";

export type { TableMenuPresenter, TableMenuRequest } from "./tableMenu";
export type { TableMenuItem } from "./tableCommands";

/** Imperative handle exposed via `ref` on the {@link Editor}, letting the host's formatting
 * toolbar drive the editor. On web it calls the DOM editor directly; on native it injects
 * the equivalent call into the WebView. */
export interface EditorController {
  format(name: FormatName): void;
  insertReference(): void;
  /** Insert a blank 2×2 GFM table at the cursor (full variant only). */
  insertTable(): void;
  /** Open the OS file picker to embed a document (PLAN §6.9). No-op unless a
   * {@link DocumentSource} is wired (and, today, web only). */
  insertDocument(): void;
  /** Complete a quick-create started from an empty `[[label]]` link (see
   * {@link EditorProps.onQuickCreate}): pass the newly created target to swap the raw text
   * for a resolved chip, or null to cancel and leave the text as-is. */
  resolveQuickCreate(target: QuickCreateTarget | null): void;
  /** Web/desktop: place a chip for `target` where a drag from the host's drag layer was
   * released (window coordinates), e.g. an agenda item dropped on the daily note. No-op on
   * native, which has no drag layer. */
  insertRefAt(target: QuickCreateTarget, x: number, y: number): void;
  /** Web/desktop: mark where {@link insertRefAt} would place a chip while a drag hovers the
   * editor; null clears the mark. No-op on native. */
  showDropCaret(point: { x: number; y: number } | null): void;
  /** Undo / redo the last drawing change (PLAN-drawing.md). No-op without {@link EditorProps.ink}. */
  inkUndo(): void;
  inkRedo(): void;
  /** Writing assists: capture what an assist acts on — the selection, or the whole note when
   *  nothing is selected. The target follows later edits and stays highlighted until released.
   *  Async because on native the answer comes back over the WebView bridge. Null in the simple
   *  variant (or if the editor is gone). */
  aiCapture(): Promise<AiTarget | null>;
  /** Put an assist's markdown result into the note for a captured target (undoable). */
  aiApply(id: number, mode: AiApplyMode, markdown: string): void;
  /** Forget a captured target and drop its highlight. */
  aiRelease(id: number): void;
}

/** Drawing over the note (PLAN-drawing.md). The host owns persistence: it loads the note's ink
 *  groups, passes them in, and stores what the editor reports. The editor pins each group to
 *  the text under it, so ink follows its words through edits and reflow. */
export interface EditorInkProps {
  /** The note's ink groups as stored. Pass a new array when they change (load, sync). */
  groups: InkGroupRecord[];
  /** The active drawing tool, or null for ordinary text editing. While a tool is active the
   *  whole document takes pointer input as ink and the text isn't editable. */
  tool: InkTool | null;
  /** Persist groups the reader drew or changed (whole groups, created or updated). */
  onSave(groups: InkGroupRecord[]): void;
  /** Persist deleted groups (erased, or undone). */
  onDelete(ids: string[]): void;
  /** Undo/redo availability, for the host's drawing toolbar. */
  onStateChange?(state: InkState): void;
  /** The reader pressed Escape while drawing: the host should leave drawing mode. */
  onExitRequest?(): void;
}

/** Fired when the reader double-clicks an unresolved `[[label]]` link. The host opens its
 * quick-create UI (make a note/task titled `label`) and answers via
 * {@link EditorController.resolveQuickCreate}. `embed` mirrors a leading `!` on the link. */
export interface QuickCreateRequest {
  label: string;
  embed: boolean;
}

/** The entity a quick-create resolved to, used to build the replacement chip. */
export interface QuickCreateTarget {
  type: LinkType;
  id: string;
  title: string;
}

// The editor's cross-platform contract. `markdown` seeds the editor once (the editor
// owns its content thereafter); `onChangeMarkdown` reports serialized markdown back,
// debounced. The editor fills its parent, so size it from the outside.
export interface EditorProps {
  markdown: string;
  onChangeMarkdown: (markdown: string) => void;
  /** Optional provider for wikilink autocomplete (`[[`) and pasted-UUID resolution.
   * Omit it and those features stay dormant (input rules + chips still work). */
  linkSource?: LinkSource;
  /** Optional provider for embedding files (PLAN §6.9): ingesting a picked/pasted/dropped
   * file into a document, and resolving an embedded document to a renderable URL. Omit and
   * document embeds render as a plain filename chip and there is no way to add one. */
  documentSource?: DocumentSource;
  /** Called when the reader opens a wikilink chip (select it, then click again). The host
   * decides how — e.g. open the target in a new workspace tab. Omit and chips only select. */
  onOpenRef?: (ref: LinkRef) => void;
  /** Web/desktop: a chip was pressed with a mouse or pen and dragged a few pixels. Return true
   * to take the drag over: the host follows the pointer from here (onto a project, or a task
   * onto the Today agenda) and the chip's click is skipped. Omit it, or return false, and
   * chips don't drag. */
  onRefDragStart?: (drag: RefDragStart) => boolean;
  /** Called when the reader double-clicks an unresolved `[[label]]` link, so the host can
   * offer to quick-create a note/task titled `label`. The host answers via the controller's
   * {@link EditorController.resolveQuickCreate}. Omit and empty links stay inert text. */
  onQuickCreate?: (req: QuickCreateRequest) => void;
  /** Change this value's identity to re-hydrate `[[task:…]]` chips against the latest task
   * data (via {@link LinkSource.lookup}). The editor otherwise hydrates a chip only when it
   * mounts, so a task edited elsewhere while the note stays open would look stale. Only
   * touches already-rendered chips; the document itself is unchanged. */
  linkRevision?: unknown;
  /** "full" is the document editor (headings, lists, task items, marks …). "simple" is a
   * plain-text-plus-references editor for task notes and the chat composer. Default "full". */
  variant?: "full" | "simple";
  /** Placeholder shown while the document is empty. */
  placeholder?: string;
  /** When set, Enter submits (calls this with the current content) instead of a newline, and
   * Shift-Enter makes a new paragraph — the chat composer's send behavior. Simple variant only. */
  onSubmit?: (markdown: string) => void;
  /** Change this value's identity to empty the editor (e.g. the chat composer after a send).
   * Skips the initial mount. */
  clearSignal?: unknown;
  /** Full variant: hug the content like an inline field instead of filling a page — the
   * description on an area's or a project's overview (PLAN-areas.md §1), which sits in a
   * scrolling page between a title and cards. Everything else about the full editor holds:
   * the schema, references, embeds, tables. `minHeight`/`maxHeight` bound it as they do the
   * simple field. On native the keyboard toolbar is skipped (it assumes a full-screen editor);
   * markdown shortcuts still format. */
  inline?: boolean;
  /** Simple variant, or `inline`. The field hugs its content; these bound how far it grows. On native
   * the WebView is sized to its content between these; on web the wrapper caps + scrolls at
   * maxHeight. Ignored by the full editor. */
  minHeight?: number;
  maxHeight?: number;
  /** How often edits are reported back (ms). Defaults to 400. The chat composer lowers it so
   * the send button reflects typing promptly. */
  debounceMs?: number;
  /** Notified after every selection/content change with the formatting-toolbar snapshot. The
   * host (web selection bar) renders its buttons from this. Full variant only. */
  onFormatStateChange?: (state: FormatState) => void;
  /** Notified when the editor gains/loses focus. The web host uses it to show its formatting
   * bar while the document is focused; native manages its own keyboard toolbar internally. */
  onFocusChange?: (focused: boolean) => void;
  /** Present the table cell menu natively instead of the built-in HTML popup. The desktop shell
   * passes the Wails-backed presenter here (injected via `setTableMenuPresenter`); web leaves it
   * undefined (HTML popup). iOS wires its own presenter inside the WebView. Full variant only. */
  tableMenuPresenter?: TableMenuPresenter;
  /** Enables drawing over the note (full variant only). Read once at mount for whether ink is
   *  on at all; `groups` and `tool` are then followed as they change. */
  ink?: EditorInkProps;
  /** Mod-j in the document: the reader asked to write with AI. Full variant only. Omit and the
   *  key does nothing (AI off). */
  onAiShortcut?: () => void;
  /** Native only: show an AI button on the keyboard toolbar that calls this (the host opens its
   *  assist menu). Web hosts put the button in their own formatting bar. */
  onAiToolbarPress?: () => void;
}

/** A reference to open — the payload of {@link EditorProps.onOpenRef}. */
export interface LinkRef {
  type: LinkType;
  id: string;
}

/** A chip being dragged out of the editor — the payload of {@link EditorProps.onRefDragStart}. */
export interface RefDragStart {
  ref: LinkRef;
  /** The chip's label: its alias, else its id. */
  label: string;
  /** Where the pointer is now, in window coordinates. */
  x: number;
  y: number;
}

/** A link target the editor can offer or resolve — a slim projection, never a body. */
export interface LinkSuggestion {
  type: "note" | "task" | "habit" | "project" | "document" | "canvas";
  id: string;
  title: string;
  /** Task-only extras, so a `[[task:…]]` chip can render like a todo (done state, deadline,
   * reminders). Left undefined for other types (and for hosts that don't supply them). */
  status?: string | null;
  dueAt?: string | null;
  /** Each an absolute instant (`at`) or a lead before the deadline (`before`, ISO-8601). */
  reminders?: { at?: string; before?: string }[] | null;
}

/** The entity types the `[[` menu can scope its search to. */
export type LinkType = "note" | "task" | "habit" | "project" | "document" | "canvas";

/** How the editor reaches the host's object graph. Both calls are async so the native
 * WebView can satisfy them over the postMessage bridge. */
export interface LinkSource {
  /** Title search for the `[[` autocomplete menu. `type` scopes to one entity type;
   * omit (or pass "all") to search across all of them. */
  search(query: string, type?: LinkType | "all"): Promise<LinkSuggestion[]>;
  /** Resolve one id (any type) to its target, for turning a pasted UUID into a link. */
  lookup(id: string): Promise<LinkSuggestion | null>;
}

/** An embedded document resolved to something renderable (PLAN §6.9). `url` is a URL the
 * editor can put in an <img>/<audio> src or a download link; the host owns its lifetime
 * (e.g. an object URL it revokes). */
export interface ResolvedDocument {
  url: string;
  mime: string;
  filename: string;
}

/** How the editor reaches the host's document store to embed and render files (PLAN §6.9).
 * Both calls are async so the native WebView could satisfy them over postMessage; today
 * only the web shell wires it. Raw bytes never cross this seam — the host stages/serves
 * them and hands back a URL. */
export interface DocumentSource {
  /** Resolve an embedded document to a renderable URL (downloading its bytes lazily on
   * first view), or null when unavailable. The editor revokes object URLs it's given. */
  resolveUrl(id: string): Promise<ResolvedDocument | null>;
  /** Stage a picked/pasted/dropped file into a document and return its id + display info
   * (web: File-based ingestion for drag-drop, paste, and the in-editor file picker). */
  ingest?(file: File): Promise<{ id: string; filename: string; mime: string }>;
  /** Host-initiated ingestion via an OS-native picker (mobile): the shell opens the picker,
   * ingests the chosen file, and returns the new document's id. Used instead of `ingest`
   * where the editor can't receive a File (the native WebView). */
  pick?(): Promise<{ id: string; filename: string } | null>;
}
