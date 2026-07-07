import { useCallback, useEffect, useState } from "react";
import type { Graph } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useNav } from "./nav-context";
import { useStyledGraph } from "./useStyledGraph";
// Explicit .web specifier — see the note in GraphScreen.web.tsx.
import { GraphEmpty, GraphView, nodeKey } from "./GraphView.web";

// The per-task neighborhood graph (PLAN §5.2 graph.neighborhood): the task sits at the
// center and its links fan out. React Flow is DOM-only, so this is the .web variant;
// native gets a placeholder (TaskGraph.tsx).
export function TaskGraph({ taskId, depth = 2 }: { taskId: string; depth?: number }) {
  const { core, graph: graphApi } = useCore();
  const nav = useNav();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const styledGraph = useStyledGraph(graph);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setGraph(await graphApi.neighborhood("task", taskId, depth));
    setLoaded(true);
  }, [graphApi, taskId, depth]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    return core.on("data.changed", () => void refresh());
  }, [core, refresh]);

  if (loaded && graph.nodes.length === 0) {
    return (
      <GraphEmpty>
        Nothing to show yet. Reference a note or task from this task’s notes with{" "}
        <code>[[…]]</code> and it will appear here, connected.
      </GraphEmpty>
    );
  }

  return (
    <GraphView
      graph={styledGraph}
      focusKey={nodeKey("task", taskId)}
      onOpenNode={(type, id) => {
        if (type === "note") nav.openNote(id);
        else if (type === "task") nav.openTask(id);
        else if (type === "project") nav.openProject(id);
      }}
    />
  );
}
