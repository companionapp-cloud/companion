import type {
  CanvasDocument,
  CanvasEdge,
  CanvasEdgeInput,
  CanvasNode,
  CanvasNodeInput,
  CanvasView,
  LinkPreview,
  TaskStatus,
} from "@companion/core-bridge";

/** An entity the canvas can open or embed. */
export type CanvasRefKind = "note" | "task" | "event";

/** Everything the canvas renderer needs from the outside world (PLAN-canvases.md §3.2).
 *  The renderer (CanvasView.web.tsx) imports nothing from the provider tree: on web and
 *  desktop the host wraps the core APIs directly, and inside the mobile WebView the same
 *  interface is implemented over postMessage — so one React Flow component serves every
 *  platform. Every method's arguments and results are JSON-serializable for that reason
 *  (the one exception, `ingestImage`, takes a browser File and is web-only). */
export interface CanvasHost {
  load(canvasId: string): Promise<CanvasDocument>;
  upsertNodes(canvasId: string, nodes: CanvasNodeInput[]): Promise<CanvasNode[]>;
  /** Tombstones nodes and their attached edges; returns the ids of the dropped edges. */
  deleteNodes(canvasId: string, ids: string[]): Promise<{ edgeIds: string[] }>;
  upsertEdges(canvasId: string, edges: CanvasEdgeInput[]): Promise<CanvasEdge[]>;
  deleteEdges(canvasId: string, ids: string[]): Promise<void>;
  /** Persist this device's viewport (local-only). */
  setView(canvasId: string, view: CanvasView): Promise<void>;
  /** Subscribe to board changes (local edits, or a sync pull applying rows). The callback
   *  receives the changed board's id, or null for bulk changes. */
  onChanged(cb: (canvasId: string | null) => void): () => void;

  /** Open an embedded entity in the app (note editor, task editor, the calendar). */
  openRef(ref: { type: CanvasRefKind; id: string }): void;
  /** Open an external URL (a link node) in the browser. */
  openUrl(url: string): void;
  /** Flip an embedded task's status from its card checkbox. */
  setTaskStatus(id: string, status: TaskStatus): Promise<void>;
  /** Let the user choose a note, task, or calendar event to embed; resolves null when
   *  dismissed. `data` carries kind-specific content to cache on the node (an event's
   *  title and start, so the card degrades gracefully if the feed drops it). */
  pickRef(type: CanvasRefKind): Promise<{ id: string; label: string; data?: Record<string, unknown> } | null>;
  /** Let the user choose an image file; the host ingests it as a document. */
  pickImage(): Promise<{ documentId: string } | null>;
  /** Web/desktop only: ingest a dropped or pasted image file as a document. */
  ingestImage?(file: File): Promise<{ documentId: string }>;
  /** Resolve a document to something an <img> can show. */
  resolveDocument(id: string): Promise<{ url: string; mime: string } | null>;
  /** Ask the user for a URL to embed; resolves null when dismissed. */
  pickLink(): Promise<string | null>;
  /** Fetch a link's Open Graph metadata. */
  linkPreview(url: string): Promise<LinkPreview>;
  /** Create a new board and open it (⌘⇧N); absent where the host can't navigate. */
  newCanvas?(): void;
  /** Web/desktop only: carry an embedded note or task off `canvasId` through the app's drag
   *  layer, onto a project or an area (a task onto the Today agenda too). Called once a card's
   *  grip has been dragged a few pixels, with the pointer's window position; the host follows
   *  the pointer from there. Absent where there is no drag layer, and the cards show no grip. */
  dragRef?(ref: { type: "note" | "task"; id: string; label: string }, canvasId: string, x: number, y: number): void;
}

/** Default sizes for freshly added nodes, in canvas units. */
export const NODE_DEFAULTS: Record<CanvasNode["kind"], { width: number; height: number }> = {
  text: { width: 220, height: 140 },
  group: { width: 480, height: 320 },
  note: { width: 260, height: 170 },
  task: { width: 260, height: 92 },
  event: { width: 260, height: 104 },
  image: { width: 320, height: 240 },
  link: { width: 300, height: 220 },
};
