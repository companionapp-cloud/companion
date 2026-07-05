import { useCallback, useEffect, useState } from "react";
import type { Graph } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useNav } from "./nav-context";
// Explicit .web specifier — see the note in GraphScreen.web.tsx.
import { GraphEmpty, GraphView, nodeKey } from "./GraphView.web";

// The per-note neighborhood graph (PLAN §5.2 graph.neighborhood): the note sits at the
// center and its links fan out around it. React Flow is DOM-only, so this is the .web
// variant; native gets a placeholder (NoteGraph.tsx).
export function NoteGraph({ noteId, depth = 2 }: { noteId: string; depth?: number }) {
  const { core, graph: graphApi } = useCore();
  const nav = useNav();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setGraph(await graphApi.neighborhood("note", noteId, depth));
    setLoaded(true);
  }, [graphApi, noteId, depth]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    // Reflect edits/syncs to this note or its neighbors live (PLAN §5.4).
    return core.on("data.changed", () => void refresh());
  }, [core, refresh]);

  // A note with no links comes back as just itself, so show that lone node centered.
  // Only fall back to the empty state when there's genuinely nothing (e.g. the note
  // isn't in the graph yet), not merely when it has no connections.
  if (loaded && graph.nodes.length === 0) {
    return (
      <GraphEmpty>
        Nothing to show yet. Reference another item with{" "}
        <code>[[note:&lt;id&gt;]]</code> and it will appear here, connected to this note.
      </GraphEmpty>
    );
  }

  return (
    <GraphView
      graph={graph}
      focusKey={nodeKey("note", noteId)}
      onOpenNode={(type, id, newTab) => {
        if (type === "note") nav.openNote(id, { newTab });
      }}
    />
  );
}
