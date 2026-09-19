import { getStroke } from "perfect-freehand";
import type { InkStroke } from "./types";

/** An input sample: x, y (CSS px) and pressure (0–1). */
export type InkPoint = [number, number, number];

// Stored points are delta-encoded integers: tenths of a pixel keep strokes crisp on 3x screens,
// percent is plenty for pressure, and small deltas keep the JSON short.
const XY = 10;
const PRESSURE = 100;

export function encodePoints(points: readonly InkPoint[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  let pp = 0;
  for (const [x, y, p] of points) {
    const ix = Math.round(x * XY);
    const iy = Math.round(y * XY);
    const ip = Math.round(Math.min(1, Math.max(0, p)) * PRESSURE);
    out.push(ix - px, iy - py, ip - pp);
    px = ix;
    py = iy;
    pp = ip;
  }
  return out;
}

export function decodePoints(flat: readonly number[]): InkPoint[] {
  const out: InkPoint[] = [];
  let x = 0;
  let y = 0;
  let p = 0;
  for (let i = 0; i + 2 < flat.length; i += 3) {
    x += flat[i];
    y += flat[i + 1];
    p += flat[i + 2];
    out.push([x / XY, y / XY, p / PRESSURE]);
  }
  return out;
}

/** Outline options per tool. The pen thins with pressure (real, or simulated from speed for a
 *  mouse or finger); the highlighter is a flat, even marker. */
function outlineOptions(stroke: Pick<InkStroke, "tool" | "width" | "sim">, complete: boolean) {
  if (stroke.tool === "highlighter") {
    return { size: stroke.width, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: complete };
  }
  return { size: stroke.width, thinning: 0.55, smoothing: 0.5, streamline: 0.4, simulatePressure: !!stroke.sim, last: complete };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** The SVG path of a stroke: perfect-freehand's outline polygon, smoothed with quadratic
 *  curves through the midpoints of its edges. */
export function strokePath(points: readonly InkPoint[], stroke: Pick<InkStroke, "tool" | "width" | "sim">, complete = true): string {
  if (points.length === 0) return "";
  const outline = getStroke(points as InkPoint[], outlineOptions(stroke, complete));
  const n = outline.length;
  if (n < 3) {
    // Degenerate outline (a tap): draw a dot.
    const [x, y] = points[0];
    const r = stroke.width / 2;
    return `M${f(x - r)},${f(y)}a${f(r)},${f(r)} 0 1,0 ${f(2 * r)},0a${f(r)},${f(r)} 0 1,0 ${f(-2 * r)},0Z`;
  }
  let d = `M${f(outline[0][0])},${f(outline[0][1])}Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    d += `${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)} `;
  }
  return d + "Z";
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounds of a stroke's points, grown by half its width so thick strokes are fully inside. */
export function pointsBox(points: readonly InkPoint[], width: number): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const r = width / 2 + 1;
  return { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r };
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Area of the overlap between two boxes (0 when disjoint). */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}

export function boxContains(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/** Whether (x, y) lies within `radius` of the polyline through `points`. */
export function nearPolyline(points: readonly InkPoint[], x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  if (points.length === 1) {
    const dx = points[0][0] - x;
    const dy = points[0][1] - y;
    return dx * dx + dy * dy <= r2;
  }
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + t * vx - x;
    const dy = ay + t * vy - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
