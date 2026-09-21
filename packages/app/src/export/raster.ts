import { font, lightColors as c } from "@companion/design-system";
import { EXPORT_CSS, esc, type ExportPage } from "./pages";
import { buildPdf, type PdfImage, type PdfLink, type PdfPage, type PdfTextRun } from "./pdf";

// Drawing an export page into pixels, for the PNG and PDF formats. The browser is the renderer:
// the page is laid out in a hidden iframe (to measure it, paginate it and find where its words
// sit), then its markup is wrapped in an SVG <foreignObject>, loaded as an image and painted onto
// a 2D canvas. An SVG image can't load anything from outside itself, so everything it shows —
// images, the Geist faces — is inlined as data: URLs first.
//
// Every PNG and PDF is branded: a footer with the Companion lockup on each page.

// ---- Paper ----------------------------------------------------------------------------

/** CSS px (96 to the inch) per PDF point (72 to the inch). */
const PT = 72 / 96;

interface Paper {
  width: number;
  height: number;
}
const A4: Paper = { width: 794, height: 1123 };
const LETTER: Paper = { width: 816, height: 1056 };

/** US Letter where it's the paper people have; A4 everywhere else. */
function paper(): Paper {
  const region = (typeof navigator !== "undefined" ? navigator.language : "").split("-")[1]?.toUpperCase();
  return region && ["US", "CA", "MX", "PH", "CL", "CO", "VE"].includes(region) ? LETTER : A4;
}

const MARGIN_X = 72;
const MARGIN_TOP = 64;
/** The band at the foot of every page that holds the brand. */
const FOOTER_H = 72;

/** Pixels drawn per CSS px. Two keeps text sharp in print and on a retina screen; very large
 *  exports step down so the bitmap stays inside what a canvas can hold. */
function scaleFor(width: number, height: number, maxArea: number): number {
  const MAX_SIDE = 16000;
  return Math.min(2, Math.sqrt(maxArea / (width * height)), MAX_SIDE / Math.max(width, height));
}

// ---- Branding -------------------------------------------------------------------------

export const BRAND_URL = "companionapp.cloud";

// The mark is design-system's BrandMark (tile variant), as markup.
const BRAND_MARK =
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 100 100" fill="none">` +
  `<rect width="100" height="100" rx="14" fill="${c.accent}"/>` +
  `<path d="M61.2 40.48 A13.44 13.44 0 1 0 61.2 59.52" stroke="${c.onAccent}" stroke-width="4.2" stroke-linecap="round" fill="none"/>` +
  `<circle cx="62.32" cy="50" r="4.2" fill="${c.onAccent}"/></svg>`;

const FRAME_CSS = `
.cx-sheet { background: ${c.surfaceCard}; overflow: hidden; display: flex; flex-direction: column; }
.cx-window { overflow: hidden; flex: none; }
.cx-fill { flex: 1; }
.cx-foot { flex: none; height: ${FOOTER_H}px; margin: 0 ${MARGIN_X}px; border-top: 1px solid ${c.borderSubtle}; display: flex; align-items: center; gap: 8px; padding-bottom: 8px; }
.cx-brand { font: 600 15px/18px ${font.sans}; letter-spacing: -0.011em; color: ${c.textPrimary}; }
.cx-foot-note { margin-left: auto; font: 400 10px/14px ${font.mono}; color: ${c.textTertiary}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
.cx-board-head { padding: ${MARGIN_TOP - 16}px ${MARGIN_X}px 0; flex: none; }
.cx-board-wrap { flex: none; display: flex; justify-content: center; }
`;

/** The lockup used in the rail — mark + lowercase "companion" — and a quiet note on the right. */
const footer = (note: string) => `<div class="cx-foot">${BRAND_MARK}<span class="cx-brand">companion</span><span class="cx-foot-note">${esc(note)}</span></div>`;

// ---- Fonts ----------------------------------------------------------------------------

// The app's own stylesheet request (index.html). Google answers with one @font-face per weight
// and script subset, pointing at variable-font files.
const FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap";

interface Face {
  family: string;
  style: string;
  url: string;
  range: string;
  minWeight: number;
  maxWeight: number;
}

let faces: Promise<Face[]> | null = null;
const fontData = new Map<string, Promise<string | null>>();

function timeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function loadFaces(): Promise<Face[]> {
  faces ??= timeout(
    fetch(FONT_CSS_URL)
      .then((res) => (res.ok ? res.text() : ""))
      .then((css) => {
        // A variable font serves every weight from one file: fold the per-weight rules that share
        // a file into one rule spanning them, so the file is embedded once.
        const merged = new Map<string, Face>();
        for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
          const get = (prop: string) => new RegExp(`${prop}:\\s*([^;]+);`).exec(block)?.[1].trim() ?? "";
          const url = /url\(([^)]+)\)/.exec(block)?.[1].replace(/['"]/g, "") ?? "";
          const weight = Number(get("font-weight")) || 400;
          if (!url) continue;
          const family = get("font-family").replace(/['"]/g, "");
          const key = `${family}|${get("font-style")}|${url}`;
          const face = merged.get(key);
          if (face) {
            face.minWeight = Math.min(face.minWeight, weight);
            face.maxWeight = Math.max(face.maxWeight, weight);
          } else merged.set(key, { family, style: get("font-style") || "normal", url, range: get("unicode-range"), minWeight: weight, maxWeight: weight });
        }
        return [...merged.values()];
      })
      .catch(() => []),
    4000,
    [],
  );
  return faces;
}

/** Whether a CSS unicode-range ("U+0000-00FF, U+0131, U+4??") covers any of `used`. */
function rangeCovers(range: string, used: Set<number>): boolean {
  if (!range) return true;
  const spans = range.split(",").map((part) => {
    const [lo, hi] = part.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(lo.replace(/\?/g, "0"), 16), parseInt((hi ?? lo).replace(/\?/g, "F"), 16)];
  });
  for (const cp of used) if (spans.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  return false;
}

async function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** @font-face rules for Geist with the font files inlined — only the script subsets `text` uses.
 *  Empty when the fonts can't be fetched (offline): the export falls back to the system UI font,
 *  as the app itself does. */
async function fontCss(text: string): Promise<string> {
  const used = new Set<number>();
  for (const ch of text) used.add(ch.codePointAt(0)!);
  const rules = await Promise.all(
    (await loadFaces())
      .filter((f) => rangeCovers(f.range, used))
      .map(async (f) => {
        if (!fontData.has(f.url)) fontData.set(f.url, timeout(toDataUrl(f.url), 6000, null));
        const data = await fontData.get(f.url)!;
        if (!data) return "";
        const weight = f.minWeight === f.maxWeight ? `${f.minWeight}` : `${f.minWeight} ${f.maxWeight}`;
        return `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${weight}; src: url(${data}) format("woff2");${f.range ? ` unicode-range: ${f.range};` : ""} }`;
      }),
  );
  return rules.join("\n");
}

// ---- Layout ---------------------------------------------------------------------------

interface Mounted {
  doc: Document;
  root: HTMLElement;
  dispose: () => void;
}

/** Lays `html` out `width` px wide in a hidden iframe — isolated from the app's own styles —
 *  with every image inlined and loaded, and fonts ready. */
async function mount(html: string, css: string, width: number): Promise<Mounted> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:400px;border:0;visibility:hidden;pointer-events:none;`;
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body></body></html>`);
  doc.close();
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.appendChild(style);
  const root = doc.createElement("div");
  root.className = "cx-root";
  root.style.width = `${width}px`;
  root.innerHTML = html;
  doc.body.appendChild(root);

  // An SVG image can't reach the network: inline what can be fetched, and let what can't (a
  // remote image with no CORS) stand as its alt text or address.
  await Promise.all(
    Array.from(root.querySelectorAll("img")).map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      const data = src ? await timeout(toDataUrl(src), 8000, null) : null;
      if (data) {
        img.src = data;
        await img.decode().catch(() => undefined);
      } else {
        const chip = doc.createElement("span");
        chip.className = "pm-file";
        chip.textContent = img.alt || src || "image";
        img.replaceWith(chip);
      }
    }),
  );
  await timeout(doc.fonts.ready.then(() => undefined), 3000, undefined);
  return { doc, root, dispose: () => frame.remove() };
}

/** Where to cut a flow of `total` px into pages at most `pageH` tall: between blocks rather than
 *  through a line of text, and never right after a heading. */
function pageBreaks(root: HTMLElement, total: number, pageH: number): number[] {
  const origin = root.getBoundingClientRect().top;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, pre, tr, hr, img, .cx-eyebrow, .cx-task-head, .cx-meta-row"));
  const set = new Set<Element>(candidates);
  const nested = (el: Element) => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (set.has(p)) return true;
    return false;
  };
  const units = candidates
    .filter((el) => !nested(el))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - origin, bottom: r.bottom - origin, heading: /^H[1-6]$/.test(el.tagName) || el.classList.contains("cx-eyebrow") };
    })
    .sort((a, b) => a.top - b.top);

  const breaks = [0];
  let start = 0;
  while (start + pageH < total) {
    const limit = start + pageH;
    let cut = limit;
    for (const u of units) if (u.top < limit && u.bottom > limit && u.top > start) cut = Math.min(cut, u.top);
    // A heading belongs with what follows it.
    for (let guard = 0; guard < 4; guard++) {
      const last = units.filter((u) => u.top >= start && u.bottom <= cut + 0.5).pop();
      if (!last?.heading || last.top <= start) break;
      cut = last.top;
    }
    cut = Math.floor(cut);
    if (cut <= start) cut = limit;
    breaks.push(cut);
    start = cut;
  }
  return breaks;
}

interface Placed {
  /** px from the root's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every word of the layout and where it sits — the PDF's text layer. */
function words(root: HTMLElement): (Placed & { text: string; size: number })[] {
  const origin = root.getBoundingClientRect();
  const out: (Placed & { text: string; size: number })[] = [];
  const sizes = new Map<Element, number>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = root.ownerDocument.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.nodeValue ?? "";
    if (!parent || !text.trim() || parent.closest("style, script")) continue;
    if (!sizes.has(parent)) sizes.set(parent, parseFloat(getComputedStyle(parent).fontSize) || 14);
    // Text a board's card clips isn't on the page; keep it out of the layer too.
    const clip = parent.closest(".cx-card, .cx-sticky, .cx-group-label")?.getBoundingClientRect();
    for (const m of text.matchAll(/\S+/g)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getClientRects()[0];
      if (!r || r.width <= 0) continue;
      if (clip && (r.bottom > clip.bottom + 1 || r.right > clip.right + 1)) continue;
      out.push({ text: m[0], size: sizes.get(parent)!, x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
    }
  }
  return out;
}

function links(root: HTMLElement): (Placed & { url: string })[] {
  const origin = root.getBoundingClientRect();
  const out: (Placed & { url: string })[] = [];
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const url = a.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(url)) continue;
    for (const r of Array.from(a.getClientRects())) out.push({ url, x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
  }
  return out;
}

// ---- Painting -------------------------------------------------------------------------

/** The layout's markup as XML, fit to sit inside an SVG. */
function xhtml(root: HTMLElement): string {
  // XML has no way to carry most control characters, and one of them fails the whole image.
  // eslint-disable-next-line no-control-regex
  return new XMLSerializer().serializeToString(root).replace(/[ --￾￿]/g, "");
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// WebKit paints an SVG image before the images inside it have decoded; loading it a second time
// finds them ready.
const WEBKIT = typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The export couldn’t be drawn."));
    img.src = url;
  });
}

/** Paints one sheet — `inner` is its XHTML — onto a canvas `scale` pixels per CSS px. */
async function paint(inner: string, css: string, width: number, height: number, scale: number): Promise<HTMLCanvasElement> {
  // The SVG stays at CSS size and the canvas does the scaling: WebKit misplaces positioned HTML
  // inside a foreignObject under an SVG transform, which a scaling viewBox would be.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="cx-sheet" style="width:${width}px;height:${height}px;"><style>${xmlText(css)}</style>${inner}</div>` +
    `</foreignObject></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  let img = await loadImage(url);
  if (WEBKIT && inner.includes("<img")) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    img = await loadImage(url);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The export couldn’t be drawn.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function blobOf(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("The export couldn’t be encoded."));
        void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      },
      type,
      quality,
    );
  });
}

/** A painted sheet as a PDF image: lossless where the browser can deflate (text stays crisp),
 *  JPEG where it can't. */
async function pdfImage(canvas: HTMLCanvasElement): Promise<PdfImage> {
  const { width, height } = canvas;
  if (typeof CompressionStream === "undefined") return { width, height, encoding: "jpeg", data: await blobOf(canvas, "image/jpeg", 0.92) };
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  const deflated = new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"));
  return { width, height, encoding: "flate", data: new Uint8Array(await new Response(deflated).arrayBuffer()) };
}

// ---- Sheets ---------------------------------------------------------------------------

/** One sheet to paint, and what lies on it for the PDF's text layer. */
interface Sheet {
  width: number;
  height: number;
  inner: string;
  text: PdfTextRun[];
  links: PdfLink[];
}

/** Moves layout-space boxes onto a sheet: those inside [top, bottom), shifted by (dx, dy). */
function place<T extends Placed>(items: T[], top: number, bottom: number, dx: number, dy: number): T[] {
  return items.filter((i) => i.y + i.height / 2 >= top && i.y + i.height / 2 < bottom).map((i) => ({ ...i, x: i.x + dx, y: i.y - top + dy }));
}

const runsOf = (items: (Placed & { text: string; size: number })[]): PdfTextRun[] =>
  // The baseline sits about four fifths down a line box.
  items.map((w) => ({ text: w.text, x: w.x * PT, y: (w.y + w.height * 0.78) * PT, size: w.size * PT, width: w.width * PT }));
const linksOf = (items: (Placed & { url: string })[]): PdfLink[] => items.map((l) => ({ url: l.url, x: l.x * PT, y: l.y * PT, width: l.width * PT, height: l.height * PT }));

/** A flow page cut into paper-sized sheets (`paginate`), or left as one long sheet. */
async function flowSheets(page: ExportPage, css: string, paginate: boolean): Promise<Sheet[]> {
  const { width, height } = paper();
  const contentW = width - MARGIN_X * 2;
  const m = await mount(page.html, css, contentW);
  try {
    const total = Math.ceil(m.root.getBoundingClientRect().height);
    const pageH = height - MARGIN_TOP - FOOTER_H;
    const breaks = paginate ? pageBreaks(m.root, total, pageH) : [0];
    const body = xhtml(m.root);
    const allWords = paginate ? words(m.root) : [];
    const allLinks = paginate ? links(m.root) : [];
    return breaks.map((top, i) => {
      const bottom = breaks[i + 1] ?? total;
      const sheetH = paginate ? height : MARGIN_TOP + total + 24 + FOOTER_H;
      const note = paginate && breaks.length > 1 ? `${BRAND_URL} · ${i + 1} / ${breaks.length}` : BRAND_URL;
      const inner =
        `<div style="height:${MARGIN_TOP}px;flex:none;"></div>` +
        `<div class="cx-window" style="margin:0 ${MARGIN_X}px;width:${contentW}px;height:${bottom - top}px;"><div style="margin-top:${-top}px;">${body}</div></div>` +
        `<div class="cx-fill"></div>${footer(note)}`;
      return {
        width,
        height: sheetH,
        inner,
        text: runsOf(place(allWords, top, bottom, MARGIN_X, MARGIN_TOP)),
        links: linksOf(place(allLinks, top, bottom, MARGIN_X, MARGIN_TOP)),
      };
    });
  } finally {
    m.dispose();
  }
}

/** A board under its title, over the brand footer — one sheet, as big as the board. */
async function boardSheet(page: ExportPage, css: string, withText: boolean): Promise<Sheet> {
  const width = Math.max(page.width ?? 0, 480);
  const head = `<div class="cx-board-head"><div class="cx-eyebrow">Canvas</div><h1 class="cx-title" style="margin-bottom:0;">${esc(page.title)}</h1></div>`;
  const m = await mount(`<div style="display:flex;flex-direction:column;">${head}<div class="cx-board-wrap">${page.html}</div></div>`, css, width);
  try {
    const height = Math.ceil(m.root.getBoundingClientRect().height) + FOOTER_H;
    return {
      width,
      height,
      inner: `${xhtml(m.root)}<div class="cx-fill"></div>${footer(BRAND_URL)}`,
      text: withText ? runsOf(words(m.root)) : [],
      links: [],
    };
  } finally {
    m.dispose();
  }
}

async function stylesheet(page: ExportPage): Promise<string> {
  const text = `${page.title} ${page.html.replace(/<[^>]*>/g, " ")} companion ${BRAND_URL} 0123456789/·`;
  return `${await fontCss(text)}\n${EXPORT_CSS}\n${FRAME_CSS}`;
}

/** The page as one PNG: a flow page as a single long sheet, a board at its own size. */
export async function renderPng(page: ExportPage): Promise<Uint8Array> {
  const css = await stylesheet(page);
  const sheet = page.layout === "board" ? await boardSheet(page, css, false) : (await flowSheets(page, css, false))[0];
  const canvas = await paint(sheet.inner, css, sheet.width, sheet.height, scaleFor(sheet.width, sheet.height, 64e6));
  return blobOf(canvas, "image/png");
}

/** The page as a PDF: a flow page on A4/Letter sheets, a board on one sheet cut to its size. */
export async function renderPdf(page: ExportPage): Promise<Uint8Array> {
  const css = await stylesheet(page);
  const sheets = page.layout === "board" ? [await boardSheet(page, css, true)] : await flowSheets(page, css, true);
  const pages: PdfPage[] = [];
  for (const sheet of sheets) {
    const canvas = await paint(sheet.inner, css, sheet.width, sheet.height, scaleFor(sheet.width, sheet.height, 24e6));
    // PDF caps a page at 14,400 points a side; a vast board is scaled onto the largest sheet.
    const fit = Math.min(1, 14400 / (Math.max(sheet.width, sheet.height) * PT));
    pages.push({
      width: sheet.width * PT * fit,
      height: sheet.height * PT * fit,
      image: await pdfImage(canvas),
      text: sheet.text.map((t) => ({ ...t, x: t.x * fit, y: t.y * fit, size: t.size * fit, width: t.width * fit })),
      links: sheet.links.map((l) => ({ ...l, x: l.x * fit, y: l.y * fit, width: l.width * fit, height: l.height * fit })),
    });
    // Let go of the bitmap before the next page allocates its own.
    canvas.width = canvas.height = 0;
  }
  return buildPdf(pages, { title: page.title });
}
