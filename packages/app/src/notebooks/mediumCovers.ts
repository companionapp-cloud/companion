import { renderMedium, seedOf } from "./mediumEngine";
import { MEDIUMS, sherdShape, type NotebookMedium } from "./mediums";

// Shelf covers for the ancient mediums (PLAN-notebooks.md §11), rendered by the same shader
// as the pages: a stack of clay tablets with the title pressed in over rows of cuneiform; a wax
// leaf with the title scratched in, bound with thongs over the edges of its other leaves and a
// bronze stylus lying across it; a heap of sherds of different pots with the title brushed on
// the top one. Composed on a 2D canvas. DOM only: without one (the native shelf) the covers
// return null and the shelf draws its plain art.
//
// A cover takes a moment to render, so finished ones are kept: in memory for the session and in
// IndexedDB across reloads, so a refreshed shelf shows them at once instead of re-rendering.
// The key carries COVER_VERSION: bump it when the covers or the shader change.

export interface CoverSubject {
  id: string;
  title: string;
  medium: NotebookMedium;
  leaves?: number;
  pageCount: number;
}

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";
const COVER_VERSION = 4;
const cache = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

// ---- the kept covers (IndexedDB) -------------------------------------------------------------
// Best effort: a private window or blocked storage just means covers render each time.

const DB = "companion-notebook-covers";
const STORE = "covers";
const KEEP = 150;
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbp;
}

async function keptCover(key: string): Promise<Blob | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as { blob: Blob } | undefined)?.blob ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function keepCover(key: string, blob: Blob) {
  const d = await db();
  if (!d) return;
  try {
    const store = d.transaction(STORE, "readwrite").objectStore(STORE);
    store.put({ blob, at: Date.now() }, key);
    // Keep the newest few: titles and sizes change, and old keys would pile up.
    const all = store.getAll();
    const keys = store.getAllKeys();
    all.onsuccess = () => {
      keys.onsuccess = () => {
        const rows = (all.result as { at: number }[]).map((r, i) => ({ at: r.at, key: keys.result[i] }));
        if (rows.length <= KEEP) return;
        rows.sort((a, b) => a.at - b.at);
        for (const r of rows.slice(0, rows.length - KEEP)) store.delete(r.key);
      };
    };
  } catch {
    /* storage unavailable */
  }
}

function toBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  // WebP keeps the alpha and is far smaller; browsers without it hand back PNG.
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/webp", 0.92));
}

function coverKey(subject: CoverSubject, width: number): string {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return `v${COVER_VERSION}|${subject.medium}|${subject.id}|${subject.title}|${subject.leaves ?? ""}|${Math.round(width * dpr)}`;
}

/** A cover already rendered this session, synchronously, so a remounted shelf never blinks. */
export function peekCover(subject: CoverSubject, width: number): string | null {
  if (typeof document === "undefined" || subject.medium === "paper") return null;
  return cache.get(coverKey(subject, width)) ?? null;
}

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

/** The cover's URL: from this session, from the kept covers, or rendered (one at a time, off
 *  the main path of the shelf) and then kept. */
export async function mediumCover(subject: CoverSubject, width: number): Promise<string | null> {
  if (typeof document === "undefined" || subject.medium === "paper") return null;
  const key = coverKey(subject, width);
  const hit = cache.get(key);
  if (hit) return hit;
  const kept = await keptCover(key);
  if (kept) {
    const url = URL.createObjectURL(kept);
    cache.set(key, url);
    return url;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const job = queue.then(
    () =>
      new Promise<string | null>((resolve) =>
        setTimeout(async () => {
          try {
            const canvas = compose(subject, Math.round(width * dpr), dpr);
            const blob = canvas ? await toBlob(canvas) : null;
            if (!blob) return resolve(null);
            const url = URL.createObjectURL(blob);
            cache.set(key, url);
            void keepCover(key, blob);
            resolve(url);
          } catch (e) {
            console.error("notebook cover", e);
            resolve(null);
          }
        }, 0),
      ),
  );
  queue = job;
  return job;
}

function compose(s: CoverSubject, W: number, dpr: number): HTMLCanvasElement | null {
  const H = Math.round((W * 4) / 3);
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d")!;
  const tiny = W / dpr < 100;
  const title = s.title.trim() || "Untitled";
  // Drawn details (thongs, knots, the stylus, shadows) are sized to the cover, not the screen:
  // one unit is a device px on a full 260 px shelf cover, and shrinks with small previews.
  const unit = W / 260;
  if (s.medium === "clay") clayCover(ctx, s, W, H, unit, tiny ? "" : title);
  else if (s.medium === "wax") waxCover(ctx, s, W, H, unit, tiny ? "" : title);
  else sherdCover(ctx, s, W, H, unit, tiny ? "" : title);
  return out;
}

/** Draw a picture centred at (x, y), turned, with a soft shadow under it. */
function place(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | null, x: number, y: number, deg: number, unit: number, shadow = "rgba(55, 20, 6, 0.38)", size = 1) {
  if (!img) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.shadowColor = shadow;
  ctx.shadowBlur = 16 * unit;
  ctx.shadowOffsetY = 9 * unit;
  ctx.drawImage(img, (-img.width * size) / 2, (-img.height * size) / 2, img.width * size, img.height * size);
  ctx.restore();
}

// ---- clay ----------------------------------------------------------------------------------

/** Rows of cuneiform between ruled lines: upright, lying and slanting wedges, and hooks. */
function cuneiform(surface: Parameters<NonNullable<Parameters<typeof renderMedium>[0]["paint"]>>[0], seed: number, top: number, bottom: number, width: number) {
  const r = rng(seed);
  for (let y = top; y < bottom; y += 44) {
    surface.simulate("stylus", [
      [26, y + 36, 0.05],
      [width / 2, y + 36.5, 0.05],
      [width - 26, y + 36, 0.05],
    ]);
    let x = 40 + r() * 10;
    while (x < width - 50) {
      const k = r();
      const cy = y + 8 + r() * 4;
      if (k < 0.4) surface.simulate("wedge", [[x, cy, 0.5], [x, cy + 16 + r() * 8, 0.5]]);
      else if (k < 0.7) surface.simulate("wedge", [[x, cy + 10, 0.5], [x + 14 + r() * 6, cy + 10, 0.5]]);
      else if (k < 0.88) surface.simulate("wedge", [[x, cy + 2, 0.5], [x + 11, cy + 13, 0.5]]);
      else surface.simulate("wedge", [[x + 8, cy + 6, 0.5], [x, cy + 13, 0.5]]);
      x += 13 + r() * 13;
      if (r() < 0.12) x += 14;
    }
  }
}

function clayCover(ctx: CanvasRenderingContext2D, s: CoverSubject, W: number, H: number, unit: number, title: string) {
  const g = MEDIUMS.clay.page;
  const scale = (H * 0.72) / g.height;
  const tablet = (n: number, withTitle: boolean) =>
    renderMedium({
      medium: "clay",
      pageId: `${s.id}:t${n}`,
      geom: g,
      scale,
      paint: (m) => {
        if (withTitle && title) {
          m.imprint(title.toUpperCase(), { x: g.width / 2, y: 70, size: 40, style: "600", font: SERIF, maxWidth: g.width - 80, mode: "press", depth: 2.6 });
          cuneiform(m, seedOf(s.id), 110, g.height - 60, g.width);
        } else cuneiform(m, seedOf(s.id) + n * 17, 40, g.height - 60, g.width);
      },
    });
  place(ctx, tablet(2, false), W * 0.42, H * 0.4, -10, unit);
  if (s.pageCount > 1) place(ctx, tablet(1, false), W * 0.6, H * 0.44, 8, unit);
  place(ctx, tablet(0, true), W * 0.5, H * 0.56, -1.5, unit);
}

// ---- wax -----------------------------------------------------------------------------------

/** A line of Roman cursive as words: each a single scratch of down- and up-strokes of varied
 *  height, with the odd tall ascender or long descender, and gaps between the words. The
 *  point's drag turns it angular on its own. */
function cursiveWords(r: () => number, x0: number, x1: number, y: number): [number, number, number][][] {
  const words: [number, number, number][][] = [];
  let x = x0;
  while (x < x1 - 20) {
    const letters = 2 + Math.floor(r() * 5);
    const pts: [number, number, number][] = [[x, y + 2, 0.5]];
    for (let i = 0; i < letters && x < x1; i++) {
      const w = 5 + r() * 7;
      const tall = r() < 0.2 ? 12 + r() * 8 : 0;
      const low = r() < 0.12 ? 10 + r() * 6 : 0;
      pts.push([x + w * 0.35, y - 9 - tall - r() * 4, 0.55]);
      pts.push([x + w * 0.7, y + 3 + low, 0.6]);
      if (r() < 0.3) pts.push([x + w * 0.9, y - 5 - r() * 4, 0.5]);
      x += w;
    }
    words.push(pts);
    x += 10 + r() * 10;
  }
  return words;
}

function waxCover(ctx: CanvasRenderingContext2D, s: CoverSubject, W: number, H: number, unit: number, title: string) {
  const g = MEDIUMS.wax.page;
  const scale = (H * 0.8) / g.height;
  const lw = g.width * scale;
  const lh = g.height * scale;
  const cx = W * 0.53;
  const cy = H * 0.47;
  const left = cx - lw / 2;
  const top = cy - lh / 2;
  // The codex's other leaves, their frames showing beneath.
  const under = Math.min(Math.max(1, (s.leaves ?? s.pageCount) - 1), 7);
  const step = 3.2 * unit;
  for (let i = under; i >= 1; i--) {
    ctx.save();
    ctx.shadowColor = "rgba(40, 20, 6, 0.3)";
    ctx.shadowBlur = 10 * unit;
    ctx.shadowOffsetY = 5 * unit;
    ctx.fillStyle = i % 2 ? "#6a4323" : "#7c5230";
    roundRect(ctx, left + i * step * 0.5, top + i * step, lw, lh, 5 * scale);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = unit;
    ctx.stroke();
    ctx.restore();
  }
  const r = rng(seedOf(s.id));
  const leaf = renderMedium({
    medium: "wax",
    pageId: `${s.id}:leaf`,
    geom: g,
    scale,
    side: "right",
    paint: (m) => {
      if (title) m.imprint(title, { x: g.width / 2 + 8, y: 108, size: 58, style: "italic 300", font: SERIF, maxWidth: g.width - 100, mode: "scratch", depth: 1.8 });
      for (let y = 200; y < g.height - 80; y += 54) for (const word of cursiveWords(r, 64 + r() * 16, g.width - 70 - r() * 120, y)) m.simulate("point", word);
    },
  });
  place(ctx, leaf, cx, cy, 0, unit, "rgba(40, 20, 6, 0.4)");
  // Thongs through the cord holes, looped round the edges of the whole stack and knotted.
  for (const f of [0.32, 0.68]) {
    const hx = left + 9 * scale;
    const hy = top + f * lh;
    const outX = left - 7 * unit;
    const bottom = hy + under * step + 2 * unit;
    thong(ctx, [
      [hx, hy],
      [left - 2 * unit, hy - 1 * unit],
      [outX, hy + (bottom - hy) / 2],
      [left + under * step * 0.5 - 1 * unit, bottom],
    ], 5.6 * unit);
    knot(ctx, outX + 0.5 * unit, hy + (bottom - hy) / 2, unit);
  }
  stylus(ctx, W * 0.56, H * 0.95, W * 0.93, H * 0.62, unit);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function thong(ctx: CanvasRenderingContext2D, pts: [number, number][], width: number) {
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i];
      const [nx, ny] = pts[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const [lx, ly] = pts[pts.length - 1];
    ctx.lineTo(lx, ly);
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(20, 8, 2, 0.35)";
  ctx.shadowBlur = 3 * (width / 5.6);
  ctx.shadowOffsetY = 1.5 * (width / 5.6);
  path();
  ctx.strokeStyle = "#2a1407";
  ctx.lineWidth = width + 1.6;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  path();
  ctx.strokeStyle = "#7a4522";
  ctx.lineWidth = width;
  ctx.stroke();
  path();
  ctx.strokeStyle = "rgba(200, 140, 90, 0.45)";
  ctx.lineWidth = width * 0.3;
  ctx.stroke();
  ctx.restore();
}

function knot(ctx: CanvasRenderingContext2D, x: number, y: number, unit: number) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "#4a2610";
  ctx.lineWidth = 3.2 * unit;
  ctx.beginPath();
  ctx.moveTo(x, y + 3 * unit);
  ctx.quadraticCurveTo(x - 4 * unit, y + 10 * unit, x - 6 * unit, y + 16 * unit);
  ctx.moveTo(x, y + 3 * unit);
  ctx.quadraticCurveTo(x + 2 * unit, y + 9 * unit, x + 1 * unit, y + 15 * unit);
  ctx.stroke();
  ctx.fillStyle = "#6a3a1b";
  ctx.strokeStyle = "#2a1407";
  ctx.lineWidth = unit;
  ctx.beginPath();
  ctx.ellipse(x, y, 5.5 * unit, 6 * unit, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(200, 140, 90, 0.5)";
  ctx.beginPath();
  ctx.ellipse(x - 1.6 * unit, y - 2 * unit, 2 * unit, 1.4 * unit, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A bronze stylus: a point at one end, the flat spatula for smoothing at the other. */
function stylus(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, unit: number) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const t = 3.2 * unit;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.rotate(ang);
  ctx.shadowColor = "rgba(30, 14, 4, 0.45)";
  ctx.shadowBlur = 6 * unit;
  ctx.shadowOffsetY = 5 * unit;
  const grad = ctx.createLinearGradient(0, -t, 0, t);
  grad.addColorStop(0, "#f0cf87");
  grad.addColorStop(0.35, "#b8893f");
  grad.addColorStop(1, "#5b3d15");
  ctx.fillStyle = grad;
  ctx.beginPath();
  // Point.
  ctx.moveTo(0, 0);
  ctx.lineTo(len * 0.12, -t * 0.55);
  // Shaft, with a collar before the spatula.
  ctx.lineTo(len * 0.8, -t * 0.55);
  ctx.lineTo(len * 0.82, -t * 0.8);
  ctx.lineTo(len * 0.84, -t * 0.45);
  // Spatula: flat and flared.
  ctx.lineTo(len * 0.9, -t * 0.45);
  ctx.lineTo(len, -t * 1.5);
  ctx.lineTo(len, t * 1.5);
  ctx.lineTo(len * 0.9, t * 0.45);
  ctx.lineTo(len * 0.84, t * 0.45);
  ctx.lineTo(len * 0.82, t * 0.8);
  ctx.lineTo(len * 0.8, t * 0.55);
  ctx.lineTo(len * 0.12, t * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(60, 35, 10, 0.6)";
  ctx.lineWidth = 0.6 * unit;
  ctx.stroke();
  ctx.restore();
}

// ---- sherds --------------------------------------------------------------------------------

function sherdCover(ctx: CanvasRenderingContext2D, s: CoverSubject, W: number, H: number, unit: number, title: string) {
  const r = rng(seedOf(s.id) ^ 0x5bd1e995);
  const spots: [number, number][] = [
    [0.3, 0.3],
    [0.72, 0.28],
    [0.26, 0.72],
    [0.74, 0.74],
    [0.5, 0.2],
    [0.52, 0.8],
  ];
  // A heap of different pots: each piece takes the first id whose fabric isn't used yet.
  const used = new Set<number>();
  const pick = (n: number) => {
    for (let k = 0; k < 40; k++) {
      const id = `${s.id}:s${n}:${k}`;
      const v = sherdShape(id).variant;
      if (!used.has(v) || used.size >= 8) {
        used.add(v);
        return id;
      }
    }
    return `${s.id}:s${n}`;
  };
  const piece = (n: number, withTitle: boolean) => {
    const id = pick(n);
    const shape = sherdShape(id);
    const scale = (W * (withTitle ? 0.78 : 0.5)) / shape.page.width;
    return renderMedium({
      medium: "sherd",
      pageId: id,
      geom: shape.page,
      scale,
      paint: (m) => {
        if (!withTitle || !title) return;
        const g = shape.page;
        m.imprint(title, { x: g.width / 2, y: g.height * 0.46, size: 54, style: "italic 600", font: SERIF, maxWidth: g.width * 0.66, mode: "ink" });
        m.simulate(
          "red",
          Array.from({ length: 14 }, (_, i) => [g.width * (0.3 + i * 0.03), g.height * 0.64 + Math.sin(i / 2) * 5, 0.4] as [number, number, number]),
        );
      },
    });
  };
  spots.forEach(([x, y], n) => place(ctx, piece(n + 1, false), W * x, H * y, (r() - 0.5) * 70, unit, "rgba(40, 18, 6, 0.4)"));
  place(ctx, piece(0, true), W * 0.5, H * 0.5, (r() - 0.5) * 12, unit, "rgba(40, 18, 6, 0.45)");
}

/** One blank sherd as a picture, `width` CSS px wide: a piece lying in the heap to pick from. */
export function sherdPicture(pageId: string, width: number): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = `sherd|${pageId}|${width}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(
    () =>
      new Promise<string | null>((resolve) =>
        setTimeout(() => {
          const shape = sherdShape(pageId);
          const img = renderMedium({ medium: "sherd", pageId, geom: shape.page, scale: (width * dpr) / shape.page.width });
          const url = img?.toDataURL("image/png") ?? null;
          if (url) cache.set(key, url);
          resolve(url);
        }, 0),
      ),
  );
  queue = job;
  return job;
}
