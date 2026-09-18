import type { Graph } from "@companion/core-bridge";
import { GraphCanvas } from "../GraphCanvas";
import { useStyledGraph } from "../useStyledGraph";

/** The graph a render_graph preview draws: the app's own graph renderer — React Flow in the DOM on
 *  web/desktop, the same bundle in a WebView on native (GraphCanvas) — embedded so it doesn't trap
 *  the transcript's scrolling. Styled here because only the native canvas styles for itself;
 *  styling twice is a no-op. */
export function ChatGraph({ graph, focusKey, onOpenNode }: { graph: Graph; focusKey: string; onOpenNode?: (type: string, id: string) => void }) {
  const styled = useStyledGraph(graph);
  return <GraphCanvas graph={styled} focusKey={focusKey} onOpenNode={onOpenNode} embedded />;
}
