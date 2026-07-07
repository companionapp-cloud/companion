import { useMemo } from "react";
import type { Graph, ObjectType } from "@companion/core-bridge";
import { useObjectTypes } from "./ObjectTypesProvider";

/** Enrich a graph's nodes with their archetype's chosen color/icon (PLAN §6.3, §5.3), so
 *  the renderer can mark objects distinctly. Done here rather than in GraphView because
 *  GraphView also runs inside the isolated mobile WebView, which has no providers — the
 *  enriched graph flows through the existing data channel instead. Returns the same graph
 *  untouched when nothing is archetyped, to keep referential stability. */
export function styleGraphNodes(graph: Graph, types: ObjectType[]): Graph {
  if (graph.nodes.length === 0 || types.length === 0) return graph;
  const byId = new Map(types.map((t) => [t.id, t.schemaJson]));
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (!n.objectTypeId) return n;
    const schema = byId.get(n.objectTypeId);
    const color = schema?.color || null;
    const icon = schema?.icon || null;
    if (!color && !icon) return n;
    changed = true;
    return { ...n, objectColor: color, objectIcon: icon };
  });
  return changed ? { ...graph, nodes } : graph;
}

/** Hook form: styles a graph with the live object types. */
export function useStyledGraph(graph: Graph): Graph {
  const { types } = useObjectTypes();
  return useMemo(() => styleGraphNodes(graph, types), [graph, types]);
}
