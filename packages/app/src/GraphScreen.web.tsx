import { useCallback, useEffect, useState } from "react";
import type { Graph } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useNav } from "./nav-context";
import { useStyledGraph } from "./useStyledGraph";
// Explicit .web specifier: GraphView is a React Flow (DOM-only) module with no native
// counterpart, so it is only ever imported by other .web files. The suffix lets tsc and
// Vite resolve it while native bundlers never reach it.
import { GraphEmpty, GraphView, graphCodeStyle } from "./GraphView.web";

// The whole-knowledgebase graph (PLAN §5.3), a top-level nav screen. React Flow is
// DOM-only, so this is the .web variant; native gets a placeholder (GraphScreen.tsx).
export function GraphScreen() {
  const { core, graph: graphApi } = useCore();
  const nav = useNav();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const styledGraph = useStyledGraph(graph);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setGraph(await graphApi.full());
    setLoaded(true);
  }, [graphApi]);

  useEffect(() => {
    void refresh();
    // Stay live as notes are edited, synced, or the index is rebuilt (PLAN §5.4).
    return core.on("data.changed", () => void refresh());
  }, [core, refresh]);

  if (loaded && graph.nodes.length === 0) {
    return (
      <GraphEmpty>
        Your graph is empty. Create a few notes and link them with{" "}
        <code style={graphCodeStyle}>[[note:&lt;id&gt;]]</code> — linked notes will appear here connected.
      </GraphEmpty>
    );
  }

  return (
    <GraphView
      graph={styledGraph}
      onOpenNode={(type, id) => {
        if (type === "note") nav.openNote(id);
        else if (type === "task") nav.openTask(id);
        else if (type === "project") nav.openProject(id);
      }}
    />
  );
}
