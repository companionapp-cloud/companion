import type { CoreBridge } from "./types";

/** A node in the object graph — a slim projection, never the entity body (PLAN §5.2). */
export interface GraphNode {
  id: string;
  type: "note" | "task" | "habit" | "project";
  title: string;
  objectTypeId?: string | null;
  status?: string | null;
}

/** A derived edge in the link index. */
export interface GraphEdge {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  kind: "ref" | "embed" | "stack" | "member";
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Typed wrappers over the graph.* core methods (PLAN §5.2). */
export function graphApi(core: CoreBridge) {
  return {
    /** The whole knowledgebase graph (ids/titles/edges only). */
    full: () => core.invoke<Graph>("graph.full"),
    /** The subgraph within `depth` hops of a seed node. */
    neighborhood: (type: string, id: string, depth = 2) =>
      core.invoke<Graph>("graph.neighborhood", { type, id, depth }),
    /** Nodes that reference the given target ("linked mentions"). */
    backlinks: (type: string, id: string) =>
      core.invoke<GraphNode[]>("graph.backlinks", { type, id }),
    /** Title search — powers wikilink autocomplete. `type` scopes to one entity type
     * (omit or "all" for every type). */
    search: (query: string, type?: string, limit = 20) =>
      core.invoke<GraphNode[]>("graph.search", { query, type, limit }),
    /** Resolve a single node by id (any type); null when nothing matches. */
    lookup: (id: string) => core.invoke<GraphNode | null>("graph.lookup", { id }),
    /** Truncate and re-derive the index; returns the resulting counts. */
    rebuild: () => core.invoke<{ nodes: number; edges: number }>("graph.rebuild"),
  };
}

export type GraphApi = ReturnType<typeof graphApi>;
