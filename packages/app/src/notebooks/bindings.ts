import type { Booklet, NotebookBinding } from "@companion/core-bridge";
import { PAGE, type PageGeometry, type PaperStyle } from "./paper";

// Notebook bindings (PLAN-notebooks.md §12): how a paper notebook is held together. Like a
// medium, a binding is a set of physical rules with some history in it, chosen when the
// notebook is made. The core keeps the rules (which pages can be added, torn out, reordered or
// moved); this file holds what the app needs to show each binding: its page, how its pages
// flow, its words and its history. A paper notebook made without a binding has none, and keeps
// the original rules. Pure data, like mediums.ts, so the native WebView bundle reads the same.

export type { Booklet, NotebookBinding };

/** How pages are laid out. "book" pages two-up or scrolls; "pad" turns one page at a time
 *  sideways (or scrolls), "pad-top" flips them up over the top; "grid" lays cards out on a
 *  table; "strip" unfolds a concertina sideways. */
export type BindingFlow = "book" | "pad" | "pad-top" | "grid" | "strip";

export interface BindingSpec {
  id: NotebookBinding;
  label: string;
  /** What one page is called, singular and plural. */
  noun: string;
  nouns: string;
  page: PageGeometry;
  /** Pages grow by whole rules as their text runs long. A card doesn't. */
  grows: boolean;
  flow: BindingFlow;
  /** The paper a new page gets, when the binding decides it. */
  paper: PaperStyle | null;
  /** The sizes it's made in (page counts), the first the default. Null: it starts with one page
   *  and grows. */
  sizes: number[] | null;
  /** Page actions, as the toolbar words them. Null: this binding can't. */
  addLabel: string | null;
  deleteLabel: string | null;
  deleteConfirm: { title: string; message: string } | null;
  /** Pages can be put in a new order (and a box of cards shuffled). */
  reorder: boolean;
  /** Pages can be taken out and clipped into another notebook of the same binding. */
  move: boolean;
  /** One line for the picker. */
  tagline: string;
  /** The rules, as the picker lists them. */
  rules: string[];
  /** Where it comes from: a few sentences. */
  history: string;
}

export const BINDINGS: Record<NotebookBinding, BindingSpec> = {
  sewn: {
    id: "sewn",
    label: "Sewn journal",
    noun: "page",
    nouns: "pages",
    page: PAGE,
    grows: true,
    flow: "book",
    paper: null,
    sizes: [96, 48, 192],
    addLabel: null,
    deleteLabel: null,
    deleteConfirm: null,
    reorder: false,
    move: false,
    tagline: "Signatures sewn through the fold, with a ribbon. Every page there from the start.",
    rules: ["Made with all its pages: none added, none torn out", "Pages are numbered and stay in order", "A ribbon keeps your place"],
    history:
      "Printers fold big sheets into signatures and sew each one through its fold to the next. David Smyth patented a machine for it in 1868, and a Smyth-sewn book still opens flat and can't lose a page without it showing. Lab books are sewn for that reason: a court can trust a notebook with no pages missing.",
  },
  spiral: {
    id: "spiral",
    label: "Spiral notebook",
    noun: "page",
    nouns: "pages",
    page: PAGE,
    grows: true,
    flow: "pad",
    paper: null,
    sizes: [80, 40, 120],
    addLabel: null,
    deleteLabel: "Tear out this page",
    deleteConfirm: { title: "Tear out this page?", message: "It comes away along the perforation, with everything on it, and leaves a scrap in the coil. A torn page can't go back in." },
    reorder: false,
    move: false,
    tagline: "A wire coil through punched holes. Lies flat; pages tear out along the perforation.",
    rules: ["Made with all its pages: none added", "Tear a page out along the perforation; it can't go back", "One page at a time, flat on the table"],
    history:
      "Edmund Lindner, a German bookbinder, patented the spiral binding in 1932 after watching wire fences go up. It let a notebook fold back on itself and lie flat, and the perforated edge followed so pages could be torn away cleanly: the school exercise book of the twentieth century.",
  },
  topbound: {
    id: "topbound",
    label: "Reporter's pad",
    noun: "page",
    nouns: "pages",
    page: { width: 400, height: 720, marginX: 28, marginTop: 56, marginBottom: 36 },
    grows: true,
    flow: "pad-top",
    paper: null,
    sizes: [70, 40, 100],
    addLabel: null,
    deleteLabel: "Tear off this page",
    deleteConfirm: { title: "Tear off this page?", message: "It comes away from the coil, with everything on it. A torn page can't go back in." },
    reorder: false,
    move: false,
    tagline: "Narrow, bound along the top, and flipped over one-handed. For notes taken standing up.",
    rules: ["Made with all its pages: none added", "Pages flip up over the top", "Tear a page off; it can't go back"],
    history:
      "Stenographers wrote Gregg and Pitman shorthand on narrow pads bound at the top, so a page could be flipped over with one hand without losing the line. Reporters took the pad into press galleries and onto doorsteps; it fits a jacket pocket and stands a pen in its coil.",
  },
  ring: {
    id: "ring",
    label: "Ring binder",
    noun: "page",
    nouns: "pages",
    page: PAGE,
    grows: true,
    flow: "book",
    paper: null,
    sizes: null,
    addLabel: "Add page after this one",
    deleteLabel: "Take out this page",
    deleteConfirm: { title: "Take out this page?", message: "The page and its ink are deleted right away. Pages do not go to the Trash." },
    reorder: true,
    move: true,
    tagline: "Punched pages on rings. Anything goes: add, reorder, and move pages to another binder.",
    rules: ["Add a page anywhere", "Put pages in any order", "Unclip a page and move it to another ring binder"],
    history:
      "Friedrich Soennecken, a German stationer, patented the ring binder and the two-hole punch in 1886. Loose pages could finally be kept in order and re-filed; the Filofax, a six-ring personal organiser, followed in 1921 and became the thing to carry in the 1980s.",
  },
  saddle: {
    id: "saddle",
    label: "Stapled pocket notebook",
    noun: "page",
    nouns: "pages",
    page: { width: 336, height: 528, marginX: 24, marginTop: 36, marginBottom: 32 },
    grows: true,
    flow: "book",
    paper: null,
    sizes: [16, 32, 48],
    addLabel: "Fold in a sheet",
    deleteLabel: "Take out this sheet",
    deleteConfirm: {
      title: "Take out this sheet?",
      message: "A page comes out with its whole sheet: the four pages folded together, and everything on them.",
    },
    reorder: false,
    move: false,
    tagline: "Folded sheets stapled through the spine. Small, thin, and filled in a week.",
    rules: ["Paper comes in folded sheets of four pages", "A new sheet folds in at the centre", "A page comes out with its sheet; 48 pages at most"],
    history:
      "Saddle stitching, sheets folded over a saddle and stitched or stapled through the fold, is how pamphlets, programmes and zines have been made since the wire stitcher of the 1870s. The pocket memo book it made became the farmer's and the surveyor's field notebook.",
  },
  travelers: {
    id: "travelers",
    label: "Traveler's notebook",
    noun: "page",
    nouns: "pages",
    page: { width: 416, height: 794, marginX: 32, marginTop: 48, marginBottom: 48 },
    grows: true,
    flow: "book",
    paper: null,
    sizes: null,
    addLabel: "Add page after this one",
    deleteLabel: "Delete this page",
    deleteConfirm: { title: "Delete this page?", message: "The page and its ink are deleted right away. Pages do not go to the Trash." },
    reorder: false,
    move: false,
    tagline: "A leather cover holding booklets under elastic. One booklet per subject or trip.",
    rules: ["Booklets under one cover, one per subject", "Slip a full booklet out to keep, and a fresh one in", "Pages are added and deleted within a booklet"],
    history:
      "A Tokyo stationer launched the Traveler's Notebook in 2006: a folded piece of leather, an elastic cord through the spine and thin booklets held under it. Filled booklets are slipped out and kept, so the cover goes on, worn in, trip after trip.",
  },
  cards: {
    id: "cards",
    label: "Index card box",
    noun: "card",
    nouns: "cards",
    page: { width: 480, height: 288, marginX: 20, marginTop: 44, marginBottom: 16 },
    grows: false,
    flow: "grid",
    paper: { kind: "lined", spacing: 24 },
    sizes: null,
    addLabel: "Add a card after this one",
    deleteLabel: "Throw this card away",
    deleteConfirm: { title: "Throw this card away?", message: "The card and everything on it are deleted right away." },
    reorder: true,
    move: false,
    tagline: "Five-by-three cards in a box. One idea to a card; file, reorder, shuffle.",
    rules: ["One card per idea: a card doesn't grow", "Add a card anywhere and put them in any order", "Shuffle the box to find new neighbours"],
    history:
      "Carl Linnaeus kept his botany on slips of paper so it could be rearranged, and Melvil Dewey standardised the library card in the 1870s. The sociologist Niklas Luhmann wrote around 90,000 cards over forty years, linked by number: the Zettelkasten, or slip box, that he said he had conversations with.",
  },
  accordion: {
    id: "accordion",
    label: "Concertina",
    noun: "panel",
    nouns: "panels",
    page: { width: 384, height: 576, marginX: 28, marginTop: 40, marginBottom: 36 },
    grows: false,
    flow: "strip",
    paper: null,
    sizes: null,
    addLabel: "Unfold another panel",
    deleteLabel: "Cut off the last panel",
    deleteConfirm: { title: "Cut off the last panel?", message: "The end of the strip is cut away, with everything on it." },
    reorder: false,
    move: false,
    tagline: "One long strip folded back and forth. Opens out into a single picture.",
    rules: ["One continuous strip, read left to right", "Panels are only added at the end, and only the end is cut off", "For timelines, storyboards and long views"],
    history:
      "The orihon, a scroll folded into pages instead of rolled, came to Japan from China with Buddhist sutras and is still used for albums of stamps and seals. Mesoamerican scribes folded their codices the same way from bark paper, and Hokusai published views of Edo as concertina books.",
  },
};

export const BINDING_ORDER: NotebookBinding[] = ["sewn", "spiral", "topbound", "ring", "saddle", "travelers", "cards", "accordion"];

export function bindingOf(settings: { medium?: unknown; binding?: unknown } | null | undefined): NotebookBinding | null {
  const b = settings?.binding;
  if (settings?.medium && settings.medium !== "paper") return null;
  return typeof b === "string" && b in BINDINGS ? (b as NotebookBinding) : null;
}

/** A size, as the picker words it. */
export function sizeLabel(binding: NotebookBinding, pages: number): string {
  return binding === "saddle" ? `${pages} pages · ${pages / 4} sheets` : `${pages} pages`;
}

/** The booklets of a traveler's notebook as runs of page indices, in reading order. */
export function bookletRanges(booklets: Booklet[] | undefined, pageIds: string[]): { booklet: Booklet; start: number; end: number }[] {
  if (!booklets?.length) return [];
  const at = new Map(pageIds.map((id, i) => [id, i]));
  const starts = booklets
    .map((b) => ({ booklet: b, start: at.get(b.firstPageId) ?? -1 }))
    .filter((r) => r.start >= 0)
    .sort((a, b) => a.start - b.start);
  return starts.map((r, i) => ({ ...r, end: i + 1 < starts.length ? starts[i + 1].start : pageIds.length }));
}

/** The page view's styles for bindings: the coil, rings, staples and ribbon drawn over a sheet,
 *  and the page turns only a binding has. */
export function bindingCss(): string {
  return `
.nb-bind { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: visible; pointer-events: none; z-index: 2; }
.nb-bind-hit { pointer-events: auto; cursor: pointer; }
.nb-leaving[data-turn="flip-up"] { transform-origin: center top; animation-name: nb-flip-up; }
@keyframes nb-flip-up { from { transform: rotateX(0deg); } 55% { opacity: 1; } to { transform: rotateX(100deg); opacity: 0; } }
.nb-flow[data-mode="strip"] { flex-direction: row; gap: 0; align-items: flex-start; }
.nb-flow[data-mode="strip"] .nb-sheet { border-radius: 0; }
.nb-flow[data-binding="cards"] { flex-direction: row; flex-wrap: wrap; justify-content: center; align-items: flex-start; align-content: flex-start; gap: 28px 32px; }
.nb-sheet[data-binding="cards"] { border-radius: 6px; }
.nb-sheet[data-binding="spiral"], .nb-sheet[data-binding="ring"] { border-radius: 2px 5px 5px 2px; }
`;
}
