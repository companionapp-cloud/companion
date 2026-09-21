import { concat } from "./zip";

// A small PDF writer for exports. Each page is the picture the browser drew of it (raster.ts) —
// the only renderer that gets every script, emoji and embedded image right without shipping fonts
// — under an invisible text layer placed word by word, so the file still selects, copies and
// searches like a text PDF, and with link annotations over the links. No dependency: the format
// needed here is a catalog, a page tree, one image and one content stream per page.

/** A word of the text layer. Coordinates are PDF points from the page's top-left corner. */
export interface PdfTextRun {
  text: string;
  x: number;
  /** The baseline. */
  y: number;
  /** Font size. */
  size: number;
  /** The width the word occupies on the page; the layer's font is stretched to match. */
  width: number;
}

export interface PdfLink {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfImage {
  width: number;
  height: number;
  /** "flate": zlib-deflated 8-bit RGB rows. "jpeg": a JPEG file. */
  encoding: "flate" | "jpeg";
  data: Uint8Array;
}

export interface PdfPage {
  /** Page size in points. */
  width: number;
  height: number;
  image: PdfImage;
  text: PdfTextRun[];
  links: PdfLink[];
}

// Helvetica's advance widths for 0x20–0x7E (Adobe's AFM, 1/1000 em): the text layer is set in
// it, and each word is stretched from this natural width to the width the browser gave it.
// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// The punctuation WinAnsiEncoding places outside Latin-1.
const WIN_ANSI: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

/** `text` as WinAnsi bytes plus its natural Helvetica width (1/1000 em). Characters the
 *  encoding can't hold are dropped from the layer — they're still in the picture. */
function winAnsi(text: string): { bytes: number[]; width: number } {
  const bytes: number[] = [];
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const code = WIN_ANSI[ch] ?? (cp >= 0x20 && cp <= 0x7e ? cp : cp >= 0xa0 && cp <= 0xff ? cp : -1);
    if (code < 0) continue;
    bytes.push(code);
    width += code >= 0x20 && code <= 0x7e ? HELVETICA[code - 0x20] : 556;
  }
  return { bytes, width };
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

/** Bytes as a PDF literal string. */
function literal(bytes: number[]): string {
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** A text string for the info dictionary: UTF-16BE with a byte-order mark, in hex. */
function textString(s: string): string {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `(D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

function pageContent(page: PdfPage): string {
  // The picture, stretched over the whole page; then the text layer in render mode 3 (neither
  // filled nor stroked). PDF's origin is the bottom-left corner, hence the flipped y.
  let out = `q ${num(page.width)} 0 0 ${num(page.height)} 0 0 cm /Im0 Do Q\n`;
  if (!page.text.length) return out;
  out += "BT 3 Tr\n";
  for (const run of page.text) {
    const { bytes, width } = winAnsi(run.text);
    if (!bytes.length || run.size <= 0) continue;
    const natural = (width / 1000) * run.size;
    const stretch = natural > 0 && run.width > 0 ? Math.max(10, Math.min(400, (run.width / natural) * 100)) : 100;
    out += `/F1 ${num(run.size)} Tf ${num(stretch)} Tz 1 0 0 1 ${num(run.x)} ${num(page.height - run.y)} Tm ${literal(bytes)} Tj\n`;
  }
  return `${out}ET\n`;
}

export function buildPdf(pages: PdfPage[], info: { title: string; created?: Date }): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  /** Writes object `id` — a dictionary, optionally with a stream. */
  const object = (id: number, dict: string, stream?: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${dict}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  // 1 catalog, 2 page tree, 3 font, 4 info; then three objects a page: page, content, image.
  const pageId = (i: number) => 5 + i * 3;
  push("%PDF-1.4\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  object(4, `<< /Title ${textString(info.title)} /Creator ${textString("Companion")} /Producer ${textString("Companion")} /CreationDate ${pdfDate(info.created ?? new Date())} >>`);

  pages.forEach((page, i) => {
    const id = pageId(i);
    const annots = page.links
      .map((l) => {
        const rect = [l.x, page.height - l.y - l.height, l.x + l.width, page.height - l.y].map(num).join(" ");
        return `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI ${literal(winAnsi(l.url).bytes)} >> >>`;
      })
      .join(" ");
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${id + 1} 0 R ` +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${id + 2} 0 R >> >>${annots ? ` /Annots [${annots}]` : ""} >>`,
    );
    const content = encoder.encode(pageContent(page));
    object(id + 1, `<< /Length ${content.length} >>`, content);
    const { image } = page;
    object(
      id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /${image.encoding === "flate" ? "FlateDecode" : "DCTDecode"} /Length ${image.data.length} >>`,
      image.data,
    );
  });

  const count = 5 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${count} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks);
}
