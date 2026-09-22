import type { EditorController, FormatState, InkState, InkTool } from "@companion/editor";
import type { NotebookHost, NotebookPage, NotebookViewMode } from "./host";

// The page view's contract, shared by the DOM view (NotebookView.web.tsx) and the native
// WebView host (NotebookView.tsx) so the editor chrome is written once.

export type NotebookZoom = "fit" | number;

export interface NotebookViewState {
  /** Index of the current page (the left page of a spread). */
  page: number;
  pageCount: number;
  /** The zoom actually applied (what "fit" resolved to). */
  scale: number;
}

export interface NotebookViewController {
  goTo(page: number): void;
  addPage(): void;
  /** The page the toolbar acts on: the last one focused or drawn on. */
  editor(): EditorController | null;
}

export interface NotebookViewProps {
  host: NotebookHost;
  notebookId: string;
  mode: NotebookViewMode;
  zoom: NotebookZoom;
  onZoom(zoom: NotebookZoom): void;
  tool: InkTool | null;
  /** What a stylus draws with while `tool` is null: in a notebook the pencil always writes. */
  penTool: InkTool | null;
  rulers: boolean;
  /** Bump to re-read the notebook (a page's paper changed, a page was deleted). */
  revision: number;
  onState(state: NotebookViewState): void;
  onActivePage(page: NotebookPage | null): void;
  onFormatState(state: FormatState | null): void;
  onInkState(state: InkState | null): void;
  onExitDrawing(): void;
}

