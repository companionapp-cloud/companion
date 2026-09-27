import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { buildTextIndex, resolveAnchor, snapshotAnchor, type TextIndex } from "./anchor";
import {
  boxContains,
  decodePoints,
  encodePoints,
  inflate,
  nearPolyline,
  overlapArea,
  pointsBox,
  strokePath,
  unionBox,
  type Box,
  type InkPoint,
} from "./stroke";
import {
  ERASER_RADII,
  HIGHLIGHTER_WIDTHS,
  PEN_WIDTHS,
  parseInkGroupData,
  type InkAnchor,
  type InkCallbacks,
  type InkLayerOptions,
  type InkGroupData,
  type InkGroupRecord,
  type InkState,
  type InkStroke,
  type InkTool,
} from "./types";

// The ink layer (PLAN-drawing.md): two SVGs laid over the editor, inside its own DOM so they
// scroll with the text on every platform (the native WebView scrolls itself). Highlighter
// strokes sit beneath the text, pen strokes above it. While a tool is active the upper SVG
// takes all pointer input and the editor stops being editable; otherwise both SVGs ignore the
// pointer, so text under ink stays fully editable.
//
// Strokes are kept in groups, each pinned to a point in the text (see anchor.ts) and drawn in
// coordinates relative to that point, so a group moves with its words as text is edited above
// it, as another device's edit arrives, or as the note reflows at another width.

const SVG_NS = "http://www.w3.org/2000/svg";

// Strokes drawn in quick succession near each other join one group (a handwritten word, a
// sketch) so they are pinned and synced as a unit and can never drift apart. A stroke drawn
// mostly on top of an existing group joins it too.
const JOIN_WINDOW_MS = 1600;
const JOIN_MARGIN = 40;
const JOIN_OVERLAP = 0.5;
// Start a new group before a group's payload nears the core's 128 KiB row cap.
const MAX_GROUP_BYTES = 96 * 1024;
const MAX_STROKE_POINTS = 4000;
const MAX_UNDO = 200;
// While drawing, keep at least this much room below the text to draw in.
const DRAW_SPACE_MIN = 240;
// Re-pin anchors this long after the text around them was edited here.
const RESNAPSHOT_MS = 1500;
// Re-pin anchors that only resolved approximately after a load (the text around them changed
// elsewhere). Delayed so the device that made the edit, which re-pins too, usually wins.
const APPROX_RESNAPSHOT_MS = 3000;
// Our own write is expected back from the host within this window; until then a different
// version of that group from the host is a stale read and is ignored.
const ECHO_WINDOW_MS = 5000;
const PAGE_ANCHOR: InkAnchor = { before: "", after: "", offset: 0, page: true };

interface Group {
  id: string;
  anchor: InkAnchor;
  strokes: InkStroke[];
  /** Where the anchor sits in the current document. */
  pos: number;
  /** The anchor's text is gone (deleted here, or missing on load): the group is shown near
   *  its old place and its stored anchor is kept, so it snaps back if the text returns. */
  orphan: boolean;
  over: SVGGElement;
  under: SVGGElement;
  paths: Map<string, SVGPathElement>;
  points: Map<string, InkPoint[]>;
  boxes: Map<string, Box>;
  /** Bounds of all strokes, in the group's own coordinates. */
  bbox: Box | null;
  /** Current placement in layer coordinates: translate(tx, ty) scale(scale). */
  tx: number;
  ty: number;
  scale: number;
  bytes: number;
  rev?: string;
  serialized?: string;
  lastStrokeAt: number;
}

type InkOp =
  | { kind: "add"; groupId: string; anchor: InkAnchor; stroke: InkStroke }
  | { kind: "erase"; removed: { groupId: string; anchor: InkAnchor; index: number; stroke: InkStroke }[] };

interface LiveStroke {
  pointerId: number;
  tool: "pen" | "highlighter";
  color: InkStroke["color"];
  width: number;
  sim: boolean;
  points: InkPoint[];
  path: SVGPathElement;
  frame: number;
}

interface Origin {
  left: number;
  top: number;
  /** Rendered px per CSS px (an ancestor may be scaled, e.g. a preview card). */
  scale: number;
}

/** Where the text sits within the layers, in layer coordinates. */
interface Frame {
  /** The layers' width (the text column plus its gutters). */
  width: number;
  /** The text column's left edge: free ink is placed across the column from here, so it
   *  lines up the same on every platform whatever the page padding. */
  columnLeft: number;
  /** The bottom of the text. */
  contentBottom: number;
}

function newGroupId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function newStrokeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export class InkLayer {
  private readonly under: SVGSVGElement;
  private readonly over: SVGSVGElement;
  private readonly cursor: SVGCircleElement;
  private groups = new Map<string, Group>();
  /** Group ids in paint order. */
  private order: string[] = [];
  /** Group ids the host has confirmed exist (seen in a setGroups). */
  private known = new Set<string>();
  private echo = new Map<string, { serialized: string; until: number }>();
  private pendingSave = new Set<string>();
  private pendingDelete = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private resnapTimer: ReturnType<typeof setTimeout> | null = null;
  private approx = new Set<string>();
  private approxTimer: ReturnType<typeof setTimeout> | null = null;
  private tool: InkTool | null = null;
  /** Drawn with by a stylus even outside drawing mode (notebooks: the pencil always draws). */
  private penTool: InkTool | null = null;
  private inkBottom = 0;
  private index: { doc: unknown; index: TextIndex } | null = null;
  private cancelLayout: (() => void) | null = null;
  private undoStack: InkOp[] = [];
  private redoStack: InkOp[] = [];
  private live: LiveStroke | null = null;
  private erasing: { pointerId: number; last: [number, number]; op: Extract<InkOp, { kind: "erase" }> } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private penSeen = false;
  private activeGroupId: string | null = null;
  private lastState = "";
  private ro: ResizeObserver | null = null;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly host: HTMLElement,
    private readonly cb: InkCallbacks,
    private readonly saveDelayMs = 300,
    private readonly opts: InkLayerOptions = {},
  ) {
    host.classList.add("pm-ink-host");
    this.under = this.makeLayer("pm-ink pm-ink-under");
    this.over = this.makeLayer("pm-ink pm-ink-over");
    this.cursor = svgEl("circle");
    this.cursor.setAttribute("class", "pm-ink-cursor");
    this.cursor.style.display = "none";
    this.over.appendChild(this.cursor);
    host.appendChild(this.under);
    host.appendChild(this.over);

    const o = this.over;
    o.addEventListener("pointerdown", this.onPointerDown);
    o.addEventListener("pointermove", this.onPointerMove);
    o.addEventListener("pointerup", this.onPointerUp);
    o.addEventListener("pointercancel", this.onPointerCancel);
    o.addEventListener("pointerleave", this.onPointerLeave);
    // iPadOS Scribble swallows pen events on web pages unless touches on the surface are
    // cancelled; cancelling also stops the page from scrolling under a stroke.
    o.addEventListener("touchstart", this.onTouch, { passive: false });
    o.addEventListener("touchmove", this.onTouch, { passive: false });
    // The pencil draws outside drawing mode too (see setPenTool): the upper layer ignores the
    // pointer then, so a stylus is caught on the host before the text sees it.
    host.addEventListener("pointerdown", this.onHostPointerDown, true);
    host.addEventListener("touchstart", this.onHostTouch, { passive: false, capture: true });

    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.queueLayout());
      this.ro.observe(view.dom);
    } else {
      window.addEventListener("resize", this.queueLayout);
    }
    document.fonts?.addEventListener?.("loadingdone", this.queueLayout);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.queueLayout();
  }

  // ---- host API ------------------------------------------------------------------------

  /** Replace the layer's groups with the host's current set (initial load, or a change that
   *  arrived from elsewhere). Groups with unsaved local edits keep the local version. */
  setGroups(records: InkGroupRecord[]): void {
    if (this.destroyed) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const r of records) {
      seen.add(r.id);
      this.known.add(r.id);
      if (this.pendingSave.has(r.id) || this.pendingDelete.has(r.id)) continue;
      const g = this.groups.get(r.id);
      if (g && r.rev !== undefined && g.rev === r.rev) continue;
      const serialized = JSON.stringify(r.data);
      const echo = this.echo.get(r.id);
      if (echo) {
        if (echo.serialized === serialized) this.echo.delete(r.id);
        else if (echo.until > now) continue; // a read from before our write landed
        else this.echo.delete(r.id);
      }
      if (g && g.serialized === serialized) {
        g.rev = r.rev;
        continue;
      }
      const data = parseInkGroupData(r.data);
      if (!data) continue;
      if (g) this.replaceGroup(g, data, serialized, r.rev);
      else this.loadGroup(r.id, data, serialized, r.rev);
    }
    for (const id of [...this.groups.keys()]) {
      // Deleted elsewhere: the host knew it and now doesn't. Groups the host hasn't confirmed
      // yet are local creations still on their way, as are writes it hasn't echoed yet.
      const echoing = (this.echo.get(id)?.until ?? 0) > now;
      if (!seen.has(id) && this.known.has(id) && !this.pendingSave.has(id) && !echoing) {
        this.removeGroupDom(id);
        this.known.delete(id);
      }
    }
    this.queueLayout();
    this.emitState();
  }

  /** Enter drawing mode with a tool, switch tools, or leave drawing mode (null). */
  setTool(tool: InkTool | null): void {
    if (this.destroyed) return;
    const wasDrawing = !!this.tool;
    this.tool = tool;
    this.host.classList.toggle("pm-ink-drawing", !!tool);
    this.host.classList.toggle("pm-ink-erasing", tool?.kind === "eraser");
    if (tool?.kind !== "eraser") this.cursor.style.display = "none";
    if (tool && !wasDrawing) {
      // Not editable while drawing: no caret, no keyboard, no text selection, and iPadOS
      // Scribble has no text field to turn handwriting into.
      this.view.setProps({ editable: () => false });
      (this.view.dom as HTMLElement).blur();
      if (this.opts.keyboard !== false) window.addEventListener("keydown", this.onKey);
    } else if (!tool && wasDrawing) {
      this.cancelGesture();
      this.view.setProps({ editable: () => true });
      window.removeEventListener("keydown", this.onKey);
      this.activeGroupId = null;
      this.flush();
    }
    this.queueLayout();
  }

  /** The tool a stylus draws with while no drawing tool is active, or null for none: the text
   *  stays editable by finger and keyboard, and the pencil always writes. */
  setPenTool(tool: InkTool | null): void {
    this.penTool = tool;
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op || this.live || this.erasing) {
      if (op) this.undoStack.push(op);
      return;
    }
    if (op.kind === "add") {
      const g = this.groups.get(op.groupId);
      if (g) this.removeStroke(g, op.stroke.id);
    } else {
      for (let i = op.removed.length - 1; i >= 0; i--) {
        const r = op.removed[i];
        const g = this.groups.get(r.groupId) ?? this.recreateGroup(r.groupId, r.anchor);
        this.insertStroke(g, r.stroke, r.index);
      }
    }
    this.redoStack.push(op);
    this.activeGroupId = null;
    this.queueLayout();
    this.emitState();
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op || this.live || this.erasing) {
      if (op) this.redoStack.push(op);
      return;
    }
    if (op.kind === "add") {
      const g = this.groups.get(op.groupId) ?? this.recreateGroup(op.groupId, op.anchor);
      this.insertStroke(g, op.stroke, g.strokes.length);
    } else {
      for (const r of op.removed) {
        const g = this.groups.get(r.groupId);
        if (g) this.removeStroke(g, r.stroke.id);
      }
    }
    this.undoStack.push(op);
    this.activeGroupId = null;
    this.queueLayout();
    this.emitState();
  }

  /** Map anchors through a local edit, and re-pin the ones whose surrounding text changed.
   *  Text typed right at a point pushes ink drawn over words along with them, but leaves ink
   *  drawn in empty space where it is. */
  onTransaction(tr: Transaction): void {
    if (!tr.docChanged || this.destroyed) return;
    for (const g of this.groups.values()) {
      if (g.anchor.page) continue;
      const r = tr.mapping.mapResult(g.pos, g.anchor.free ? -1 : 1);
      g.pos = r.pos;
      // Text deleted all around the point (a selection spanning it): don't re-pin to whatever
      // is left; wait to see whether it comes back.
      if (r.deletedAcross) g.orphan = true;
    }
    if (this.groups.size) {
      if (this.resnapTimer) clearTimeout(this.resnapTimer);
      this.resnapTimer = setTimeout(() => this.resnapshot(), RESNAPSHOT_MS);
    }
    this.queueLayout();
  }

  /** Persist pending writes now. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.pendingSave.size) {
      const now = Date.now();
      const records: InkGroupRecord[] = [];
      for (const id of this.pendingSave) {
        const g = this.groups.get(id);
        if (!g) continue;
        const data = this.groupData(g) as unknown as Record<string, unknown>;
        g.serialized = JSON.stringify(data);
        this.echo.set(id, { serialized: g.serialized, until: now + ECHO_WINDOW_MS });
        records.push({ id, data });
      }
      this.pendingSave.clear();
      if (records.length) this.cb.onSave(records);
    }
    if (this.pendingDelete.size) {
      const ids = [...this.pendingDelete];
      this.pendingDelete.clear();
      // A read that started before the delete landed must not bring the group back.
      const until = Date.now() + ECHO_WINDOW_MS;
      for (const id of ids) this.echo.set(id, { serialized: "", until });
      this.cb.onDelete(ids);
    }
  }

  destroy(flush: boolean): void {
    if (this.destroyed) return;
    if (this.resnapTimer) {
      clearTimeout(this.resnapTimer);
      this.resnapTimer = null;
      if (flush) this.resnapshot();
    }
    if (flush) this.flush();
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.approxTimer) clearTimeout(this.approxTimer);
    this.cancelLayout?.();
    if (this.live) cancelAnimationFrame(this.live.frame);
    this.ro?.disconnect();
    window.removeEventListener("resize", this.queueLayout);
    window.removeEventListener("keydown", this.onKey);
    document.fonts?.removeEventListener?.("loadingdone", this.queueLayout);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.host.removeEventListener("pointerdown", this.onHostPointerDown, true);
    this.host.removeEventListener("touchstart", this.onHostTouch, true);
    this.under.remove();
    this.over.remove();
    this.host.classList.remove("pm-ink-host", "pm-ink-drawing", "pm-ink-erasing");
  }

  // ---- groups ----------------------------------------------------------------------------

  private makeLayer(cls: string): SVGSVGElement {
    const svg = svgEl("svg");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  private textIndex(): TextIndex {
    const doc = this.view.state.doc;
    if (!this.index || this.index.doc !== doc) this.index = { doc, index: buildTextIndex(doc) };
    return this.index.index;
  }

  private makeGroup(id: string, anchor: InkAnchor, pos: number): Group {
    const over = svgEl("g");
    const under = svgEl("g");
    this.over.insertBefore(over, this.cursor);
    this.under.appendChild(under);
    const g: Group = {
      id,
      anchor,
      strokes: [],
      pos,
      orphan: false,
      over,
      under,
      paths: new Map(),
      points: new Map(),
      boxes: new Map(),
      bbox: null,
      tx: 0,
      ty: 0,
      scale: 1,
      bytes: 0,
      lastStrokeAt: 0,
    };
    this.groups.set(id, g);
    this.order.push(id);
    return g;
  }

  /** A group from the host: find its anchor in the current text and draw its strokes. */
  private loadGroup(id: string, data: InkGroupData, serialized: string, rev?: string): void {
    if (data.anchor.page) {
      const g = this.makeGroup(id, data.anchor, 0);
      for (const s of data.strokes) this.renderStroke(g, s);
      g.strokes = data.strokes.slice();
      g.serialized = serialized;
      g.rev = rev;
      return;
    }
    const index = this.textIndex();
    const hit = resolveAnchor(index, data.anchor);
    const g = this.makeGroup(id, data.anchor, index.posAt(hit.offset));
    for (const s of data.strokes) this.renderStroke(g, s);
    g.strokes = data.strokes.slice();
    g.serialized = serialized;
    g.rev = rev;
    g.orphan = hit.match === "lost";
    if (hit.match === "partial") this.scheduleApprox(id);
  }

  private replaceGroup(g: Group, data: InkGroupData, serialized: string, rev?: string): void {
    for (const p of g.paths.values()) p.remove();
    g.paths.clear();
    g.points.clear();
    g.boxes.clear();
    g.bbox = null;
    g.bytes = 0;
    const index = this.textIndex();
    const hit = data.anchor.page ? { offset: 0, match: "exact" as const } : resolveAnchor(index, data.anchor);
    g.anchor = data.anchor;
    g.pos = data.anchor.page ? 0 : index.posAt(hit.offset);
    for (const s of data.strokes) this.renderStroke(g, s);
    g.strokes = data.strokes.slice();
    g.serialized = serialized;
    g.rev = rev;
    g.orphan = hit.match === "lost";
    this.approx.delete(g.id);
    if (hit.match === "partial") this.scheduleApprox(g.id);
  }

  /** A new group pinned to the text nearest (x, y), in layer coordinates: to the words under
   *  it, or (drawn in empty space) freely to the nearest line. */
  private createGroupAt(x: number, y: number): Group {
    if (this.opts.page) {
      const g = this.makeGroup(newGroupId(), { ...PAGE_ANCHOR }, 0);
      const o = this.origin();
      if (o) this.placeGroup(g, o, this.frame(o));
      return g;
    }
    const index = this.textIndex();
    let pos = this.posNear(x, y);
    let free = !this.overText(x, y, pos);
    if (free) {
      // An underline sits just below the words it marks.
      const above = this.posNear(x, y - 10);
      if (this.overText(x, y - 10, above)) {
        pos = above;
        free = false;
      }
    }
    const offset = index.offsetAt(pos);
    const g = this.makeGroup(newGroupId(), snapshotAnchor(index, offset, free), index.posAt(offset));
    const o = this.origin();
    if (o) this.placeGroup(g, o, this.frame(o));
    return g;
  }

  /** Bring back a group an undo/redo needs (it was deleted when its last stroke went). */
  private recreateGroup(id: string, anchor: InkAnchor): Group {
    const index = this.textIndex();
    const hit = anchor.page ? { offset: 0, match: "exact" as const } : resolveAnchor(index, anchor);
    const g = this.makeGroup(id, anchor, index.posAt(hit.offset));
    g.orphan = hit.match === "lost";
    this.pendingDelete.delete(id);
    const o = this.origin();
    if (o) this.placeGroup(g, o, this.frame(o));
    return g;
  }

  private removeGroupDom(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.over.remove();
    g.under.remove();
    this.groups.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.approx.delete(id);
    if (this.activeGroupId === id) this.activeGroupId = null;
  }

  private deleteGroup(g: Group): void {
    this.removeGroupDom(g.id);
    this.pendingSave.delete(g.id);
    this.echo.delete(g.id);
    if (this.known.has(g.id) || g.serialized !== undefined) this.pendingDelete.add(g.id);
    this.scheduleFlush();
  }

  private renderStroke(g: Group, s: InkStroke): void {
    const pts = decodePoints(s.points);
    g.points.set(s.id, pts);
    const box = pointsBox(pts, s.width);
    if (box) {
      g.boxes.set(s.id, box);
      g.bbox = unionBox(g.bbox, box);
    }
    const path = svgEl("path");
    path.setAttribute("d", strokePath(pts, s));
    path.setAttribute("data-c", s.color);
    (s.tool === "highlighter" ? g.under : g.over).appendChild(path);
    g.paths.set(s.id, path);
    g.bytes += s.points.length * 4 + 80;
  }

  private insertStroke(g: Group, s: InkStroke, index: number): void {
    if (g.paths.has(s.id)) return;
    const at = Math.max(0, Math.min(index, g.strokes.length));
    g.strokes.splice(at, 0, s);
    this.renderStroke(g, s);
    if (at < g.strokes.length - 1) {
      // Keep paint order equal to stroke order.
      for (const st of g.strokes) {
        const p = g.paths.get(st.id);
        if (p) p.parentNode?.appendChild(p);
      }
    }
    this.markDirty(g.id);
  }

  /** Remove a stroke; returns its former index, or -1. Deletes the group when it empties. */
  private removeStroke(g: Group, strokeId: string): number {
    const at = g.strokes.findIndex((s) => s.id === strokeId);
    if (at === -1) return -1;
    const [s] = g.strokes.splice(at, 1);
    g.paths.get(strokeId)?.remove();
    g.paths.delete(strokeId);
    g.points.delete(strokeId);
    g.boxes.delete(strokeId);
    g.bytes = Math.max(0, g.bytes - (s.points.length * 4 + 80));
    g.bbox = null;
    for (const b of g.boxes.values()) g.bbox = unionBox(g.bbox, b);
    if (g.strokes.length === 0) this.deleteGroup(g);
    else this.markDirty(g.id);
    return at;
  }

  private groupData(g: Group): InkGroupData {
    return { v: 1, anchor: g.anchor, strokes: g.strokes };
  }

  // ---- persistence -----------------------------------------------------------------------

  private markDirty(id: string): void {
    this.pendingSave.add(id);
    this.pendingDelete.delete(id);
    this.approx.delete(id);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.saveDelayMs <= 0) {
      this.flush();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, this.saveDelayMs);
    }
    this.emitState();
  }

  /** Re-pin every group whose surrounding text changed since its anchor was written. An
   *  orphaned group is looked for again instead: found as written, it simply snaps back. */
  private resnapshot(): void {
    this.resnapTimer = null;
    if (this.destroyed) return;
    const index = this.textIndex();
    let moved = false;
    for (const g of this.groups.values()) {
      if (g.anchor.page) continue;
      if (g.orphan) {
        const hit = resolveAnchor(index, g.anchor);
        if (hit.match === "lost") continue;
        g.pos = index.posAt(hit.offset);
        g.orphan = false;
        moved = true;
        if (hit.match === "exact") continue;
      }
      const a = snapshotAnchor(index, index.offsetAt(g.pos), g.anchor.free);
      if (a.before !== g.anchor.before || a.after !== g.anchor.after || Math.abs(a.offset - g.anchor.offset) > 2000) {
        g.anchor = a;
        this.markDirty(g.id);
      }
    }
    if (moved) this.queueLayout();
  }

  private scheduleApprox(id: string): void {
    this.approx.add(id);
    if (this.approxTimer) return;
    this.approxTimer = setTimeout(() => {
      this.approxTimer = null;
      if (this.destroyed) return;
      const index = this.textIndex();
      for (const id of this.approx) {
        const g = this.groups.get(id);
        if (!g || g.orphan || g.anchor.page) continue;
        g.anchor = snapshotAnchor(index, index.offsetAt(g.pos), g.anchor.free);
        this.markDirty(id);
      }
      this.approx.clear();
    }, APPROX_RESNAPSHOT_MS);
  }

  private emitState(): void {
    const state: InkState = {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      hasInk: this.groups.size > 0,
    };
    if (this.opts.page) state.inkBottom = this.inkBottom;
    const key = `${state.canUndo}${state.canRedo}${state.hasInk}${state.inkBottom ?? ""}`;
    if (key === this.lastState) return;
    this.lastState = key;
    this.cb.onStateChange?.(state);
  }

  private pushUndo(op: InkOp): void {
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.emitState();
  }

  // ---- layout ----------------------------------------------------------------------------

  private queueLayout = (): void => {
    if (this.cancelLayout || this.destroyed) return;
    const run = () => {
      this.cancelLayout = null;
      this.layout();
    };
    // Animation frames don't run in a hidden page, so ink loaded there would wait unplaced until
    // it's shown; a timer places it right away.
    if (document.hidden) {
      const t = setTimeout(run, 16);
      this.cancelLayout = () => clearTimeout(t);
    } else {
      const f = requestAnimationFrame(run);
      this.cancelLayout = () => cancelAnimationFrame(f);
    }
  };

  /** The layers' top-left on screen (a gutter outside the text column, see styles.ts), or
   *  null while the editor isn't laid out (a hidden tab). Layer coordinates start here. */
  private origin(): Origin | null {
    if (!this.host.isConnected || this.host.getClientRects().length === 0) return null;
    const h = this.host.getBoundingClientRect();
    const scale = this.host.offsetWidth ? h.width / this.host.offsetWidth : 1;
    const r = this.over.getBoundingClientRect();
    return { left: r.left, top: r.top, scale: scale || 1 };
  }

  private frame(o: Origin): Frame {
    const d = (this.view.dom as HTMLElement).getBoundingClientRect();
    return {
      width: this.over.getBoundingClientRect().width / o.scale,
      columnLeft: (d.left - o.left) / o.scale,
      contentBottom: (d.bottom - o.top) / o.scale,
    };
  }

  private layout(): void {
    const o = this.origin();
    if (!o) return;
    const f = this.frame(o);
    let inkBottom = 0;
    for (const id of this.order) {
      const g = this.groups.get(id)!;
      this.placeGroup(g, o, f);
      if (g.bbox) inkBottom = Math.max(inkBottom, g.ty + (g.bbox.y + g.bbox.h) * g.scale);
    }
    if (this.opts.page) {
      // The sheet sizes the layers (CSS); report the lowest ink so the sheet can hold it.
      const bottom = Math.ceil(inkBottom);
      if (bottom !== this.inkBottom) {
        this.inkBottom = bottom;
        this.emitState();
      }
      return;
    }
    // The layers may reach past the text: ink drawn below it, and room to draw while drawing.
    // Absolutely positioned, they extend the scroll area without moving anything.
    const drawSpace = this.tool ? Math.max(DRAW_SPACE_MIN, window.innerHeight * 0.6) : 0;
    const height = Math.ceil(Math.max(f.contentBottom + drawSpace, inkBottom + 24));
    this.over.style.height = this.under.style.height = `${height}px`;
  }

  /** Put a group at its anchor. A group that would stick out past the layers (it was drawn
   *  on a wider screen) is nudged back in, and scaled down if it is wider than they are. */
  private placeGroup(g: Group, o: Origin, f: Frame): void {
    if (g.anchor.page) {
      // Page coordinates are the layers' own: the sheet's top-left, unscaled.
      if (!g.over.hasAttribute("transform")) {
        g.over.setAttribute("transform", "translate(0 0)");
        g.under.setAttribute("transform", "translate(0 0)");
      }
      g.tx = g.ty = 0;
      g.scale = 1;
      return;
    }
    const free = !!g.anchor.free;
    let c: { left: number; top: number };
    try {
      // Words: the character after the point. Free ink: the line the point ends.
      c = this.view.coordsAtPos(Math.max(0, Math.min(g.pos, this.view.state.doc.content.size)), free ? -1 : 1);
    } catch {
      return;
    }
    const ax = free ? f.columnLeft : (c.left - o.left) / o.scale;
    const ay = (c.top - o.top) / o.scale;
    const width = f.width;
    let tx = ax;
    let s = 1;
    if (g.bbox && width > 0) {
      if (g.bbox.w > width) {
        s = width / g.bbox.w;
        tx = -g.bbox.x * s;
      } else {
        const left = ax + g.bbox.x;
        const right = left + g.bbox.w;
        if (right > width) tx -= right - width;
        if (left + (tx - ax) < 0) tx = ax - left;
      }
    }
    if (tx === g.tx && ay === g.ty && s === g.scale && g.over.hasAttribute("transform")) return;
    g.tx = tx;
    g.ty = ay;
    g.scale = s;
    const t = `translate(${tx.toFixed(2)} ${ay.toFixed(2)})${s === 1 ? "" : ` scale(${s.toFixed(4)})`}`;
    g.over.setAttribute("transform", t);
    g.under.setAttribute("transform", t);
  }

  /** A group's bounds in layer coordinates. */
  private displayBox(g: Group): Box | null {
    if (!g.bbox) return null;
    return { x: g.tx + g.bbox.x * g.scale, y: g.ty + g.bbox.y * g.scale, w: g.bbox.w * g.scale, h: g.bbox.h * g.scale };
  }

  /** Whether (x, y), in layer coordinates, lies on the text at `pos` (the position nearest it):
   *  on that character's line, and no further from it sideways than a character or two. */
  private overText(x: number, y: number, pos: number): boolean {
    const o = this.origin();
    if (!o) return false;
    const doc = this.view.state.doc;
    const p = Math.max(0, Math.min(pos, doc.content.size));
    const parent = doc.resolve(p).parent;
    if (!parent.isTextblock || parent.content.size === 0) return false;
    let c: { left: number; top: number; bottom: number };
    try {
      c = this.view.coordsAtPos(p, 1);
    } catch {
      return false;
    }
    const cx = o.left + x * o.scale;
    const cy = o.top + y * o.scale;
    return cy >= c.top - 2 && cy <= c.bottom + 2 && Math.abs(cx - c.left) <= 16 * o.scale;
  }

  /** The document position nearest a point in layer coordinates. */
  private posNear(x: number, y: number): number {
    const o = this.origin();
    const r = (this.view.dom as HTMLElement).getBoundingClientRect();
    if (!o || r.width === 0) return 0;
    const cx = Math.min(Math.max(o.left + x * o.scale, r.left + 1), r.right - 1);
    const cy = Math.min(Math.max(o.top + y * o.scale, r.top + 1), r.bottom - 1);
    const hit = this.view.posAtCoords({ left: cx, top: cy });
    if (hit) return hit.pos;
    return cy > r.top + r.height / 2 ? this.view.state.doc.content.size : 0;
  }

  private toLocal(e: { clientX: number; clientY: number }, o: Origin): [number, number] {
    return [(e.clientX - o.left) / o.scale, (e.clientY - o.top) / o.scale];
  }

  // ---- input -----------------------------------------------------------------------------

  private onTouch = (e: TouchEvent): void => {
    if (this.tool) e.preventDefault();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.flush();
  };

  private onKey = (e: KeyboardEvent): void => {
    // Several editors can be mounted (background tabs); only a visible, drawing one answers.
    if (!this.tool || this.host.offsetParent === null) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && !e.altKey && key === "y") {
      e.preventDefault();
      this.redo();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.cb.onExitRequest?.();
    }
  };

  /** A stylus touching the page outside drawing mode: draw with the pen tool instead of placing
   *  the caret. Fingers and the mouse fall through to the text. */
  private onHostPointerDown = (e: PointerEvent): void => {
    if (this.tool || !this.penTool || e.pointerType !== "pen" || this.destroyed) return;
    e.stopPropagation();
    this.onPointerDown(e);
  };

  /** iPadOS Scribble turns pencil strokes over editable text into typing unless the touch is
   *  cancelled. Only stylus touches are cancelled, so fingers still scroll and tap. */
  private onHostTouch = (e: TouchEvent): void => {
    if (this.tool || !this.penTool) return;
    for (const t of Array.from(e.changedTouches)) {
      if ((t as Touch & { touchType?: string }).touchType === "stylus") {
        e.preventDefault();
        return;
      }
    }
  };

  private activeTool(e?: PointerEvent): InkTool | null {
    return this.tool ?? ((!e || e.pointerType === "pen") ? this.penTool : null);
  }

  private onPointerDown = (e: PointerEvent): void => {
    const tool = this.activeTool(e);
    if (!tool || this.destroyed) return;
    const o = this.origin();
    if (!o) return;
    if (e.pointerType === "pen") this.penSeen = true;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Two fingers scroll; once a pen has been used, one finger scrolls too (the pen draws).
      if (this.touches.size > 1 || this.penSeen) {
        if (this.live?.pointerId !== undefined && this.touches.has(this.live.pointerId)) this.finishStroke(true);
        if (this.erasing && this.touches.has(this.erasing.pointerId)) this.finishErase();
        return;
      }
    } else if (e.button !== 0 && e.button !== 5) {
      return;
    }
    if (this.live || this.erasing) return;
    e.preventDefault();
    try {
      this.over.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    const [x, y] = this.toLocal(e, o);
    // A pen's eraser end (button 5) erases whatever tool is selected.
    if (tool.kind === "eraser" || e.button === 5) {
      this.erasing = { pointerId: e.pointerId, last: [x, y], op: { kind: "erase", removed: [] } };
      this.eraseAt(x, y);
      return;
    }
    const kind = tool.kind === "highlighter" ? "highlighter" : "pen";
    const real = e.pointerType === "pen" && e.pressure > 0;
    const path = svgEl("path");
    path.setAttribute("data-c", tool.color);
    (kind === "highlighter" ? this.under : this.over).appendChild(path);
    this.live = {
      pointerId: e.pointerId,
      tool: kind,
      color: tool.color,
      width: (kind === "highlighter" ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS)[tool.size] ?? 4,
      sim: !real,
      points: [[x, y, real ? e.pressure : 0.5]],
      path,
      frame: 0,
    };
    this.renderLive();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.tool && !this.live && !this.erasing) return;
    const o = this.origin();
    if (!o) return;
    const prev = e.pointerType === "touch" ? this.touches.get(e.pointerId) : undefined;
    if (prev) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size > 1 || this.penSeen) {
        // A palm resting on the screen must not scroll the page under a pen stroke.
        if (!this.live && !this.erasing) {
          this.pan(e.clientX - prev.x, e.clientY - prev.y);
          this.pinch(e, prev);
        }
        return;
      }
    }
    if (this.tool?.kind === "eraser" && e.pointerType !== "touch") {
      const [x, y] = this.toLocal(e, o);
      const r = ERASER_RADII[this.tool.size] ?? 12;
      this.cursor.style.display = "";
      this.cursor.setAttribute("cx", x.toFixed(1));
      this.cursor.setAttribute("cy", y.toFixed(1));
      this.cursor.setAttribute("r", String(r));
    }
    if (this.erasing && e.pointerId === this.erasing.pointerId) {
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e]) {
        const [x, y] = this.toLocal(ev, o);
        this.eraseAlong(this.erasing.last, [x, y]);
        this.erasing.last = [x, y];
      }
      return;
    }
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.toLocal(ev, o);
      const last = live.points[live.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.4) continue;
      live.points.push([x, y, live.sim ? 0.5 : ev.pressure || 0.5]);
    }
    if (live.points.length >= MAX_STROKE_POINTS) {
      this.finishStroke(false);
      return;
    }
    this.renderLive();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    if (this.live && e.pointerId === this.live.pointerId) this.finishStroke(false);
    else if (this.erasing && e.pointerId === this.erasing.pointerId) this.finishErase();
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    if (this.live && e.pointerId === this.live.pointerId) this.finishStroke(true);
    else if (this.erasing && e.pointerId === this.erasing.pointerId) this.finishErase();
  };

  private onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") this.cursor.style.display = "none";
  };

  private cancelGesture(): void {
    if (this.live) this.finishStroke(true);
    if (this.erasing) this.finishErase();
    this.touches.clear();
    this.cursor.style.display = "none";
  }

  /** Scroll the note with one or two fingers while drawing (the layer blocks native
   *  scrolling so strokes don't scroll the page). Each finger contributes its share of the
   *  movement, so two fingers moving together scroll by their shared distance. */
  /** Two fingers changing their distance: report the zoom factor to the host. The pan above
   *  has already moved each finger's share, so pinching in place doesn't drift. */
  private pinch(e: PointerEvent, prev: { x: number; y: number }): void {
    if (!this.cb.onPinch || this.touches.size !== 2) return;
    const [a, b] = [...this.touches.entries()];
    const other = a[0] === e.pointerId ? b[1] : a[1];
    const before = Math.hypot(prev.x - other.x, prev.y - other.y);
    const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
    if (before < 1 || after < 1) return;
    const factor = after / before;
    if (Math.abs(factor - 1) < 0.002) return;
    this.cb.onPinch(factor, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
  }

  private pan(moveX: number, moveY: number): void {
    const n = this.touches.size;
    const dx = moveX / n;
    const dy = moveY / n;
    const scroller = this.scrollParent();
    if (scroller) {
      scroller.scrollTop -= dy;
      scroller.scrollLeft -= dx;
    }
  }

  private scrollParent(): Element | null {
    for (let el = this.host.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }

  private renderLive(): void {
    const live = this.live;
    if (!live || live.frame) return;
    live.frame = requestAnimationFrame(() => {
      live.frame = 0;
      if (this.live !== live) return;
      live.path.setAttribute("d", strokePath(live.points, live, false));
    });
  }

  private finishStroke(cancelled: boolean): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    if (live.frame) cancelAnimationFrame(live.frame);
    live.path.remove();
    try {
      this.over.releasePointerCapture(live.pointerId);
    } catch {
      /* already released */
    }
    if (cancelled || live.points.length === 0) return;

    const points = live.points;
    const box = pointsBox(points, live.width)!;
    const g = this.pickGroup(box, live.tool) ?? this.createGroupAt(box.x + box.w / 2, box.y + box.h / 2);
    // Into the group's own coordinates (undoing its placement, which may be scaled).
    const local: InkPoint[] = points.map(([x, y, p]) => [(x - g.tx) / g.scale, (y - g.ty) / g.scale, p]);
    const stroke: InkStroke = {
      id: newStrokeId(),
      tool: live.tool,
      color: live.color,
      width: Math.round((live.width / g.scale) * 10) / 10,
      points: encodePoints(local),
    };
    if (live.sim) stroke.sim = true;
    this.insertStroke(g, stroke, g.strokes.length);
    g.lastStrokeAt = Date.now();
    this.activeGroupId = g.id;
    this.pushUndo({ kind: "add", groupId: g.id, anchor: g.anchor, stroke });
    this.queueLayout();
  }

  /** The group a finished stroke joins: the one being written (recent and near), or one it
   *  was drawn mostly on top of. Null starts a new group. */
  private pickGroup(box: Box, tool: "pen" | "highlighter"): Group | null {
    if (tool === "pen" && this.activeGroupId) {
      const g = this.groups.get(this.activeGroupId);
      const db = g && this.displayBox(g);
      if (g && db && Date.now() - g.lastStrokeAt < JOIN_WINDOW_MS && g.bytes < MAX_GROUP_BYTES && overlapArea(inflate(db, JOIN_MARGIN), box) > 0) {
        return g;
      }
    }
    let best: Group | null = null;
    let bestArea = 0;
    for (const g of this.groups.values()) {
      const db = this.displayBox(g);
      if (!db || g.bytes >= MAX_GROUP_BYTES) continue;
      const a = overlapArea(db, box);
      if (a > bestArea) {
        best = g;
        bestArea = a;
      }
    }
    return best && bestArea >= JOIN_OVERLAP * box.w * box.h ? best : null;
  }

  private eraseAlong(from: [number, number], to: [number, number]): void {
    const r = ERASER_RADII[this.activeTool()?.size ?? 1] ?? 12;
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.ceil(dist / (r / 2)));
    for (let i = 1; i <= steps; i++) {
      this.eraseAt(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    }
  }

  /** Erase every stroke within the eraser's radius of (x, y), in layer coordinates. */
  private eraseAt(x: number, y: number): void {
    const erasing = this.erasing;
    if (!erasing) return;
    const radius = ERASER_RADII[this.activeTool()?.size ?? 1] ?? 12;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const g = this.groups.get(this.order[i]);
      if (!g?.bbox) continue;
      const lx = (x - g.tx) / g.scale;
      const ly = (y - g.ty) / g.scale;
      const lr = radius / g.scale;
      if (!boxContains(inflate(g.bbox, lr), lx, ly)) continue;
      for (let k = g.strokes.length - 1; k >= 0; k--) {
        const s = g.strokes[k];
        const b = g.boxes.get(s.id);
        if (!b || !boxContains(inflate(b, lr), lx, ly)) continue;
        const pts = g.points.get(s.id);
        if (!pts || !nearPolyline(pts, lx, ly, lr + s.width / 2)) continue;
        const anchor = g.anchor;
        const index = this.removeStroke(g, s.id);
        if (index !== -1) erasing.op.removed.push({ groupId: g.id, anchor, index, stroke: s });
        if (!this.groups.has(g.id)) break;
      }
    }
  }

  private finishErase(): void {
    const erasing = this.erasing;
    if (!erasing) return;
    this.erasing = null;
    try {
      this.over.releasePointerCapture(erasing.pointerId);
    } catch {
      /* already released */
    }
    if (erasing.op.removed.length) {
      this.pushUndo(erasing.op);
      this.queueLayout();
    }
  }
}
