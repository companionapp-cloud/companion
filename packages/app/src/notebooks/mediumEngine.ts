import type { InkGroupRecord, InkState } from "@companion/editor";
import type { PageGeometry } from "./paper";
import { sherdShape, type MediumToolId, type NotebookMedium } from "./mediums";

// The pen-only surfaces of the ancient mediums (PLAN-notebooks.md §11). Each page is a
// heightfield the pen works on: a clay tablet is carved by a stylus and the clay it moves is
// pushed up into ridges beside and ahead of the groove; wax is scratched by a point that drags
// (curves come out angular) and curls a burr of wax up beside the line; a potsherd takes brushed
// ink that soaks into the fabric. A WebGL2 fragment shader lights the field with the medium's
// own material: mottled red clay, honey wax in a wooden frame, pottery fabrics with grit, slip,
// glaze and crazing.
//
// Marks are stored as strokes (one ink row each, the app's own format), already processed:
// a stroke is the list of dabs it laid down, so replaying it rebuilds the same field on every
// device. DOM and WebGL only, no React, so the native WebView bundle runs it unchanged.

/** Field cells per page px, per medium. A wax scratch is only 2 to 3 px wide, so wax gets the
 *  finest field; clay and pottery marks are broader. */
const RES: Record<Exclude<NotebookMedium, "paper">, number> = { clay: 2, wax: 3, sherd: 2 };
const H_MIN = -6;
const H_MAX = 4;

export interface MediumStrokeData extends Record<string, unknown> {
  v: 2;
  tool: MediumToolId;
  seed: number;
  /** When it was drawn, for replay order. */
  t: number;
  /** Dabs: x, y, a, b per dab, in page px (a and b are the tool's radius and strength). */
  p: number[];
}

// ---- randomness --------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---- the field ---------------------------------------------------------------------------

/** A rectangle of cells: x0, y0, x1, y1 (end exclusive). */
type Box = [number, number, number, number];

class Field {
  readonly w: number;
  readonly h: number;
  readonly res: number;
  /** Height in page px; 0 is the untouched surface. */
  readonly height: Float32Array;
  /** Brushed ink: carbon black and red ochre, 0..1. Empty unless the medium takes ink. */
  readonly black: Float32Array;
  readonly red: Float32Array;
  readonly inked: boolean;
  dirty: [number, number, number, number] | null = null;

  constructor(geom: PageGeometry, res: number, inked: boolean) {
    this.res = res;
    this.inked = inked;
    this.w = Math.ceil(geom.width * res);
    this.h = Math.ceil(geom.height * res);
    this.height = new Float32Array(this.w * this.h);
    this.black = new Float32Array(inked ? this.w * this.h : 0);
    this.red = new Float32Array(inked ? this.w * this.h : 0);
    this.markAll();
  }

  clear() {
    this.height.fill(0);
    this.black.fill(0);
    this.red.fill(0);
    this.markAll();
  }

  markAll() {
    this.dirty = [0, 0, this.w, this.h];
  }

  /** The cell box around a page-px circle, clipped; marks it dirty. */
  private box(x: number, y: number, r: number): [number, number, number, number] | null {
    const x0 = Math.max(0, Math.floor((x - r) * this.res));
    const y0 = Math.max(0, Math.floor((y - r) * this.res));
    const x1 = Math.min(this.w, Math.ceil((x + r) * this.res) + 1);
    const y1 = Math.min(this.h, Math.ceil((y + r) * this.res) + 1);
    if (x0 >= x1 || y0 >= y1) return null;
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
    return [x0, y0, x1, y1];
  }

  /** Press a round tip in to depth `depth`, and push the clay it moves out of the way: into a
   *  ring round the tip, most of it ahead (dir) and beside, none behind into the groove just
   *  made. `side` (-1..1) leans the ring to one side of the line (wax curls up on one side). */
  carve(x: number, y: number, r: number, depth: number, dx: number, dy: number, push: number, side = 0, slump = 0) {
    const reach = r * 2.3;
    const b = this.box(x, y, reach);
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    const H = this.height;
    let removed = 0;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const px = cx / this.res - x;
        const py = cy / this.res - y;
        const d2 = px * px + py * py;
        if (d2 >= r * r) continue;
        // A soft, rounded bottom: the reed's tip, then clay slumping back a little.
        const target = -depth * (Math.exp((-2.6 * d2) / (r * r)) - 0.074 * (d2 / (r * r))) / 0.926;
        const i = cy * this.w + cx;
        if (H[i] > target) {
          removed += H[i] - target;
          H[i] = target;
        }
      }
    }
    if (removed <= 0 || push <= 0) return;
    // Where the moved clay goes.
    let total = 0;
    const weights: number[] = [];
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const px = cx / this.res - x;
        const py = cy / this.res - y;
        const d = Math.sqrt(px * px + py * py);
        let w = 0;
        if (d > r && d < reach) {
          const ring = Math.exp(-(((d - r * 1.45) / (r * 0.45)) ** 2));
          const ahead = (px * dx + py * dy) / d;
          const across = (px * -dy + py * dx) / d;
          w = ring * Math.max(0, Math.min(1, 0.6 + 0.8 * ahead)) * (1 + side * across);
        }
        weights.push(w);
        total += w;
      }
    }
    if (total <= 0) return;
    const k = (removed * push) / total;
    let j = 0;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++, j++) {
        const w = weights[j];
        if (!w) continue;
        const i = cy * this.w + cx;
        H[i] = Math.min(H_MAX, H[i] + w * k);
      }
    }
    this.slump(x0, y0, x1, y1, x, y, r, slump);
  }

  /** Soft material slumps: round off the lip of a fresh groove so no wall stands sheer.
   *  Only cells near the tip's rim move. */
  private slump(x0: number, y0: number, x1: number, y1: number, x: number, y: number, r: number, amount: number) {
    if (amount <= 0) return;
    const H = this.height;
    const W = this.w;
    for (let cy = Math.max(1, y0); cy < Math.min(this.h - 1, y1); cy++) {
      for (let cx = Math.max(1, x0); cx < Math.min(W - 1, x1); cx++) {
        const d = Math.hypot(cx / this.res - x, cy / this.res - y);
        if (d < r * 0.55 || d > r * 2.1) continue;
        const i = cy * W + cx;
        const avg = (H[i - 1] + H[i + 1] + H[i - W] + H[i + W]) * 0.25;
        H[i] += (avg - H[i]) * amount;
      }
    }
  }

  /** A wedge: the corner of a square-cut reed pressed in and drawn along (cuneiform). Deep and
   *  wide at the head, tapering to a tail; the clay it displaces rises round its outline. */
  wedge(x0: number, y0: number, x1: number, y1: number, width: number, depth: number): Box | null {
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.max(1, Math.hypot(dx, dy));
    dx /= len;
    dy /= len;
    const reach = len + width + 4;
    const b = this.box((x0 + x1) / 2, (y0 + y1) / 2, reach / 2 + width);
    if (!b) return null;
    const [bx0, by0, bx1, by1] = b;
    const H = this.height;
    let removed = 0;
    const rim: number[] = [];
    let rimTotal = 0;
    for (let cy = by0; cy < by1; cy++) {
      for (let cx = bx0; cx < bx1; cx++) {
        const px = cx / this.res - x0;
        const py = cy / this.res - y0;
        const u = px * dx + py * dy;
        const v = px * -dy + py * dx;
        const t = u / len;
        const half = (width / 2) * Math.pow(Math.max(0, 1 - t), 0.85) + 0.5;
        const i = cy * this.w + cx;
        // The head is a triangle: the reed's corner goes in deepest at the start.
        const inside = u >= -width * 0.25 && t <= 1 && Math.abs(v) < half;
        if (inside) {
          const head = u < 0 ? 1 + u / (width * 0.25) : 1;
          const target = -depth * (1 - 0.65 * Math.max(0, t)) * (1 - Math.abs(v) / half) * head;
          if (H[i] > target) {
            removed += H[i] - target;
            H[i] = target;
          }
          rim.push(0);
        } else {
          // Distance outside the wedge's outline, roughly.
          const tu = Math.max(-width * 0.25, Math.min(len, u));
          const hw = (width / 2) * Math.pow(Math.max(0, 1 - tu / len), 0.85) + 0.5;
          const out = Math.hypot(u - tu, Math.max(0, Math.abs(v) - hw));
          const w = out < 5 ? Math.exp(-(((out - 1.4) / 1.1) ** 2)) : 0;
          rim.push(w);
          rimTotal += w;
        }
      }
    }
    if (removed <= 0 || rimTotal <= 0) return b;
    const k = (removed * 0.8) / rimTotal;
    let j = 0;
    for (let cy = by0; cy < by1; cy++) {
      for (let cx = bx0; cx < bx1; cx++, j++) {
        if (!rim[j]) continue;
        const i = cy * this.w + cx;
        H[i] = Math.min(H_MAX, H[i] + rim[j] * k);
      }
    }
    return b;
  }

  /** Put back a rectangle of height from a copy taken earlier (a wedge preview moving). */
  restore(from: Float32Array, b: Box) {
    const [x0, y0, x1, y1] = b;
    for (let y = y0; y < y1; y++) this.height.set(from.subarray(y * this.w + x0, y * this.w + x1), y * this.w + x0);
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
  }

  /** Rub the surface flat (a thumb on clay, the stylus's spatula end on wax). `print` leaves a
   *  faint fingerprint. */
  smooth(x: number, y: number, r: number, amount: number, print: boolean) {
    const b = this.box(x, y, r);
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    const H = this.height;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const px = cx / this.res - x;
        const py = cy / this.res - y;
        const d = Math.sqrt(px * px + py * py);
        if (d >= r) continue;
        const f = amount * (1 - (d / r) ** 2);
        const i = cy * this.w + cx;
        H[i] *= 1 - f;
        if (print) H[i] += 0.05 * f * Math.sin(d * 2.6 + px * 0.4);
      }
    }
  }

  /** A small raised crumb (wax swarf at the end of a scratch). */
  bump(x: number, y: number, r: number, height: number) {
    const b = this.box(x, y, r);
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const d2 = (cx / this.res - x) ** 2 + (cy / this.res - y) ** 2;
        if (d2 >= r * r) continue;
        const i = cy * this.w + cx;
        this.height[i] = Math.min(H_MAX, this.height[i] + height * (1 - d2 / (r * r)));
      }
    }
  }

  /** A reed brush dab: ink laid through separate bristles, which run dry as the load drops,
   *  so a stroke fades into streaks. */
  ink(x: number, y: number, r: number, load: number, red: boolean, dx: number, dy: number, seed: number) {
    if (!this.inked) return;
    const b = this.box(x, y, r * 1.2);
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    const C = red ? this.red : this.black;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const px = cx / this.res - x;
        const py = cy / this.res - y;
        const d = Math.sqrt(px * px + py * py);
        if (d >= r * 1.2) continue;
        const across = px * -dy + py * dx;
        const bristle = Math.floor(((across / r) * 0.5 + 0.5) * 9);
        const bh = hash2(bristle, 7, seed);
        if (bh > load * 1.5) continue;
        const f = d < r * 0.6 ? 1 : Math.max(0, 1 - (d - r * 0.6) / (r * 0.6));
        const i = cy * this.w + cx;
        const amt = 0.55 * f * (0.55 + 0.45 * bh) * Math.min(1, load + 0.3);
        C[i] += amt * (1 - C[i]);
      }
    }
  }

  /** Scrape ink off with a blade: it lifts most of it and scores the surface a little. */
  scrape(x: number, y: number, r: number) {
    if (!this.inked) return;
    const b = this.box(x, y, r);
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const d2 = (cx / this.res - x) ** 2 + (cy / this.res - y) ** 2;
        if (d2 >= r * r) continue;
        const f = 1 - d2 / (r * r);
        const i = cy * this.w + cx;
        this.black[i] *= 1 - 0.5 * f;
        this.red[i] *= 1 - 0.5 * f;
        this.height[i] = Math.max(H_MIN, this.height[i] - 0.04 * f);
      }
    }
  }
}

// ---- tools: input to dabs, and dabs to the field -----------------------------------------

/** Apply one dab of a stroke (shared by live drawing and replay, so both give the same field). */
function applyDab(field: Field, tool: MediumToolId, p: number[], i: number, seed: number) {
  const x = p[i];
  const y = p[i + 1];
  const a = p[i + 2];
  const b = p[i + 3];
  let dx = 1;
  let dy = 0;
  if (i >= 4) {
    const ddx = x - p[i - 4];
    const ddy = y - p[i - 3];
    const l = Math.hypot(ddx, ddy);
    if (l > 0.01) {
      dx = ddx / l;
      dy = ddy / l;
    }
  } else if (p.length >= 8) {
    const ddx = p[4] - x;
    const ddy = p[5] - y;
    const l = Math.hypot(ddx, ddy);
    if (l > 0.01) {
      dx = ddx / l;
      dy = ddy / l;
    }
  }
  switch (tool) {
    case "stylus":
      field.carve(x, y, a, b, dx, dy, 1, 0, 0.5);
      break;
    case "point":
      field.carve(x, y, a, b, dx, dy, 1.1, 0.55, 0.15);
      break;
    case "thumb":
      field.smooth(x, y, a, b, true);
      break;
    case "flat":
      field.smooth(x, y, a, b, false);
      break;
    case "black":
    case "red":
      field.ink(x, y, a, b, tool === "red", dx, dy, seed);
      break;
    case "scrape":
      field.scrape(x, y, a);
      break;
    case "wedge":
      break;
  }
}

/** Replay a stored stroke onto the field. */
function replay(field: Field, s: MediumStrokeData) {
  const p = s.p;
  if (s.tool === "wedge") {
    if (p.length >= 8) field.wedge(p[0], p[1], p[4], p[5], p[2], p[3]);
    return;
  }
  for (let i = 0; i + 3 < p.length; i += 4) applyDab(field, s.tool, p, i, s.seed);
  finish(field, s);
}

/** What a stroke leaves when the tool lifts: crumbs of wax swarf at the end of a scratch. */
function finish(field: Field, s: MediumStrokeData) {
  if (s.tool !== "point" || s.p.length < 8) return;
  const r = rng(s.seed);
  const n = s.p.length;
  const x = s.p[n - 4];
  const y = s.p[n - 3];
  const count = 1 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) field.bump(x + (r() - 0.5) * 7, y + (r() - 0.5) * 7, 0.7 + r() * 0.9, 0.5 + r() * 0.5);
}

/** Turns pointer samples into dabs, live. Each tool has its own feel. */
class StrokeBuilder {
  readonly data: MediumStrokeData;
  private tip: { x: number; y: number } | null = null;
  private dir: { x: number; y: number } | null = null;
  private last: { x: number; y: number; t: number } | null = null;
  private travelled = 0;
  private start: { x: number; y: number } | null = null;
  end: { x: number; y: number } | null = null;
  /** Wedge: the field before the press, and where the live preview was stamped. */
  private backup: Float32Array | null = null;
  private previewBox: Box | null = null;

  constructor(
    readonly tool: MediumToolId,
    private field: Field,
    /** The tool's size: a multiplier on its width (fine, medium, broad). */
    private size = 1,
  ) {
    this.data = { v: 2, tool, seed: (Math.random() * 4294967295) >>> 0, t: Date.now(), p: [] };
  }

  add(x: number, y: number, pressure: number, time: number) {
    if (this.tool === "wedge") {
      if (!this.start) this.start = { x, y };
      this.end = { x, y };
      // Show the wedge where it would go while the reed is still down: put the clay back from
      // the last preview and press again at the new angle and length.
      if (this.previewBox && this.backup) this.field.restore(this.backup, this.previewBox);
      else this.backup = this.field.height.slice();
      const g = this.wedgeGeom();
      if (g) this.previewBox = this.field.wedge(g.x0, g.y0, g.x1, g.y1, g.width, g.depth);
      return;
    }
    if (!this.tip) {
      this.tip = { x, y };
      this.last = { x, y, t: time };
      this.dab(x, y, pressure, 0);
      return;
    }
    let tx = x;
    let ty = y;
    if (this.tool === "point") {
      // The stylus drags in the wax: the tip trails the hand on a short rope, and it holds its
      // line until the hand pulls it more than ~20° off, then jerks round. Curves come out as
      // runs of straight scratches, the way Roman cursive looks.
      const ROPE = 4;
      const mx = x - this.tip.x;
      const my = y - this.tip.y;
      const dist = Math.hypot(mx, my);
      if (dist <= ROPE) return;
      let vx = (mx / dist) * (dist - ROPE);
      let vy = (my / dist) * (dist - ROPE);
      const vl = Math.hypot(vx, vy);
      if (this.dir) {
        const cos = (vx * this.dir.x + vy * this.dir.y) / vl;
        if (cos > Math.cos(0.36)) {
          const along = vx * this.dir.x + vy * this.dir.y;
          vx = this.dir.x * along;
          vy = this.dir.y * along;
        } else this.dir = { x: vx / vl, y: vy / vl };
      } else this.dir = { x: vx / vl, y: vy / vl };
      tx = this.tip.x + vx;
      ty = this.tip.y + vy;
    } else {
      // A light lag everywhere else, to steady the hand.
      const k = this.tool === "stylus" ? 0.55 : 0.7;
      tx = this.tip.x + (x - this.tip.x) * k;
      ty = this.tip.y + (y - this.tip.y) * k;
    }
    const speed = this.last ? Math.hypot(x - this.last.x, y - this.last.y) / Math.max(1, time - this.last.t) : 0;
    this.last = { x, y, t: time };
    // Walk from the tip to the target, a dab every little way.
    const spacing = this.spacing(pressure);
    const sx = this.tip.x;
    const sy = this.tip.y;
    const seg = Math.hypot(tx - sx, ty - sy);
    const steps = Math.floor(seg / spacing);
    for (let s = 1; s <= steps; s++) {
      const f = (s * spacing) / seg;
      this.travelled += spacing;
      this.dab(sx + (tx - sx) * f, sy + (ty - sy) * f, pressure, speed);
    }
    if (steps > 0) {
      const f = (steps * spacing) / seg;
      this.tip = { x: sx + (tx - sx) * f, y: sy + (ty - sy) * f };
    }
  }

  private spacing(pressure: number): number {
    return this.baseSpacing(pressure) * Math.max(0.6, this.size);
  }

  private baseSpacing(pressure: number): number {
    switch (this.tool) {
      case "stylus":
        return 0.7 + pressure * 0.4;
      case "point":
        return 0.45;
      case "thumb":
        return 2.5;
      case "flat":
        return 2;
      case "scrape":
        return 1.2;
      default:
        return 0.9;
    }
  }

  private dab(x: number, y: number, pressure: number, speed: number) {
    let a = 0;
    let b = 0;
    switch (this.tool) {
      case "stylus":
        a = 2.2 + 2.4 * pressure;
        b = 1.8 + 2.8 * pressure;
        break;
      case "point":
        a = 1.1 + 0.9 * pressure;
        // Chatter: the point skips a little as it cuts.
        b = (1.2 + 1.1 * pressure) * (0.82 + 0.18 * Math.sin(this.travelled * 1.3));
        break;
      case "thumb":
        a = 8 + 6 * pressure;
        b = 0.22;
        break;
      case "flat":
        a = 6 + 5 * pressure;
        b = 0.3;
        break;
      case "black":
      case "red": {
        // A reed brush: thinner when flicked fast, and it runs dry.
        const fast = Math.max(0.5, Math.min(1.25, 1.3 - speed * 0.35));
        a = (1.3 + 2.8 * pressure) * fast;
        b = Math.max(0.12, 1 - this.travelled / 650);
        break;
      }
      case "scrape":
        a = 5;
        b = 0;
        break;
    }
    // Size widens the tool; a wider tip also presses a little deeper.
    a *= this.size;
    if (this.tool === "stylus" || this.tool === "point") b *= Math.sqrt(this.size);
    const p = this.data.p;
    p.push(round1(x), round1(y), round2(a), round2(b));
    applyDab(this.field, this.tool, p, p.length - 4, this.data.seed);
  }

  /** Where the wedge goes: from the press, along the drag. A tap gives a small upright wedge;
   *  a drag sets its direction and length. */
  private wedgeGeom(): { x0: number; y0: number; x1: number; y1: number; width: number; depth: number } | null {
    const s = this.start;
    if (!s) return null;
    const e = this.end ?? s;
    let dx = e.x - s.x;
    let dy = e.y - s.y;
    let len = Math.hypot(dx, dy);
    if (len < 2) {
      dx = 0;
      dy = 1;
      len = 14 * this.size;
    } else {
      dx /= len;
      dy /= len;
      len = Math.max(5 * this.size, Math.min(34 * this.size, len));
    }
    const x0 = round1(s.x);
    const y0 = round1(s.y);
    const width = round2(Math.max(5 * this.size, Math.min(12 * this.size, len * 0.55)));
    return { x0, y0, x1: round1(x0 + dx * len), y1: round1(y0 + dy * len), width, depth: round2(WEDGE_DEPTH * Math.sqrt(this.size)) };
  }

  /** Lift the tool. Returns false when nothing was drawn. */
  close(): boolean {
    if (this.tool === "wedge") {
      const g = this.wedgeGeom();
      if (this.previewBox && this.backup) this.field.restore(this.backup, this.previewBox);
      this.backup = null;
      this.previewBox = null;
      if (!g) return false;
      this.data.p = [g.x0, g.y0, g.width, g.depth, g.x1, g.y1, 0, 0];
      this.field.wedge(g.x0, g.y0, g.x1, g.y1, g.width, g.depth);
      return true;
    }
    if (!this.data.p.length) return false;
    finish(this.field, this.data);
    return true;
  }
}

const WEDGE_DEPTH = 3.2;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

// ---- shape masks -------------------------------------------------------------------------

/** A sherd's outline at field resolution: its polygon with every edge broken into jagged
 *  fracture and a few chips taken out, softened so the edge reads as a rounded break. */
function sherdMask(pageId: string, geom: PageGeometry, w: number, h: number, res: number): Uint8Array {
  const shape = sherdShape(pageId);
  const r = rng(seedOf(pageId) ^ 0x9e3779b9);
  const pts = shape.points.map(([px, py]) => [(0.5 + (px / 100 - 0.5) * 0.92) * geom.width * res, (0.5 + (py / 100 - 0.5) * 0.9) * geom.height * res]);
  // Fracture: midpoint displacement along each edge.
  const jag: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    let line = [a, b];
    let amp = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.05;
    for (let depth = 0; depth < 5; depth++) {
      const next: number[][] = [line[0]];
      for (let k = 0; k < line.length - 1; k++) {
        const p = line[k];
        const q = line[k + 1];
        const nx = -(q[1] - p[1]);
        const ny = q[0] - p[0];
        const nl = Math.hypot(nx, ny) || 1;
        const off = (r() - 0.5) * 2 * amp;
        next.push([(p[0] + q[0]) / 2 + (nx / nl) * off, (p[1] + q[1]) / 2 + (ny / nl) * off], q);
      }
      line = next;
      amp *= 0.55;
    }
    jag.push(...line.slice(0, -1));
  }
  const cnv = document.createElement("canvas");
  cnv.width = w;
  cnv.height = h;
  const ctx = cnv.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  jag.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  // Chips: bites out of the edge.
  ctx.globalCompositeOperation = "destination-out";
  const chips = 2 + Math.floor(r() * 4);
  for (let i = 0; i < chips; i++) {
    const [cx, cy] = jag[Math.floor(r() * jag.length)];
    ctx.beginPath();
    ctx.ellipse(cx, cy, (2 + r() * 6) * res, (1.3 + r() * 4) * res, r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const src = ctx.getImageData(0, 0, w, h).data;
  let m: Float32Array = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = src[i * 4 + 3] / 255;
  // Two box-blur passes soften the break into a bevel.
  for (let pass = 0; pass < 2; pass++) m = boxBlur(m, w, h, Math.round(2 * res));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(m[i] * 255);
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// ---- the shader --------------------------------------------------------------------------

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uField;   // r: height (page px), g: black ink, b: red ink
uniform sampler2D uMask;    // sherd outline
uniform vec2 uSize;         // page px
uniform int uMedium;        // 1 clay, 2 wax, 3 sherd
uniform float uSeed;
uniform int uVariant;       // sherd fabric
uniform float uSide;        // wax: cord holes on the left (-1) or right (1) edge
uniform float uFrame;       // wax frame width
uniform vec2 uWheel;        // sherd: direction of the throwing lines
uniform float uPx;          // page px per device pixel

const vec3 L = normalize(vec3(-0.55, -0.72, 0.78));

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// Small round grains scattered on a grid of cells: 0..1 coverage.
float speck(vec2 p, float cell, float thr) {
  vec2 c = floor(p / cell);
  if (hash(c + uSeed) < thr) return 0.0;
  vec2 o = (vec2(hash(c + 1.3), hash(c + 2.7)) * 0.6 + 0.2) * cell;
  float r = cell * (0.12 + 0.18 * hash(c + 4.1));
  return 1.0 - smoothstep(r * 0.6, r * 1.25, length(p - c * cell - o));
}
// Distance to the nearest crack of a cell pattern (glaze crazing).
float crackle(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = vec2(hash(i + g + uSeed), hash(i + g + 7.7 + uSeed));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}

vec3 field(vec2 p) { return texture(uField, p / uSize).rgb; }
float mask(vec2 p) { return texture(uMask, p / uSize).r; }

float clayShape(vec2 p) {
  vec2 c = uSize * 0.5;
  float r = 30.0 + 10.0 * hash(vec2(uSeed, 3.0));
  float d = sdBox(p - c, c - vec2(4.0), r);
  return d + (fbm(p * 0.025 + uSeed) - 0.5) * 7.0;
}

// 1 at the middle of each period of x, falling to 0 over w (a band, a groove, a painted line).
float band(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(fract(x) - 0.5)); }

// Relief some fabrics carry: turned grooves, shell and cord impressions, rouletting, the
// orange-peel skin of salt glaze. In page px, added to the sherd's surface.
float sherdRelief(vec2 p) {
  float bu = dot(p, uWheel);
  float bv = dot(p, vec2(-uWheel.y, uWheel.x));
  float ph = hash(vec2(uSeed, 1.0));
  if (uVariant == 10) return -0.45 * band(bu * 0.014 + ph, 0.02) - 0.3 * band(bu * 0.014 + ph + 0.06, 0.015);
  if (uVariant == 15) {
    // Cardium: rows of cockle-shell edge pressed in, in wide bands.
    vec2 q = vec2(fract(bv / 7.0) - 0.5, fract(bu / 10.0) - 0.5);
    float dimple = smoothstep(0.38, 0.0, length(q * vec2(1.0, 1.7)));
    return -0.9 * dimple * step(fract(bu * 0.012 + ph), 0.62);
  }
  if (uVariant == 16) {
    // A twisted cord rolled across the wet surface.
    float twist = sin((bv + bu * 0.9) * 0.8 + sin(bu * 0.25) * 1.5);
    return -0.45 * smoothstep(0.2, 1.0, twist) * step(fract(bu * 0.018 + ph), 0.85);
  }
  if (uVariant == 17) return (noise(p * 0.9) - 0.5) * 0.3;
  if (uVariant == 22) {
    // Rouletting: a notched wheel run round the pot, leaving rows of small chevrons.
    vec2 q = vec2(fract(bv / 4.0) - 0.5, fract(bu * 0.09) - 0.5);
    float dent = smoothstep(0.14, 0.0, abs(abs(q.x) * 1.3 - q.y - 0.12));
    float inBand = step(0.25, fract(bu * 0.013 + ph)) * step(fract(bu * 0.013 + ph), 0.55);
    return -0.6 * dent * inBand;
  }
  return 0.0;
}

// The object's own shape and surface, before any marks.
float baseHeight(vec2 p) {
  vec2 c = uSize * 0.5;
  if (uMedium == 1) {
    float d = clayShape(p);
    float inside = clamp(-d / 42.0, 0.0, 1.0);
    float dome = 8.0 * (1.0 - (1.0 - inside) * (1.0 - inside));
    vec2 q = (p - c) / c;
    float pillow = 3.5 * (1.0 - dot(q, q) * 0.5);
    // Hand-smoothed lumps, then fine grain.
    return dome + pillow + (fbm(p * 0.045 + uSeed) - 0.5) * 1.6 + (fbm(p * 0.35 + uSeed) - 0.5) * 0.35 + noise(p * 1.9) * 0.08;
  }
  if (uMedium == 2) {
    float d = sdBox(p - c, c - vec2(uFrame), 3.0);
    float grain = (fbm(vec2(p.x * 0.9, p.y * 0.035) + uSeed) - 0.5) * 0.35;
    float frame = 3.4 * smoothstep(-0.5, 3.5, d) + grain * step(0.0, d);
    // The wax sits a little low against the frame (it shrinks as it cools), with faint
    // scratches from every earlier smoothing.
    float ghosts = (noise(vec2(p.x * 0.9 + p.y * 0.5, p.y * 0.05) + uSeed) - 0.5) * 0.03;
    // Long strokes of the spatula that levelled it last, then the faintest ripple.
    float strokes = (noise(vec2(p.x * 0.012 + p.y * 0.004, p.y * 0.1) + uSeed) - 0.5) * 0.07;
    float wax = -0.7 * exp(d / 5.0) + strokes + (fbm(p * 0.05 + uSeed) - 0.5) * 0.12 + ghosts;
    return d > 0.0 ? frame : wax;
  }
  float m = mask(p);
  float wheel = sin(dot(p, uWheel) * 0.42 + fbm(p * 0.02) * 6.0) * 0.12;
  return m * 3.0 + (wheel + (fbm(p * 0.1 + uSeed) - 0.5) * 0.5 + sherdRelief(p)) * m;
}

float heightAt(vec2 p) { return baseHeight(p) + field(p).r; }

void main() {
  vec2 p = vUv * uSize;
  vec3 f = field(p);
  // Clay is soft: its slopes are read over a wider step, so impressions round off.
  float e = uMedium == 1 ? 1.5 : uMedium == 2 ? 0.4 : 0.8;
  float hx = heightAt(p + vec2(e, 0.0)) - heightAt(p - vec2(e, 0.0));
  float hy = heightAt(p + vec2(0.0, e)) - heightAt(p - vec2(0.0, e));
  float relief = uMedium == 2 ? 1.25 : 1.6;
  vec3 n = normalize(vec3(-hx / (2.0 * e) * relief, -hy / (2.0 * e) * relief, 1.0));
  float ndl = dot(n, L);
  vec3 hv = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n, hv), 0.0);
  // Marks sit in shadow: a groove is darker than its slope alone would make it.
  float cavity = clamp(1.0 + f.r * (uMedium == 1 ? 0.13 : 0.1), 0.5, 1.08);

  vec3 col;
  float alpha = 1.0;

  if (uMedium == 1) {
    float d = clayShape(p);
    alpha = clamp(0.5 - d / (uPx * 1.5), 0.0, 1.0);
    // Red clay, mottled, with grit.
    float m1 = fbm(p * 0.018 + uSeed);
    float m2 = fbm(p * 0.14 + 3.0);
    vec3 alb = mix(vec3(0.55, 0.25, 0.16), vec3(0.74, 0.39, 0.25), m1);
    alb *= 0.9 + 0.2 * m2;
    alb = mix(alb, vec3(0.9, 0.8, 0.66), speck(p, 2.4, 0.965) * 0.45);
    alb *= 1.0 - speck(p + 91.0, 3.1, 0.975) * 0.35;
    // Freshly cut clay is wetter and darker; the pushed-up lips dry lighter.
    alb *= 1.0 + clamp(f.r, 0.0, 2.5) * 0.06 - clamp(-f.r, 0.0, 4.0) * 0.05;
    float wrap = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
    float spec = pow(nh, 22.0) * 0.13;
    col = alb * (0.34 + 0.8 * wrap) * cavity + vec3(1.0, 0.92, 0.85) * spec;
    // The rim rolls away into shade.
    col *= 0.78 + 0.22 * smoothstep(0.0, -18.0, d);
  } else if (uMedium == 2) {
    vec2 c = uSize * 0.5;
    float outer = sdBox(p - c, c - vec2(1.0), 5.0);
    alpha = clamp(0.5 - outer / (uPx * 1.5), 0.0, 1.0);
    float d = sdBox(p - c, c - vec2(uFrame), 3.0);
    if (d > 0.0) {
      // The board: long grain with growth rings wandering through it.
      float gr = fbm(vec2(p.x * 0.7, p.y * 0.025) + uSeed);
      float rings = sin((p.x + fbm(p * 0.015 + uSeed) * 60.0) * 0.32);
      vec3 wood = mix(vec3(0.40, 0.24, 0.12), vec3(0.66, 0.45, 0.25), gr * 0.75 + 0.25 * (rings * 0.5 + 0.5));
      wood *= 0.88 + 0.12 * noise(vec2(p.x * 3.0, p.y * 0.2));
      float lit = clamp((ndl + 0.2) / 1.2, 0.0, 1.0);
      col = wood * (0.36 + 0.78 * lit) + vec3(1.0, 0.9, 0.8) * pow(nh, 30.0) * 0.1;
      // Cord holes at the spine.
      float hx0 = uSide > 0.0 ? uSize.x - uFrame * 0.5 : uFrame * 0.5;
      float hole = min(length(p - vec2(hx0, uSize.y * 0.32)), length(p - vec2(hx0, uSize.y * 0.68)));
      col = mix(vec3(0.07, 0.04, 0.02), col, smoothstep(3.2, 4.4, hole));
      col *= mix(0.7, 1.0, smoothstep(3.0, 7.0, hole));
    } else {
      // Beeswax: honey-coloured, a little translucent, with a soft sheen.
      float m1 = fbm(p * 0.012 + uSeed);
      vec3 alb = mix(vec3(0.91, 0.72, 0.36), vec3(0.96, 0.80, 0.46), m1);
      // The bottom of a scratch is deeper amber; the curled burr is paler.
      alb = mix(alb, vec3(0.5, 0.29, 0.08), clamp(-f.r * 0.9, 0.0, 1.0) * 0.8);
      alb = mix(alb, vec3(0.99, 0.9, 0.66), clamp(f.r * 0.8, 0.0, 1.0) * 0.5);
      float wrap = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);
      vec3 glow = vec3(0.35, 0.18, 0.02) * (1.0 - wrap) * 0.35;
      // Wax is glossy: a tight highlight and a broad sheen from the room.
      float spec = pow(nh, 70.0) * 0.35 + pow(nh, 8.0) * 0.06;
      vec3 room = mix(vec3(1.0, 0.97, 0.9), vec3(0.6, 0.5, 0.35), clamp(p.y / uSize.y, 0.0, 1.0));
      float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.0);
      col = alb * (0.4 + 0.7 * wrap) * cavity + glow + vec3(1.0, 0.95, 0.85) * spec + room * fres * 0.25;
      col *= 0.82 + 0.18 * smoothstep(0.0, -10.0, d);
    }
  } else {
    // A sherd: the top face where the mask is, and its broken edge showing below-right.
    float m = mask(p);
    vec2 t = vec2(3.0, 4.6);
    float top = smoothstep(0.42, 0.58, m);
    float depthIn = 0.0;
    for (int k = 1; k <= 4; k++) {
      if (depthIn == 0.0 && mask(p - t * float(k) / 4.0) > 0.5) depthIn = float(k) / 4.0;
    }
    float sideA = depthIn > 0.0 ? 1.0 : 0.0;
    alpha = max(top, sideA);

    vec3 body, core, glazeCol = vec3(0.0);
    float glaze = 0.0;
    float lustre = 0.0;
    float mottle = fbm(p * 0.02 + uSeed);
    int v = uVariant;
    // Round the pot (bands) and along it: painted decoration follows the wheel.
    float bu = dot(p, uWheel);
    float bv = dot(p, vec2(-uWheel.y, uWheel.x));
    float ph = hash(vec2(uSeed, 1.0));
    vec3 buff = mix(vec3(0.83, 0.71, 0.53), vec3(0.9, 0.8, 0.63), mottle);
    if (v == 0) { body = mix(vec3(0.66, 0.33, 0.19), vec3(0.78, 0.45, 0.28), mottle); core = vec3(0.34, 0.31, 0.3); }
    else if (v == 1) { body = mix(vec3(0.80, 0.68, 0.50), vec3(0.90, 0.80, 0.63), mottle); core = vec3(0.78, 0.58, 0.42); }
    else if (v == 2) { body = mix(vec3(0.42, 0.41, 0.39), vec3(0.58, 0.56, 0.53), mottle); core = vec3(0.3, 0.29, 0.28); }
    else if (v == 3) { body = vec3(0.74, 0.42, 0.26); core = vec3(0.7, 0.4, 0.25); glazeCol = vec3(0.035, 0.03, 0.03); glaze = 1.0 - smoothstep(0.66, 0.7, fbm(p * 0.035 + uSeed + 9.0)); }
    else if (v == 4) { body = buff; core = vec3(0.8, 0.62, 0.45); glazeCol = vec3(0.30, 0.42, 0.14); glaze = smoothstep(0.28, 0.36, fbm(p * 0.018 + uSeed + 4.0)); }
    else if (v == 5) {
      body = buff; core = vec3(0.82, 0.6, 0.44);
      // Slip-painted bands round the pot, and a row of dots.
      float bnd = fract(bu * 0.016 + ph);
      float paint = step(0.12, bnd) * step(bnd, 0.22) + step(0.5, bnd) * step(bnd, 0.54);
      float dots = step(length(fract(vec2(bv * 0.06, bnd * 12.0)) - 0.5), 0.28) * step(0.3, bnd) * step(bnd, 0.38);
      paint = clamp(paint + dots, 0.0, 1.0) * (0.75 + 0.25 * noise(p * 0.5));
      body = mix(body, vec3(0.27, 0.13, 0.07), paint);
    }
    else if (v == 6) { body = mix(vec3(0.38, 0.22, 0.15), vec3(0.52, 0.31, 0.2), mottle); core = vec3(0.2, 0.17, 0.16); body *= 1.0 - 0.55 * smoothstep(0.5, 0.75, fbm(p * 0.02 + uSeed + 2.0)); }
    else if (v == 7) { body = mix(vec3(0.84, 0.78, 0.68), vec3(0.9, 0.86, 0.78), mottle); core = vec3(0.86, 0.82, 0.74); glazeCol = vec3(0.13, 0.58, 0.6); glaze = smoothstep(0.3, 0.4, fbm(p * 0.02 + uSeed + 6.0)); }
    else if (v == 8) {
      // Red-figure: the figures left in the clay's orange, the ground painted black, with
      // black relief lines drawn inside the figures.
      body = vec3(0.82, 0.47, 0.26); core = vec3(0.72, 0.42, 0.26); glazeCol = vec3(0.03, 0.028, 0.026);
      float fig = smoothstep(0.47, 0.5, fbm(p * 0.011 + uSeed + 3.0));
      glaze = 1.0 - fig;
      // Relief lines: contours of a smooth field, so they run as long drawn strokes.
      float lines = band(noise(p * 0.018 + uSeed + 5.0) * 5.0, 0.05) * smoothstep(0.56, 0.6, fbm(p * 0.011 + uSeed + 3.0));
      body = mix(body, vec3(0.06, 0.05, 0.04), lines * 0.85 * fig);
    }
    else if (v == 9) {
      // Black-figure: black silhouettes on the orange clay, details incised through to it,
      // and a black band round the pot.
      body = vec3(0.84, 0.52, 0.3); core = vec3(0.74, 0.44, 0.27); glazeCol = vec3(0.035, 0.03, 0.028);
      float fig = smoothstep(0.55, 0.58, fbm(p * 0.013 + uSeed + 8.0));
      float incised = band(noise(p * 0.022 + uSeed) * 5.0, 0.04) * smoothstep(0.6, 0.64, fbm(p * 0.013 + uSeed + 8.0));
      glaze = max(fig * (1.0 - incised), band(bu * 0.011 + ph, 0.05));
    }
    else if (v == 10) {
      // Terra sigillata: Roman red gloss, smooth and shiny, with turned grooves.
      body = mix(vec3(0.64, 0.25, 0.14), vec3(0.74, 0.32, 0.18), mottle); core = vec3(0.72, 0.42, 0.3);
      glazeCol = body * 1.04; glaze = 0.8;
    }
    else if (v == 11) {
      // Blue-and-white: cobalt painted under a clear glaze, swirling sprays and double rings.
      body = vec3(0.93, 0.93, 0.9); core = vec3(0.9, 0.89, 0.86); glazeCol = vec3(0.95, 0.96, 0.97); glaze = 1.0;
      float sw = sin(bv * 0.06 + sin(bu * 0.05 + ph * 6.0) * 2.0 + fbm(p * 0.02 + uSeed) * 4.0);
      float spray = smoothstep(0.28, 0.06, abs(sw)) * smoothstep(0.38, 0.52, fbm(p * 0.017 + uSeed + 2.0));
      float rings = band(bu * 0.011 + ph, 0.025) + band(bu * 0.011 + ph + 0.05, 0.015);
      float cobalt = clamp(spray + rings, 0.0, 1.0) * (0.6 + 0.4 * fbm(p * 0.3));
      glazeCol = mix(glazeCol, vec3(0.1, 0.19, 0.52), cobalt);
    }
    else if (v == 12) {
      // Celadon: a thick jade glaze over grey stoneware, pooling darker, crackled all over.
      body = vec3(0.6, 0.58, 0.55); core = vec3(0.55, 0.54, 0.52); glazeCol = vec3(0.5, 0.66, 0.52); glaze = 1.0;
    }
    else if (v == 13) {
      // Maiolica: white tin glaze painted in bands of cobalt, yellow and orange, with dots.
      body = buff; core = vec3(0.84, 0.66, 0.48); glazeCol = vec3(0.95, 0.93, 0.86); glaze = 1.0;
      float bnd = fract(bu * 0.01 + ph);
      glazeCol = mix(glazeCol, vec3(0.16, 0.27, 0.6), step(0.1, bnd) * step(bnd, 0.2));
      glazeCol = mix(glazeCol, vec3(0.9, 0.68, 0.18), step(0.24, bnd) * step(bnd, 0.3));
      glazeCol = mix(glazeCol, vec3(0.82, 0.4, 0.12), step(0.32, bnd) * step(bnd, 0.34));
      float dots = step(length(fract(vec2(bv * 0.05, bnd * 16.0)) - 0.5), 0.3) * step(0.4, bnd) * step(bnd, 0.46);
      glazeCol = mix(glazeCol, vec3(0.16, 0.27, 0.6), dots);
    }
    else if (v == 14) {
      // Lustreware: cream glaze with vines in a metallic lustre that flashes gold.
      body = buff; core = vec3(0.84, 0.66, 0.48); glazeCol = vec3(0.92, 0.86, 0.72); glaze = 1.0;
      float vine = smoothstep(0.22, 0.04, abs(sin(bv * 0.08 + sin(bu * 0.07 + ph * 5.0) * 2.5 + fbm(p * 0.03) * 3.0)));
      float spots = step(length(fract(p * 0.07 + ph) - 0.5), 0.14) * step(0.55, fbm(p * 0.02 + uSeed + 1.0));
      lustre = clamp(vine * smoothstep(0.3, 0.5, fbm(p * 0.015 + uSeed)) + spots, 0.0, 1.0);
      glazeCol = mix(glazeCol, vec3(0.6, 0.4, 0.15), lustre);
    }
    else if (v == 15) { body = mix(vec3(0.4, 0.33, 0.26), vec3(0.54, 0.44, 0.34), mottle); core = vec3(0.24, 0.21, 0.19); }
    else if (v == 16) { body = mix(vec3(0.5, 0.37, 0.27), vec3(0.62, 0.47, 0.34), mottle); core = vec3(0.3, 0.25, 0.21); }
    else if (v == 17) {
      // Salt-glazed stoneware: a brown gloss with the orange-peel skin salt leaves.
      body = vec3(0.52, 0.35, 0.2); core = vec3(0.6, 0.55, 0.5); glaze = 1.0;
      glazeCol = mix(vec3(0.4, 0.24, 0.11), vec3(0.62, 0.42, 0.22), fbm(p * 0.05 + uSeed));
    }
    else if (v == 18) {
      // Tortoiseshell: a lead glaze sponged with manganese brown and copper green.
      body = buff; core = vec3(0.84, 0.66, 0.48); glaze = 1.0;
      float t1 = fbm(p * 0.025 + uSeed);
      glazeCol = mix(vec3(0.86, 0.74, 0.46), vec3(0.36, 0.2, 0.08), smoothstep(0.42, 0.56, t1));
      glazeCol = mix(glazeCol, vec3(0.28, 0.4, 0.16), smoothstep(0.6, 0.7, fbm(p * 0.03 + uSeed + 7.0)));
    }
    else if (v == 19) {
      // Egyptian blue-painted: pale bands of blue edged in black, and a red one.
      body = buff; core = vec3(0.78, 0.58, 0.42);
      float bnd = fract(bu * 0.012 + ph);
      body = mix(body, vec3(0.42, 0.63, 0.78), step(0.2, bnd) * step(bnd, 0.34));
      body = mix(body, vec3(0.08, 0.07, 0.06), step(0.19, bnd) * step(bnd, 0.205) + step(0.335, bnd) * step(bnd, 0.35));
      body = mix(body, vec3(0.6, 0.2, 0.1), step(0.5, bnd) * step(bnd, 0.54));
    }
    else if (v == 20) {
      // Minoan marine style: an octopus's tentacles curling across the pot.
      body = mix(vec3(0.87, 0.78, 0.6), vec3(0.92, 0.84, 0.68), mottle); core = vec3(0.8, 0.62, 0.45);
      vec2 c = uSize * vec2(0.2 + 0.6 * hash(vec2(uSeed, 3.0)), 0.2 + 0.6 * hash(vec2(uSeed, 4.0)));
      vec2 d = p - c;
      float r = length(d);
      float t = abs(sin(atan(d.y, d.x) * 4.0 + r * 0.045 + ph * 6.0));
      float arms = smoothstep(0.24, 0.1, t) * smoothstep(280.0, 40.0, r) * smoothstep(8.0, 22.0, r);
      body = mix(body, vec3(0.3, 0.15, 0.08), max(arms, smoothstep(10.0, 7.0, r)));
    }
    else if (v == 21) {
      // Bucchero: Etruscan black ware, burnished to a soft shine.
      body = mix(vec3(0.07, 0.065, 0.06), vec3(0.13, 0.12, 0.11), mottle); core = vec3(0.14, 0.13, 0.12);
      body *= 0.9 + 0.2 * noise(vec2(bu * 0.05, bv * 0.6));
      glazeCol = body; glaze = 0.55;
    }
    else if (v == 22) { body = mix(vec3(0.66, 0.6, 0.52), vec3(0.74, 0.68, 0.58), mottle); core = vec3(0.45, 0.42, 0.39); }
    else {
      // Feathered slipware: yellow glaze over trailed brown lines, combed into feathers.
      body = buff; core = vec3(0.84, 0.66, 0.48); glaze = 1.0; glazeCol = vec3(0.88, 0.66, 0.28);
      float tri = abs(fract(bv * 0.012) - 0.5);
      float trail = band(bu * 0.03 + tri * (fract(bv * 0.006) > 0.5 ? 0.8 : -0.8) + ph, 0.07);
      glazeCol = mix(glazeCol, vec3(0.32, 0.17, 0.08), trail);
    }
    // Grit: lime, dark stone, and glints of mica, half-sunk in the fabric. Coarse ware has more.
    float coarse = (v == 6 || v == 15 || v == 16) ? 1.0 : 0.0;
    float lime = speck(p, 3.2, 0.975 - coarse * 0.03);
    float stone = speck(p + 37.0, 4.0, 0.98 - coarse * 0.03);
    float mica = speck(p + 71.0, 2.2, 0.985);
    float bare = 1.0 - glaze * 0.85;
    body = mix(body, mix(body, vec3(0.9, 0.86, 0.78), 0.65), lime * bare);
    body = mix(body, body * 0.35, stone * bare);
    mica *= bare;
    // Burial: a pale crust of soil lime in patches, heaviest near the breaks.
    float crust = smoothstep(0.58, 0.8, fbm(p * 0.03 + uSeed + 12.0) + (1.0 - m) * 0.9) * (0.55 + 0.45 * noise(p * 0.7));
    body = mix(body, vec3(0.8, 0.74, 0.63), crust * 0.55);
    // Green and jade glazes pool darker in the low places.
    bool pools = v == 4 || v == 12;
    vec3 alb = mix(body, glazeCol, glaze * (pools ? 0.75 + 0.25 * smoothstep(0.5, -0.5, f.r) : 1.0));
    if (pools) alb *= 0.9 + 0.1 * smoothstep(-0.3, 0.3, baseHeight(p) - 3.0);
    // Crazing in the glaze: fine on green and faience, bold on celadon.
    float craze = (v == 4 || v == 7 || v == 11) ? (1.0 - smoothstep(0.0, 0.04, crackle(p * 0.2))) * glaze * (v == 11 ? 0.4 : 1.0)
      : v == 12 ? (1.0 - smoothstep(0.0, 0.05, crackle(p * 0.085))) * 1.8 : 0.0;
    alb *= 1.0 - craze * 0.22;
    // Crust sits on glaze too, and dulls it.
    alb = mix(alb, vec3(0.8, 0.74, 0.63), crust * glaze * 0.5);
    glaze *= 1.0 - crust * 0.6;
    // Ink soaks into the bare fabric unevenly and beads on glaze.
    float por = mix(0.65, 1.3, fbm(p * 0.7 + uSeed)) * (1.0 - glaze * 0.3);
    float kb = clamp(f.g * por, 0.0, 1.0);
    float kr = clamp(f.b * por, 0.0, 1.0);
    alb = mix(alb, vec3(0.05, 0.045, 0.04), kb * 0.95);
    alb = mix(alb, vec3(0.56, 0.16, 0.07), kr * 0.9);
    float wrap = clamp((ndl + 0.3) / 1.3, 0.0, 1.0);
    float shin = mix(12.0, 110.0, glaze);
    float ks = mix(0.05, 0.9, glaze) + mica * 1.2 + lustre * 1.4;
    // Lustre flashes coloured, like metal.
    vec3 specTint = mix(vec3(1.0), vec3(1.0, 0.74, 0.32), lustre);
    // Glaze reflects the room: bright above, dim below, following the wheel ridges.
    vec3 env = mix(vec3(0.95, 0.97, 1.0), vec3(0.3, 0.28, 0.26), clamp(n.y * 2.5 + 0.5, 0.0, 1.0));
    float fres = 0.08 + 0.92 * pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
    col = alb * (0.36 + 0.76 * wrap) * cavity + specTint * (pow(nh, shin) * ks + pow(nh, 14.0) * glaze * 0.12) + env * fres * glaze * 0.35 * specTint;
    if (top < 0.5 && sideA > 0.0) {
      // The break: surface colour at the faces, the core in the middle, in shade.
      float across = abs(depthIn - 0.5) * 2.0;
      vec3 sec = mix(core, body, smoothstep(0.35, 0.8, across));
      sec *= 0.85 + 0.3 * noise(p * 0.9);
      col = sec * mix(0.72, 0.45, depthIn);
    }
  }
  outColor = vec4(col * alpha, alpha);
}`;

// ---- the renderer ------------------------------------------------------------------------
// One WebGL context for every page. Browsers keep only ~16 live contexts per page and drop the
// oldest past that (a grid of sherds went blank), so pages don't own one: each keeps its field
// and outline as textures in this shared context and a plain 2D canvas on screen, and the
// renderer draws a page and copies it across when that page changes.

interface GpuPage {
  field: WebGLTexture;
  /** The sherd's outline; null uses the shared all-solid mask. */
  mask: WebGLTexture | null;
  inked: boolean;
  /** The context generation the textures belong to (a lost context invalidates them). */
  gen: number;
}

export interface PageUniforms {
  size: [number, number];
  medium: 1 | 2 | 3;
  seed: number;
  variant: number;
  side: number;
  frame: number;
  wheel: [number, number];
  px: number;
}

class SharedRenderer {
  private static instance: SharedRenderer | null | undefined;
  private canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private solid: WebGLTexture | null = null;
  gen = 0;

  /** The renderer, or null where WebGL2 isn't available. */
  static get(): SharedRenderer | null {
    if (SharedRenderer.instance === undefined) {
      const r = new SharedRenderer();
      SharedRenderer.instance = r.init() ? r : null;
    }
    return SharedRenderer.instance;
  }

  private constructor() {
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.init();
    });
  }

  private init(): boolean {
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return false;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error("notebook shader", gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("notebook shader link", gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["uField", "uMask", "uSize", "uMedium", "uSeed", "uVariant", "uSide", "uFrame", "uWheel", "uPx"]) this.loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(this.loc.uField, 0);
    gl.uniform1i(this.loc.uMask, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.gl = gl;
    this.gen++;
    this.solid = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    return true;
  }

  get ready(): boolean {
    return !!this.gl && !this.gl.isContextLost();
  }

  private texture(): WebGLTexture {
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  createPage(f: Field, mask: Uint8Array | null): GpuPage {
    const gl = this.gl!;
    const field = this.texture();
    // Height alone (R16F) unless the medium takes ink too.
    if (f.inked) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, f.w, f.h, 0, gl.RGBA, gl.FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, f.w, f.h, 0, gl.RED, gl.FLOAT, null);
    let m: WebGLTexture | null = null;
    if (mask) {
      m = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.w, f.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
    }
    f.markAll();
    return { field, mask: m, inked: f.inked, gen: this.gen };
  }

  deletePage(p: GpuPage) {
    if (!this.gl || p.gen !== this.gen) return;
    this.gl.deleteTexture(p.field);
    if (p.mask) this.gl.deleteTexture(p.mask);
  }

  /** Send the field's changed cells to its texture. */
  upload(p: GpuPage, f: Field) {
    const gl = this.gl!;
    const d = f.dirty;
    if (!d) return;
    f.dirty = null;
    const [x0, y0, x1, y1] = d;
    const w = x1 - x0;
    const h = y1 - y0;
    const ch = f.inked ? 4 : 1;
    const buf = new Float32Array(w * h * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y0 + y) * f.w + x0 + x;
        const o = (y * w + x) * ch;
        buf[o] = f.height[i];
        if (f.inked) {
          buf[o + 1] = f.black[i];
          buf[o + 2] = f.red[i];
        }
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.field);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, f.inked ? gl.RGBA : gl.RED, gl.FLOAT, buf);
  }

  /** Draw a page and copy it into `target`, a 2D canvas of the size to render at. */
  render(p: GpuPage, u: PageUniforms, target: HTMLCanvasElement) {
    const gl = this.gl!;
    const w = target.width;
    const h = target.height;
    if (!w || !h) return;
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.field);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, p.mask ?? this.solid);
    gl.uniform2f(this.loc.uSize, u.size[0], u.size[1]);
    gl.uniform1i(this.loc.uMedium, u.medium);
    gl.uniform1f(this.loc.uSeed, u.seed);
    gl.uniform1i(this.loc.uVariant, u.variant);
    gl.uniform1f(this.loc.uSide, u.side);
    gl.uniform1f(this.loc.uFrame, u.frame);
    gl.uniform2f(this.loc.uWheel, u.wheel[0], u.wheel[1]);
    gl.uniform1f(this.loc.uPx, u.px);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // The viewport sits at the bottom-left of the shared canvas.
    const ctx = target.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
  }
}

// ---- the surface -------------------------------------------------------------------------

export interface MediumSurfaceOptions {
  medium: Exclude<NotebookMedium, "paper">;
  pageId: string;
  geom: PageGeometry;
  /** Wax: which edge of the leaf the cords run through. */
  side: "left" | "right";
  onSave(group: InkGroupRecord): void;
  onDelete(ids: string[]): void;
  onState(state: InkState): void;
  onActivate(): void;
  /** False for a picture (a shelf cover, a sherd in the heap): no input at all. */
  interactive?: boolean;
}

export class MediumSurface {
  readonly canvas: HTMLCanvasElement;
  private field: Field;
  private gpu: GpuPage | null = null;
  private readonly mask: Uint8Array | null;
  private strokes = new Map<string, MediumStrokeData>();
  private undoStack: string[] = [];
  private redoStack: { id: string; data: MediumStrokeData }[] = [];
  private tool: MediumToolId;
  private size = 1;
  private touchDraws = false;
  private renderScale = 1;
  private frame = 0;
  private active: { id: number; builder: StrokeBuilder } | null = null;
  private readonly variant: number;
  private readonly seed: number;

  constructor(
    host: HTMLElement,
    private opts: MediumSurfaceOptions,
  ) {
    this.seed = seedOf(opts.pageId);
    this.variant = opts.medium === "sherd" ? sherdShape(opts.pageId).variant : 0;
    this.tool = opts.medium === "clay" ? "stylus" : opts.medium === "wax" ? "point" : "black";
    this.field = new Field(opts.geom, RES[opts.medium], opts.medium === "sherd");
    this.mask = opts.medium === "sherd" ? sherdMask(opts.pageId, opts.geom, this.field.w, this.field.h, this.field.res) : null;
    // A plain 2D canvas: the shared renderer paints into it.
    this.canvas = document.createElement("canvas");
    host.appendChild(this.canvas);
    if (opts.interactive === false) return;
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
    this.setRenderScale(1);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
    if (this.gpu) SharedRenderer.get()?.deletePage(this.gpu);
    this.gpu = null;
    this.canvas.remove();
  }

  /** The page's strokes as stored. Replaces what is drawn. */
  setStrokes(groups: InkGroupRecord[]) {
    this.strokes.clear();
    for (const g of groups) {
      const d = g.data as Partial<MediumStrokeData>;
      if (d && d.v === 2 && Array.isArray(d.p) && typeof d.tool === "string") this.strokes.set(g.id, d as MediumStrokeData);
    }
    this.rebuild();
  }

  setTool(tool: MediumToolId) {
    this.tool = tool;
  }

  /** The tool's size, as a multiplier on its width. */
  setSize(size: number) {
    this.size = size;
  }

  /** Whether a finger draws (drawing mode) or scrolls. A pen and a mouse always draw. */
  setTouchDraws(on: boolean) {
    this.touchDraws = on;
  }

  /** Device pixels per page px: the zoom times the screen's density, capped. */
  setRenderScale(scale: number) {
    const s = Math.max(0.1, Math.min(3, scale));
    this.renderScale = s;
    const w = Math.round(this.opts.geom.width * s);
    const h = Math.round(this.opts.geom.height * s);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.request();
  }

  undo() {
    const id = this.undoStack.pop();
    if (!id) return;
    const data = this.strokes.get(id);
    this.strokes.delete(id);
    if (data) this.redoStack.push({ id, data });
    this.opts.onDelete([id]);
    this.rebuild();
  }

  redo() {
    const r = this.redoStack.pop();
    if (!r) return;
    this.strokes.set(r.id, r.data);
    this.undoStack.push(r.id);
    this.opts.onSave({ id: r.id, data: r.data });
    this.rebuild();
  }

  /** Report undo/redo availability (the toolbar asks when this page becomes current). */
  emitState() {
    this.opts.onState({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, hasInk: this.strokes.size > 0 });
  }

  private rebuild() {
    this.field.clear();
    const all = [...this.strokes.entries()].sort((a, b) => a[1].t - b[1].t || (a[0] < b[0] ? -1 : 1));
    for (const [, s] of all) replay(this.field, s);
    this.request();
    this.emitState();
  }

  // ---- pictures ---------------------------------------------------------------------------

  /** Draw a stroke as if a hand had: pointer samples in page px, with pressure. Not stored. */
  simulate(tool: MediumToolId, points: [number, number, number][]) {
    const b = new StrokeBuilder(tool, this.field);
    points.forEach(([x, y, p], i) => b.add(x, y, p, i * 16));
    b.close();
  }

  /** Put lettering on the surface: pressed into clay, scratched into wax, or brushed on in ink. */
  imprint(
    text: string,
    o: { x: number; y: number; size: number; font: string; style?: string; maxWidth: number; mode: "press" | "scratch" | "ink"; depth?: number; red?: boolean },
  ) {
    const f = this.field;
    const res = f.res;
    const cnv = document.createElement("canvas");
    cnv.width = f.w;
    cnv.height = f.h;
    const ctx = cnv.getContext("2d")!;
    // Canvas font shorthand: style and weight, then size, then family.
    const font = (px: number) => `${o.style ?? ""} ${px * res}px ${o.font}`.trim();
    let size = o.size;
    ctx.font = font(size);
    const w = ctx.measureText(text).width / res;
    if (w > o.maxWidth) {
      size *= o.maxWidth / w;
      ctx.font = font(size);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(text, o.x * res, o.y * res);
    const src = ctx.getImageData(0, 0, f.w, f.h).data;
    let a: Float32Array = new Float32Array(f.w * f.h);
    for (let i = 0; i < a.length; i++) a[i] = src[i * 4 + 3] / 255;
    const depth = o.depth ?? 2.4;
    if (o.mode === "ink") {
      const C = o.red ? f.red : f.black;
      if (!C.length) return;
      for (let i = 0; i < a.length; i++) if (a[i]) C[i] = Math.min(1, C[i] + a[i] * (0.7 + 0.3 * hash2(i % f.w, (i / f.w) | 0, 9)));
    } else {
      a = boxBlur(a, f.w, f.h, Math.max(1, Math.round(res * (o.mode === "press" ? 0.7 : 0.35))));
      const wide = boxBlur(a, f.w, f.h, Math.round(res * (o.mode === "press" ? 2.2 : 1.2)));
      const lip = o.mode === "press" ? 0.9 : 0.6;
      for (let i = 0; i < a.length; i++) f.height[i] += -depth * a[i] + depth * lip * Math.max(0, wide[i] - a[i]);
    }
    f.markAll();
  }

  /** Render now and hand back a copy of the picture (the canvas goes with the surface). */
  snapshot(): HTMLCanvasElement {
    this.draw();
    const out = document.createElement("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    out.getContext("2d")!.drawImage(this.canvas, 0, 0);
    return out;
  }

  // ---- input -----------------------------------------------------------------------------

  private point(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.opts.geom.width, ((e.clientY - r.top) / r.height) * this.opts.geom.height];
  }

  private pressure(e: PointerEvent): number {
    if (e.pointerType === "mouse") return 0.5;
    return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
  }

  /** A stylus on iPad starts as a touch: claim it before the page scrolls. */
  private onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0] as Touch & { touchType?: string };
    if (t?.touchType === "stylus" || this.touchDraws) e.preventDefault();
  };

  private onDown = (e: PointerEvent) => {
    this.opts.onActivate();
    if (this.active) return;
    if (e.pointerType === "touch" && !this.touchDraws) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.canvas.setPointerCapture(e.pointerId);
    const builder = new StrokeBuilder(this.tool, this.field, this.size);
    this.active = { id: e.pointerId, builder };
    const [x, y] = this.point(e);
    builder.add(x, y, this.pressure(e), e.timeStamp);
    this.request();
  };

  private onMove = (e: PointerEvent) => {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.point(ev);
      a.builder.add(x, y, this.pressure(ev), ev.timeStamp);
    }
    this.request();
  };

  private onUp = (e: PointerEvent) => {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    this.active = null;
    if (e.type === "pointerup") {
      const [x, y] = this.point(e);
      if (a.builder.tool === "wedge") a.builder.add(x, y, this.pressure(e), e.timeStamp);
    }
    if (!a.builder.close()) return;
    const id = crypto.randomUUID();
    this.strokes.set(id, a.builder.data);
    this.undoStack.push(id);
    this.redoStack = [];
    this.opts.onSave({ id, data: a.builder.data });
    this.request();
    this.emitState();
  };

  // ---- rendering -------------------------------------------------------------------------

  private request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const r = SharedRenderer.get();
    if (!r || !r.ready) return this.drawFallback();
    if (!this.gpu || this.gpu.gen !== r.gen) this.gpu = r.createPage(this.field, this.mask);
    r.upload(this.gpu, this.field);
    const a = sherdShape(this.opts.pageId).wheel;
    r.render(
      this.gpu,
      {
        size: [this.opts.geom.width, this.opts.geom.height],
        medium: this.opts.medium === "clay" ? 1 : this.opts.medium === "wax" ? 2 : 3,
        seed: (this.seed % 1000) / 7.3,
        variant: this.variant,
        side: this.opts.side === "left" ? 1 : -1,
        frame: 18,
        wheel: [Math.cos(a), Math.sin(a)],
        px: 1 / this.renderScale,
      },
      this.canvas,
    );
  }

  /** No WebGL2: flat colour with simple relief lighting, so marks still show. */
  private drawFallback() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const f = this.field;
    this.field.dirty = null;
    const img = ctx.createImageData(f.w, f.h);
    const base = this.opts.medium === "clay" ? [168, 86, 56] : this.opts.medium === "wax" ? [226, 176, 90] : [190, 110, 70];
    for (let y = 1; y < f.h - 1; y++) {
      for (let x = 1; x < f.w - 1; x++) {
        const i = y * f.w + x;
        const s = 1 + (f.height[i - 1] - f.height[i + 1] + f.height[i - f.w] - f.height[i + f.w]) * 0.6 + f.height[i] * 0.05;
        const k = f.inked ? 1 - Math.min(1, f.black[i]) * 0.9 : 1;
        const o = i * 4;
        img.data[o] = base[0] * s * k + (f.inked ? f.red[i] * 60 : 0);
        img.data[o + 1] = base[1] * s * k;
        img.data[o + 2] = base[2] * s * k;
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = f.w;
    tmp.height = f.h;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(tmp, 0, 0, this.canvas.width, this.canvas.height);
  }
}

/** A still picture of a page of clay, wax or pottery, marked by `paint`, at `scale` device px
 *  per page px. For the shelf covers and the sherd heap. Null without a DOM. */
export function renderMedium(o: {
  medium: Exclude<NotebookMedium, "paper">;
  pageId: string;
  geom: PageGeometry;
  scale: number;
  side?: "left" | "right";
  paint?(s: MediumSurface): void;
}): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  const noop = () => {};
  const s = new MediumSurface(host, {
    medium: o.medium,
    pageId: o.pageId,
    geom: o.geom,
    side: o.side ?? "right",
    onSave: noop,
    onDelete: noop,
    onState: noop,
    onActivate: noop,
    interactive: false,
  });
  try {
    s.setRenderScale(o.scale);
    o.paint?.(s);
    return s.snapshot();
  } finally {
    s.destroy();
  }
}
