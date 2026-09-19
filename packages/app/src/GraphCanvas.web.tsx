import type { Graph } from "@companion/core-bridge";
import { GraphView } from "./GraphView.web";

// Web/desktop graph canvas: React Flow straight in the DOM (no WebView needed). Mirrors
// the native GraphCanvas.tsx prop shape so callers are platform-agnostic. Native "open"
// carries no modifier key, so newTab is always false here.
export interface GraphCanvasProps {
  graph: Graph;
  focusKey?: string | null;
  onOpenNode?: (type: string, id: string) => void;
  /** Inside a scrolling page (a chat preview): the wheel scrolls the page, not the graph. */
  embedded?: boolean;
}

export function GraphCanvas({ graph, focusKey = null, onOpenNode, embedded = false }: GraphCanvasProps) {
  return (
    <GraphView
      graph={graph}
      focusKey={focusKey}
      onOpenNode={onOpenNode ? (type, id) => onOpenNode(type, id) : undefined}
      embedded={embedded}
    />
  );
}
