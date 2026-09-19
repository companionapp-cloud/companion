// Note ink (PLAN-drawing.md): freehand drawing over a note, pinned to its text. These are the
// shapes that cross the editor's boundary (host ⇄ editor ⇄ WebView) and the payload the core
// stores per ink group. The core treats the payload as opaque JSON; this file owns its format.

/** Drawing tools. The pen draws over the text, the highlighter beneath it; the eraser removes
 *  whole strokes. */
export type InkToolKind = "pen" | "highlighter" | "eraser";

/** Ink colours are theme roles, not literals, so ink follows light/dark mode like the text:
 *  "ink" is the text colour (black on light, near-white on dark). */
export type InkColor = "ink" | "red" | "orange" | "yellow" | "green" | "blue";
export const INK_COLORS: readonly InkColor[] = ["ink", "red", "orange", "yellow", "green", "blue"];

/** Small, medium, large. Each tool maps these to its own widths. */
export type InkSize = 0 | 1 | 2;

/** The active drawing tool. The host passes one while drawing, or null for text editing. */
export interface InkTool {
  kind: InkToolKind;
  color: InkColor;
  size: InkSize;
}

export const DEFAULT_INK_TOOL: InkTool = { kind: "pen", color: "ink", size: 1 };

/** Stroke diameters (CSS px) per size. */
export const PEN_WIDTHS: readonly number[] = [2.5, 4, 7];
export const HIGHLIGHTER_WIDTHS: readonly number[] = [12, 18, 26];
/** Eraser radius (CSS px) per size. */
export const ERASER_RADII: readonly number[] = [6, 12, 22];

/** One stroke. `points` is a flat list of [x, y, pressure] triples, delta-encoded integers
 *  (x/y in tenths of a CSS px relative to the group's anchor point, pressure in percent) —
 *  see codec.ts. `sim` marks a stroke drawn without real pressure (mouse, finger), whose
 *  thickness is simulated from its speed instead. */
export interface InkStroke {
  id: string;
  tool: "pen" | "highlighter";
  color: InkColor;
  width: number;
  sim?: boolean;
  points: number[];
}

/** Pins a group to the note's text: the text just before and just after the anchor point,
 *  plus the anchor's offset into the note's text when it was written (a hint for picking
 *  between repeated passages). Re-found by matching the text, so the group follows its words
 *  through edits, syncs and different screen widths.
 *
 *  Ink drawn over words follows the character after the point, sideways and down. `free` ink
 *  was drawn in empty space (a margin, below the text, an empty note): it follows only its
 *  line's height, keeps its place across the column, and stays put when text is typed right
 *  at its point. */
export interface InkAnchor {
  before: string;
  after: string;
  offset: number;
  free?: boolean;
}

/** The stored payload of one ink group. */
export interface InkGroupData {
  v: 1;
  anchor: InkAnchor;
  strokes: InkStroke[];
}

/** One group as the host stores it. `rev` is an opaque revision (e.g. updatedAt) the editor
 *  uses to skip unchanged groups cheaply; `data` is an {@link InkGroupData}. */
export interface InkGroupRecord {
  id: string;
  data: Record<string, unknown>;
  rev?: string;
}

/** What the host's drawing toolbar needs to know. */
export interface InkState {
  canUndo: boolean;
  canRedo: boolean;
  hasInk: boolean;
}

/** How the ink layer reports changes. Writes are whole groups; the host persists them. */
export interface InkCallbacks {
  onSave(groups: InkGroupRecord[]): void;
  onDelete(ids: string[]): void;
  onStateChange?(state: InkState): void;
  /** Escape was pressed while drawing: the host should leave drawing mode. */
  onExitRequest?(): void;
}

/** Parse a stored payload, or null when it isn't an ink group this version understands. */
export function parseInkGroupData(raw: unknown): InkGroupData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<InkGroupData>;
  if (d.v !== 1 || !d.anchor || !Array.isArray(d.strokes)) return null;
  const a = d.anchor as Partial<InkAnchor>;
  if (typeof a.before !== "string" || typeof a.after !== "string" || typeof a.offset !== "number") return null;
  const strokes = d.strokes.filter(
    (s): s is InkStroke =>
      !!s &&
      typeof s.id === "string" &&
      (s.tool === "pen" || s.tool === "highlighter") &&
      typeof s.width === "number" &&
      Array.isArray(s.points) &&
      s.points.length >= 3,
  );
  const anchor: InkAnchor = { before: a.before, after: a.after, offset: a.offset };
  if (a.free) anchor.free = true;
  return { v: 1, anchor, strokes };
}
