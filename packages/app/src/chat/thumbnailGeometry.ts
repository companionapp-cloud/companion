import type { CanvasEdge, CanvasEnd, CanvasNode, CanvasSide } from "@companion/core-bridge";
import { bounds, nearestSides, type Rect } from "../canvas/geometry";

/** Pure geometry for the chat's read-only canvas miniature (CanvasThumbnail): fit a board into a
 *  box, project its nodes, and turn its edges into ready-to-draw SVG shapes in the box's own pixel
 *  space — so the web and native SVG layers only map shapes to elements. Mirrors the board's own
 *  drawing (CanvasView.web.tsx): auto sides for unpinned edges, curved/step/straight lines, and
 *  its four kinds of ending. */

/** Pixels kept clear around the content, whatever the scale — room for group labels notched
 *  into a top edge and for arrowheads. */
const MARGIN = 12;
/** The board's ending size (see CanvasView.web.tsx). */
const END_SIZE = 8;
const DOT_R = 3.5;

/** How a board maps into the miniature: box px = canvas units × scale + offset. */
export interface Fit {
  scale: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
}

/** Fits the board's content into a box `width` px wide, never enlarging it, at a height that
 *  follows the board's shape within [minHeight, maxHeight]; the content is centered. */
export function fitBoard(nodes: Rect[], width: number, minHeight: number, maxHeight: number): Fit | null {
  const b = bounds(nodes);
  if (!b || width <= MARGIN * 2) return null;
  const scale = Math.min((width - MARGIN * 2) / Math.max(b.width, 1), (maxHeight - MARGIN * 2) / Math.max(b.height, 1), 1);
  const height = Math.max(minHeight, Math.min(maxHeight, b.height * scale + MARGIN * 2));
  return {
    scale,
    dx: (width - b.width * scale) / 2 - b.x * scale,
    dy: (height - b.height * scale) / 2 - b.y * scale,
    width,
    height,
  };
}

/** A canvas rect in the miniature's pixels. */
export function project(r: Rect, f: Fit): Rect {
  return { x: r.x * f.scale + f.dx, y: r.y * f.scale + f.dy, width: r.width * f.scale, height: r.height * f.scale };
}

type Vec = { x: number; y: number };

const OUTWARD: Record<CanvasSide, Vec> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

function sideMidpoint(r: Rect, side: CanvasSide): Vec {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    default:
      return { x: r.x, y: r.y + r.height / 2 };
  }
}

const horizontal = (side: CanvasSide) => side === "left" || side === "right";
const fmt = (n: number) => Math.round(n * 10) / 10;

/** An edge ending, positioned in the miniature. Chevrons are stroked, triangles filled; dots are
 *  hollow or filled circles. */
export type EndMark =
  | { kind: "chevron"; d: string }
  | { kind: "triangle"; d: string }
  | { kind: "dot" | "dotFilled"; cx: number; cy: number; r: number };

export interface EdgeShape {
  id: string;
  d: string;
  /** The edge's own color; null means the board's default stroke. */
  color: string | null;
  marks: EndMark[];
  /** The point halfway along the line, where the board sets the edge's label. */
  mid: Vec;
  label: string;
}

/** The ending `end` drawn with its tip at `at`, pointing along `dir` (a unit vector). */
function endMark(end: CanvasEnd, at: Vec, dir: Vec, size: number): EndMark | null {
  // The chevron/triangle in the board's local frame (tip at 0,0 pointing +x), rotated onto dir.
  const pt = (x: number, y: number) => `${fmt(at.x + x * dir.x - y * dir.y)} ${fmt(at.y + x * dir.y + y * dir.x)}`;
  const s = size;
  switch (end) {
    case "arrow":
      return { kind: "chevron", d: `M ${pt(-s, -s / 2)} L ${pt(0, 0)} L ${pt(-s, s / 2)}` };
    case "arrowFilled":
      return { kind: "triangle", d: `M ${pt(0, 0)} L ${pt(-s, -s / 2)} L ${pt(-s + s / 4, 0)} L ${pt(-s, s / 2)} Z` };
    case "dot":
    case "dotFilled":
      return { kind: end, cx: fmt(at.x), cy: fmt(at.y), r: fmt((DOT_R * s) / END_SIZE) };
    default:
      return null;
  }
}

/** Every edge whose two nodes are on the board, as shapes in the miniature's pixels. */
export function edgeShapes(nodes: CanvasNode[], edges: CanvasEdge[], f: Fit): EdgeShape[] {
  const rects = new Map(nodes.map((n) => [n.id, project(n, f)]));
  // Endings shrink with the board, but never so far they stop reading as arrows.
  const size = Math.max(5, Math.min(END_SIZE, END_SIZE * f.scale * 1.5));
  const out: EdgeShape[] = [];
  for (const e of edges) {
    const from = rects.get(e.fromNodeId);
    const to = rects.get(e.toNodeId);
    if (!from || !to) continue;
    const auto = nearestSides(from, to);
    const fromSide = e.fromSide ?? auto.fromSide;
    const toSide = e.toSide ?? auto.toSide;
    const a = sideMidpoint(from, fromSide);
    const b = sideMidpoint(to, toSide);
    // Direction of travel as the line leaves the source and as it arrives at the target.
    let leave = OUTWARD[fromSide];
    let arrive = { x: -OUTWARD[toSide].x, y: -OUTWARD[toSide].y };
    let d: string;
    let mid: Vec = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    switch (e.style) {
      case "straight": {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        leave = arrive = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        d = `M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(b.x)} ${fmt(b.y)}`;
        break;
      }
      case "step": {
        if (horizontal(fromSide) && horizontal(toSide)) {
          const mx = (a.x + b.x) / 2;
          d = `M ${fmt(a.x)} ${fmt(a.y)} H ${fmt(mx)} V ${fmt(b.y)} H ${fmt(b.x)}`;
        } else if (!horizontal(fromSide) && !horizontal(toSide)) {
          const my = (a.y + b.y) / 2;
          d = `M ${fmt(a.x)} ${fmt(a.y)} V ${fmt(my)} H ${fmt(b.x)} V ${fmt(b.y)}`;
        } else if (horizontal(fromSide)) {
          d = `M ${fmt(a.x)} ${fmt(a.y)} H ${fmt(b.x)} V ${fmt(b.y)}`;
          mid = { x: b.x, y: a.y };
        } else {
          d = `M ${fmt(a.x)} ${fmt(a.y)} V ${fmt(b.y)} H ${fmt(b.x)}`;
          mid = { x: a.x, y: b.y };
        }
        break;
      }
      default: {
        // A bezier leaving and entering perpendicular to the sides, like the board's curves.
        const k = Math.max(8, Math.min(80, 0.4 * Math.hypot(b.x - a.x, b.y - a.y)));
        const c1 = { x: a.x + OUTWARD[fromSide].x * k, y: a.y + OUTWARD[fromSide].y * k };
        const c2 = { x: b.x + OUTWARD[toSide].x * k, y: b.y + OUTWARD[toSide].y * k };
        d = `M ${fmt(a.x)} ${fmt(a.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b.x)} ${fmt(b.y)}`;
        // The curve at t = ½.
        mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
      }
    }
    const marks: EndMark[] = [];
    // The source ending points back into the source node; the target ending into the target.
    const start = endMark(e.fromEnd, a, { x: -leave.x, y: -leave.y }, size);
    const end = endMark(e.toEnd, b, arrive, size);
    if (start) marks.push(start);
    if (end) marks.push(end);
    out.push({ id: e.id, d, color: e.color ?? null, marks, mid, label: e.label ?? "" });
  }
  return out;
}

/** A user swatch at the given alpha. Swatches are literal hex values, so the channel math is safe;
 *  theme roles are CSS variables on web and must never come through here. */
export function wash(hex: string | null | undefined, alpha: number): string | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
