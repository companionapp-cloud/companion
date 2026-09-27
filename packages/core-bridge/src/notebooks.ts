import type { CoreBridge } from "./types";
import type { NoteInkInput } from "./noteInk";

// Notebooks (PLAN-notebooks.md): paper notebooks of fixed A5 pages. Pages are their own
// entity, never notes: they don't appear under Notes and only open on their sheet.

export type PaperKind = "blank" | "lined" | "grid" | "dots";
export type PaperSpacing = 24 | 28 | 32;

/** What a notebook is made of (PLAN-notebooks.md §11). Chosen when it is made, never changed.
 *  Clay, wax and sherds are written with a pen only; their marks are ink rows in the app's own
 *  stroke format. The core keeps a wax codex's leaves fixed. */
export type NotebookMedium = "paper" | "clay" | "wax" | "sherd";
/** A wax codex's binding: diptych, triptych or polyptych. */
export type WaxLeaves = 2 | 3 | 8;

/** The keys of `settingsJson` the core owns and never takes from an update. */
export interface NotebookCoreSettings {
  medium?: NotebookMedium;
  leaves?: WaxLeaves;
}

export interface Notebook {
  id: string;
  title: string;
  /** A named cover colour; the app owns the list. */
  coverColor: string;
  coverDocumentId?: string | null;
  /** Notebook-wide settings: the guides dragged out of the rulers, and the medium's keys
   *  (NotebookCoreSettings). An update merges key by key. */
  settingsJson: NotebookCoreSettings & Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A shelf entry: the notebook plus its page count. */
export interface NotebookSummary extends Notebook {
  pageCount: number;
}

export interface NotebookPage {
  id: string;
  notebookId: string;
  sortOrder: number;
  paperKind: PaperKind;
  paperSpacing: PaperSpacing;
  contentMd: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** The notebook and its pages in reading order (text included; ink is fetched per page). */
export interface NotebookDocument {
  notebook: Notebook;
  pages: NotebookPage[];
}

/** One ink group on a page: the note-ink payload with a page anchor (strokes in page px). */
export interface NotebookPageInk {
  id: string;
  notebookId: string;
  pageId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A page found by its text, for the command palette: "<Notebook> · p. N" and a snippet. */
export interface PageHit {
  pageId: string;
  notebookId: string;
  notebookTitle: string;
  pageNumber: number;
  snippet: string;
  updatedAt: string;
}

export interface NotebookGuide {
  id: string;
  axis: "x" | "y";
  /** Page px. */
  at: number;
}

export interface UpdateNotebookInput {
  title?: string;
  coverColor?: string;
  /** Empty string clears the cover image. */
  coverDocumentId?: string;
  settingsJson?: { guides?: NotebookGuide[] } & Record<string, unknown>;
}

export interface CreateNotebookInput {
  title?: string;
  coverColor?: string;
  medium?: NotebookMedium;
  /** Wax only. */
  leaves?: WaxLeaves;
  /** Choose the first page's id (a UUID): the sherd picked from the heap. Omit to generate. */
  firstPageId?: string;
}

export interface AddPageInput {
  /** Choose the page's id (a UUID): a sherd's shape comes from its id. Omit to generate. */
  id?: string;
  notebookId: string;
  /** Insert after this page; omit to append. */
  afterId?: string;
  paperKind?: PaperKind;
  paperSpacing?: PaperSpacing;
  contentMd?: string;
}

export interface UpdatePageInput {
  contentMd?: string;
  paperKind?: PaperKind;
  paperSpacing?: PaperSpacing;
}

/** Typed wrappers over the notebooks.* core methods. Book and page mutations emit
 *  `notebooks.changed {notebookId}`; text saves emit only `data.changed`; ink writes emit
 *  `notebooks.ink.changed {pageId}` so a drawing burst never refreshes the shelf. */
export function notebooksApi(core: CoreBridge) {
  return {
    list: () => core.invoke<NotebookSummary[]>("notebooks.list", {}),
    get: (id: string) => core.invoke<NotebookDocument>("notebooks.get", { id }),
    /** Creates the notebook with one page on the default paper (a wax codex: all its leaves). */
    create: (input: CreateNotebookInput) => core.invoke<Notebook>("notebooks.create", input),
    update: (id: string, input: UpdateNotebookInput) => core.invoke<Notebook>("notebooks.update", { id, ...input }),
    reorder: (ids: string[]) => core.invoke<{ ok: boolean }>("notebooks.reorder", { ids }),
    /** Moves the notebook to the Trash; its pages and ink ride along. */
    remove: (id: string) => core.invoke<{ ok: boolean }>("notebooks.delete", { id }),
    pages: {
      add: (input: AddPageInput) => core.invoke<NotebookPage>("notebooks.pages.add", input),
      get: (id: string) => core.invoke<NotebookPage>("notebooks.pages.get", { id }),
      update: (id: string, input: UpdatePageInput) => core.invoke<NotebookPage>("notebooks.pages.update", { id, ...input }),
      reorder: (notebookId: string, ids: string[]) => core.invoke<{ ok: boolean }>("notebooks.pages.reorder", { notebookId, ids }),
      /** Tombstones the page and its ink. No per-page Trash: confirm first. A notebook keeps
       *  its last page. */
      remove: (id: string) => core.invoke<{ ok: boolean }>("notebooks.pages.delete", { id }),
      search: (query: string, limit?: number) => core.invoke<PageHit[]>("notebooks.pages.search", { query, limit }),
      /** Clear a page's text and ink in one step (wax: smooth the leaf; clay: knead it flat). */
      smooth: (id: string) => core.invoke<{ ok: boolean }>("notebooks.pages.smooth", { id }),
    },
    ink: {
      list: (pageId: string) => core.invoke<NotebookPageInk[]>("notebooks.ink.list", { pageId }),
      upsert: (pageId: string, groups: NoteInkInput[]) => core.invoke<NotebookPageInk[]>("notebooks.ink.upsert", { pageId, groups }),
      remove: (pageId: string, ids: string[]) => core.invoke<{ count: number }>("notebooks.ink.delete", { pageId, ids }),
    },
  };
}

export type NotebooksApi = ReturnType<typeof notebooksApi>;
