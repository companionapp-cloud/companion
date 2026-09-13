import type { CanvasSide } from "@companion/core-bridge";

/** Pure canvas geometry (PLAN-canvases.md §3.3): containment for group drags and the
 *  auto side pick for edges with no pinned side. Kept free of React so it can be unit
 *  tested on its own. Coordinates are absolute canvas units, top-left origin. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when `inner` lies entirely inside `outer` (touching edges count as inside). */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** True when the center of `inner` falls inside `outer` — the looser test used when a
 *  node is dropped onto a group so a slightly overhanging card still "joins" it. */
export function centerInside(outer: Rect, inner: Rect): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
}

/** Area of a rect, for picking the smallest containing group. */
export function area(r: Rect): number {
  return r.width * r.height;
}

/** The ids of every rect (other than the group itself) fully inside `group`. */
export function containedIds<T extends Rect & { id: string }>(group: T, rects: T[]): string[] {
  return rects.filter((r) => r.id !== group.id && contains(group, r)).map((r) => r.id);
}

/** The center point of a rect. */
export function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Picks the pair of sides an edge should leave and enter from when neither side is
 *  pinned: whichever axis the two centers are further apart on wins, so a card to the
 *  right connects right→left and a card below connects bottom→top. */
export function nearestSides(from: Rect, to: Rect): { fromSide: CanvasSide; toSide: CanvasSide } {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

/** Snaps a value to a grid step. */
export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** Bounding box of a set of rects, or null when empty. */
export function bounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
