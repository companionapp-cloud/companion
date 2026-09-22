import type { InkGroupRecord } from "@companion/editor";
import type { PaperStyle } from "./paper";

// What the notebook renderer needs from the outside world (PLAN-notebooks.md §5), shaped like
// CanvasHost: every argument and result is JSON, so the same renderer can run over the core
// APIs on web and desktop and over postMessage inside the native WebView.

export type NotebookCover = { kind: "color"; color: string } | { kind: "image"; color: string; documentId: string };

/** A guide dragged out of a ruler, in page px. `x` guides are vertical lines. */
export interface NotebookGuide {
  id: string;
  axis: "x" | "y";
  at: number;
}

export type NotebookViewMode = "spread" | "scroll";

export interface Notebook {
  id: string;
  title: string;
  cover: NotebookCover;
  guides: NotebookGuide[];
  pageCount: number;
  updatedAt: string;
}

/** One page. A page owns its text and ink: it is not a note, never appears under Notes, and
 *  is only ever opened on its sheet. */
export interface NotebookPage {
  id: string;
  position: number;
  paper: PaperStyle;
}

export interface NotebookDocument {
  notebook: Notebook;
  pages: NotebookPage[];
}

export interface NotebookHost {
  load(notebookId: string): Promise<NotebookDocument>;
  /** A page's text, as markdown. Pages have no title. */
  loadPage(pageId: string): Promise<{ contentMd: string }>;
  savePage(pageId: string, contentMd: string): Promise<void>;
  loadInk(pageId: string): Promise<InkGroupRecord[]>;
  saveInk(pageId: string, groups: InkGroupRecord[]): Promise<void>;
  deleteInk(pageId: string, ids: string[]): Promise<void>;
  /** Insert a blank page after `afterPageId` (or at the end), with the given paper. */
  addPage(notebookId: string, afterPageId: string | null, paper: PaperStyle): Promise<NotebookPage>;
  setPaper(pageId: string, paper: PaperStyle): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  setGuides(notebookId: string, guides: NotebookGuide[]): Promise<void>;
  /** Resolve a cover image to something an <img> can show. */
  resolveDocument(id: string): Promise<{ url: string } | null>;
}
