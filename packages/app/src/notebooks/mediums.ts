import type { NotebookMedium, WaxLeaves } from "@companion/core-bridge";
import type { IconName } from "@companion/design-system";
import { PAGE, type PageGeometry, type PaperStyle } from "./paper";

// Notebook mediums (PLAN-notebooks.md §11): paper, and three older ways of keeping notes,
// each a set of design constraints with some history in it. Clay, wax and sherds are written
// with a pen only, no keyboard: their pages are surfaces the pen works on (mediumEngine.ts),
// pressed, scratched or brushed. The core keeps a wax codex's leaves fixed; this file holds
// what the app needs to show each medium: its geometry, tools, words and history. Pure data,
// like paper.ts, so the native WebView bundle renders the same objects.

export type { NotebookMedium, WaxLeaves };

/** A pen tool on an ancient medium. */
export type MediumToolId = "stylus" | "wedge" | "thumb" | "point" | "flat" | "black" | "red" | "scrape";

/** Tool sizes: fine, medium, broad, as multipliers on the tool's width. */
export type MediumSize = 0 | 1 | 2;
export const MEDIUM_SIZES: { size: MediumSize; label: string; scale: number }[] = [
  { size: 0, label: "Fine", scale: 0.55 },
  { size: 1, label: "Medium", scale: 1 },
  { size: 2, label: "Broad", scale: 1.7 },
];

export interface MediumTool {
  id: MediumToolId;
  label: string;
  icon: IconName;
  /** A swatch for ink tools. */
  swatch?: string;
}

export interface MediumSpec {
  id: NotebookMedium;
  label: string;
  /** What one page is called, singular and plural. */
  noun: string;
  nouns: string;
  /** The sheet, at 100%. Sherds vary per piece (sherdShape); this is the largest. */
  page: PageGeometry;
  /** Paper grows by whole rules when its text runs long. Nothing else stretches. */
  grows: boolean;
  /** How pages are laid out: "book" pages two-up or scrolls (the reader chooses), "scroll" is
   *  always a scrolling list (clay tablets are a pile, not a codex), "grid" wraps (sherds). */
  flow: "book" | "scroll" | "grid";
  /** The paper a new page gets (paper pages choose their own; others don't use it). */
  paper: PaperStyle | null;
  /** The pen tools. Empty for paper, which types and uses the ordinary drawing tools. */
  tools: MediumTool[];
  /** Page actions, as the toolbar words them. Null: this medium can't. */
  addLabel: string | null;
  deleteLabel: string | null;
  deleteConfirm: { title: string; message: string } | null;
  /** Clear the whole page at once. */
  smooth: { label: string; title: string; message: string; confirm: string } | null;
  /** One line for the picker. */
  tagline: string;
  /** The rules, as the picker lists them. */
  rules: string[];
  /** Where it comes from: a few sentences. */
  history: string;
}

export const MEDIUMS: Record<NotebookMedium, MediumSpec> = {
  paper: {
    id: "paper",
    label: "Paper notebook",
    noun: "page",
    nouns: "pages",
    page: PAGE,
    grows: true,
    flow: "book",
    paper: null,
    tools: [],
    addLabel: "Add page after this one",
    deleteLabel: "Delete this page",
    deleteConfirm: { title: "Delete this page?", message: "The page and its ink are deleted right away. Pages do not go to the Trash." },
    smooth: null,
    tagline: "A5 pages, lined, grid, dots or blank. Type and draw.",
    rules: ["Pages grow as you write", "Add, delete and re-rule pages freely"],
    history: "The bound paper notebook is the newest medium here: cheap paper only arrived in Europe in the 12th century, and the pocket notebook in the 16th.",
  },
  clay: {
    id: "clay",
    label: "Clay tablets",
    noun: "tablet",
    nouns: "tablets",
    page: { width: 372, height: 480, marginX: 0, marginTop: 0, marginBottom: 0 },
    grows: false,
    flow: "scroll",
    paper: { kind: "blank", spacing: 28 },
    tools: [
      { id: "stylus", label: "Stylus", icon: "pen" },
      { id: "wedge", label: "Wedge", icon: "arrow" },
      { id: "thumb", label: "Thumb", icon: "eraser" },
    ],
    addLabel: "Shape a new tablet",
    deleteLabel: "Squash this tablet",
    deleteConfirm: { title: "Squash this tablet?", message: "It goes back into the lump, with every mark on it." },
    smooth: { label: "Knead it flat", title: "Knead this tablet flat?", message: "Every impression on it is worked back into the clay.", confirm: "Knead it" },
    tagline: "Soft red clay. Press marks in with a reed; no keyboard.",
    rules: [
      "Pen only: a stylus carves grooves and the clay it moves heaps up at the sides",
      "The wedge presses cuneiform: tap for a wedge, drag to aim and stretch it",
      "Rub with your thumb to smooth a mistake away",
    ],
    history:
      "Mesopotamian scribes pressed a cut reed into damp clay from around 3200 BCE, first as tallies of grain and sheep and later as letters, laws and the Epic of Gilgamesh. The square end of the reed left the wedge-shaped marks that give cuneiform its name. Everyday tablets were only sun-dried and could be wetted and reused; many of the half-million we have survived because the libraries holding them burned and baked them, like Ashurbanipal's at Nineveh in 612 BCE.",
  },
  wax: {
    id: "wax",
    label: "Wax tablets",
    noun: "leaf",
    nouns: "leaves",
    page: { width: 470, height: 610, marginX: 0, marginTop: 0, marginBottom: 0 },
    grows: false,
    flow: "book",
    paper: { kind: "blank", spacing: 28 },
    tools: [
      { id: "point", label: "Point", icon: "pen" },
      { id: "flat", label: "Flat end", icon: "eraser" },
    ],
    addLabel: null,
    deleteLabel: null,
    deleteConfirm: null,
    smooth: {
      label: "Smooth this leaf",
      title: "Smooth this leaf?",
      message: "The flat of the stylus presses the wax level again. Everything scratched into this leaf is gone.",
      confirm: "Smooth it",
    },
    tagline: "Honey beeswax in wooden frames, bound as a codex. Scratch, smooth, reuse.",
    rules: [
      "Pen only: the point drags in the wax, so curves come out as runs of straight scratches",
      "Each scratch curls a burr of wax up beside it",
      "Bound with its leaves: smooth one flat to write on it again",
    ],
    history:
      "Greeks and Romans wrote with a bronze or bone stylus on beeswax poured into a hollowed wooden board. The other end of the stylus was a flat spatula for smoothing mistakes away, and a tablet wiped clean was a tabula rasa. Dragging a point through wax is why Roman cursive is angular. Leaves were tied into diptychs and polyptychs, the first codex; they held schoolwork, drafts, accounts and letters, like the tablets of the banker Caecilius Iucundus found at Pompeii.",
  },
  sherd: {
    id: "sherd",
    label: "Potsherds",
    noun: "sherd",
    nouns: "sherds",
    page: { width: 440, height: 340, marginX: 0, marginTop: 0, marginBottom: 0 },
    grows: false,
    flow: "grid",
    paper: { kind: "blank", spacing: 24 },
    tools: [
      { id: "black", label: "Carbon", icon: "pen", swatch: "#1c1714" },
      { id: "red", label: "Ochre", icon: "pen", swatch: "#8e2d17" },
      { id: "scrape", label: "Scrape", icon: "eraser" },
    ],
    addLabel: "Pick up another sherd",
    deleteLabel: "Throw this sherd away",
    deleteConfirm: { title: "Throw this sherd away?", message: "It goes back on the rubbish heap, with whatever is written on it." },
    smooth: null,
    tagline: "Broken pottery: every piece a different pot. Brush ink on; no keyboard.",
    rules: [
      "Pen only: a reed brush that thins when flicked and runs dry into streaks",
      "Every sherd is a different pot, from two dozen wares: red- and black-figure, terra sigillata, blue-and-white, celadon, lustreware, cord-marked and more",
      "Ink soaks into bare clay and beads on glaze; scrape it off with a blade",
    ],
    history:
      "Broken pots were everywhere and cost nothing, so people wrote on the pieces (ostraca) with a reed brush and ink. Egyptian workmen at Deir el-Medina used them for receipts, shopping lists, school exercises and sketches; Athenians scratched a name on one to vote a politician into exile, which is where ostracism gets its name; and the Lachish letters of about 588 BCE are military dispatches on sherds.",
  },
};

export const MEDIUM_ORDER: NotebookMedium[] = ["paper", "clay", "wax", "sherd"];

export const WAX_BINDINGS: { leaves: WaxLeaves; label: string }[] = [
  { leaves: 2, label: "Diptych · 2" },
  { leaves: 3, label: "Triptych · 3" },
  { leaves: 8, label: "Polyptych · 8" },
];

export function mediumOf(settings: { medium?: unknown } | null | undefined): NotebookMedium {
  const m = settings?.medium;
  return m === "clay" || m === "wax" || m === "sherd" ? m : "paper";
}

export function countLabel(medium: NotebookMedium, n: number): string {
  const spec = MEDIUMS[medium];
  return `${n} ${n === 1 ? spec.noun : spec.nouns}`;
}

// ---- sherds ------------------------------------------------------------------------------
// No two sherds are alike: each page's size, broken outline and fabric come from its id, so
// every device breaks the same pot the same way.

/** Pottery fabrics, in the shader's order. */
export const SHERD_FABRICS = [
  "Red ware",
  "Buff ware",
  "Grey ware",
  "Black gloss",
  "Green glaze",
  "Painted",
  "Cooking pot",
  "Faience",
  "Red-figure",
  "Black-figure",
  "Terra sigillata",
  "Blue-and-white",
  "Celadon",
  "Maiolica",
  "Lustreware",
  "Cardial ware",
  "Cord-marked",
  "Salt glaze",
  "Tortoiseshell",
  "Egyptian blue-painted",
  "Marine style",
  "Bucchero",
  "Rouletted ware",
  "Feathered slipware",
] as const;

function seeded(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export interface SherdShape {
  page: PageGeometry;
  /** Outline corners, in percent of the sheet. */
  points: [number, number][];
  /** Index into SHERD_FABRICS. */
  variant: number;
  /** Direction of the throwing lines, radians. */
  wheel: number;
}

const sherdCache = new Map<string, SherdShape>();

export function sherdShape(pageId: string): SherdShape {
  const hit = sherdCache.get(pageId);
  if (hit) return hit;
  const rand = seeded(pageId);
  const max = MEDIUMS.sherd.page;
  const width = Math.round(max.width - rand() * 110);
  const height = Math.round(max.height - rand() * 90);
  // A few long straight breaks, not a wobbly blob: 6 to 9 corners round a squarish ellipse.
  const n = 6 + Math.floor(rand() * 4);
  const turn = rand() * Math.PI * 2;
  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = turn + ((i + (rand() - 0.5) * 0.6) / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const r = 0.5 - rand() * 0.08;
    points.push([50 + Math.sign(c) * Math.pow(Math.abs(c), 0.55) * r * 100, 50 + Math.sign(s) * Math.pow(Math.abs(s), 0.55) * r * 100]);
  }
  const shape: SherdShape = {
    page: { width, height, marginX: 0, marginTop: 0, marginBottom: 0 },
    points,
    variant: Math.floor(rand() * SHERD_FABRICS.length),
    wheel: rand() * Math.PI,
  };
  sherdCache.set(pageId, shape);
  return shape;
}

/** One page's sheet: the medium's geometry, or this sherd's own. */
export function pageGeometry(medium: NotebookMedium, pageId: string): PageGeometry {
  return medium === "sherd" ? sherdShape(pageId).page : MEDIUMS[medium].page;
}

/** The page view's styles for the pen-only sheets. The objects draw themselves (a WebGL
 *  canvas with its own alpha), so the sheet is bare and the shadow follows the shape. */
export function mediumCss(): string {
  return `
.nb-slot[data-medium="clay"] { filter: drop-shadow(0 12px 14px rgba(60, 22, 8, 0.32)) drop-shadow(0 2px 2px rgba(60, 22, 8, 0.3)); }
.nb-slot[data-medium="wax"] { filter: drop-shadow(0 14px 18px rgba(40, 22, 8, 0.34)) drop-shadow(0 2px 2px rgba(40, 22, 8, 0.35)); }
.nb-slot[data-medium="sherd"] { filter: drop-shadow(0 8px 9px rgba(40, 18, 6, 0.34)) drop-shadow(0 1px 1px rgba(40, 18, 6, 0.4)); }
.nb-msheet { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.nb-msheet canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: pan-x pan-y; cursor: crosshair; }
.nb-msheet[data-touch="true"] canvas { touch-action: none; }
.nb-msheet[data-smoothing="true"] canvas { animation: nb-smooth 650ms ease-in-out; }
@keyframes nb-smooth { 50% { filter: blur(3px) brightness(1.08); } }
.nb-msheet .nb-guide { z-index: 3; }
.nb-flow[data-mode="grid"] { flex-direction: row; flex-wrap: wrap; justify-content: center; align-items: center; align-content: flex-start; gap: 36px 44px; }
.nb-heap { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(20, 14, 10, 0.42); backdrop-filter: blur(2px); }
.nb-heap-card { width: min(760px, 94%); background: radial-gradient(120% 90% at 50% 40%, #b59a78, #7e6446); border-radius: 14px; box-shadow: 0 30px 60px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.12); overflow: hidden; }
.nb-heap-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; font: 600 14px Geist, system-ui, sans-serif; color: #2b1d10; background: rgba(255, 240, 215, 0.35); }
.nb-heap-actions { display: flex; gap: 8px; }
.nb-heap-actions button { font: 500 12px Geist, system-ui, sans-serif; color: #2b1d10; background: rgba(255,255,255,0.55); border: 1px solid rgba(60,40,20,0.2); border-radius: 7px; padding: 5px 10px; cursor: pointer; }
.nb-heap-actions button:hover { background: rgba(255,255,255,0.8); }
.nb-heap-pile { position: relative; height: 440px; background-image: radial-gradient(rgba(60,40,20,0.25) 1px, transparent 1.5px); background-size: 7px 9px; }
.nb-heap-piece { position: absolute; transform: translate(-50%, -50%) rotate(var(--turn)); padding: 0; border: 0; background: none; cursor: pointer; filter: drop-shadow(0 6px 6px rgba(30, 14, 4, 0.45)); transition: transform 160ms ease, filter 160ms ease; }
.nb-heap-piece img { display: block; width: 100%; height: auto; pointer-events: none; }
.nb-heap-piece:hover, .nb-heap-piece:focus-visible { z-index: 20 !important; transform: translate(-50%, -58%) rotate(calc(var(--turn) * 0.4)) scale(1.08); filter: drop-shadow(0 16px 14px rgba(30, 14, 4, 0.5)); outline: none; }
.nb-binding { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 2; }
`;
}
