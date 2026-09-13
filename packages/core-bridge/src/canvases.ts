import type { CoreBridge, Canvas, CanvasDocument, CanvasEdge, CanvasNode, CanvasView, LinkPreview } from "./types";

export interface CreateCanvasInput {
  name: string;
}
export interface UpdateCanvasInput {
  name?: string;
}

/** The full shape of a node as the UI writes it (PLAN-canvases.md §2). Omit `id` to
 *  create; pass a known id to overwrite — the client holds the whole node, so writes are
 *  whole rather than partial. */
export interface CanvasNodeInput {
  id?: string;
  kind: CanvasNode["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
  color?: string | null;
  refType?: CanvasNode["refType"];
  refId?: string | null;
  data?: Record<string, unknown>;
}

/** The full shape of an edge as the UI writes it (omit `id` to create). */
export interface CanvasEdgeInput {
  id?: string;
  fromNodeId: string;
  toNodeId: string;
  fromSide?: CanvasEdge["fromSide"];
  toSide?: CanvasEdge["toSide"];
  fromEnd?: CanvasEdge["fromEnd"];
  toEnd?: CanvasEdge["toEnd"];
  style?: CanvasEdge["style"];
  label?: string;
  color?: string | null;
}

/** Typed wrappers over the canvases.* core methods (PLAN-canvases.md). A canvas is three
 *  synced entities (board / nodes / edges); node and edge writes are batched so a drag of a
 *  multi-selection or a group is one call. */
export function canvasesApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Canvas[]>("canvases.list"),
    /** The board with its nodes, edges, hydrated entity summaries, and this device's viewport. */
    get: (id: string) => core.invoke<CanvasDocument>("canvases.get", { id }),
    create: (input: CreateCanvasInput) => core.invoke<Canvas>("canvases.create", input),
    update: (id: string, fields: UpdateCanvasInput) => core.invoke<Canvas>("canvases.update", { id, ...fields }),
    /** Move a board to the Trash (its nodes and edges ride along). */
    remove: (id: string) => core.invoke<{ ok: boolean }>("canvases.delete", { id }),
    removeMany: (ids: string[]) => core.invoke<{ count: number }>("canvases.deleteMany", { ids }),
    /** Live boards that embed an entity ("on canvas …"). */
    forEntity: (entityType: "note" | "task" | "event" | "document", entityId: string) =>
      core.invoke<Canvas[]>("canvases.forEntity", { entityType, entityId }),

    nodes: {
      upsert: (canvasId: string, nodes: CanvasNodeInput[]) =>
        core.invoke<CanvasNode[]>("canvases.nodes.upsert", { canvasId, nodes }),
      /** Tombstones nodes and every edge attached to them; returns the dropped edge ids. */
      remove: (canvasId: string, ids: string[]) =>
        core.invoke<{ count: number; edgeIds: string[] }>("canvases.nodes.delete", { canvasId, ids }),
    },
    edges: {
      upsert: (canvasId: string, edges: CanvasEdgeInput[]) =>
        core.invoke<CanvasEdge[]>("canvases.edges.upsert", { canvasId, edges }),
      remove: (canvasId: string, ids: string[]) => core.invoke<{ count: number }>("canvases.edges.delete", { canvasId, ids }),
    },
    /** Persist this device's viewport for a board (local-only, never synced). */
    setView: (canvasId: string, view: CanvasView) => core.invoke<{ ok: boolean }>("canvases.view.set", { canvasId, ...view }),
    /** Fetch a page's Open Graph metadata for a link node (direct on native, via the
     *  server's blind proxy on web). Always resolves; an unreachable page yields a bare card. */
    linkPreview: (url: string) => core.invoke<LinkPreview>("canvases.linkPreview", { url }),
  };
}

export type CanvasesApi = ReturnType<typeof canvasesApi>;
