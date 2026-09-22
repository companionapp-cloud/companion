import { useCallback, useEffect, useState } from 'react';
import { GraphCanvas, TourAnchor, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import { useOpenGraphNode } from '../useOpenGraphNode';

// The whole-knowledgebase graph as a bottom tab. Same React Flow canvas as web/desktop,
// hosted in a WebView by GraphCanvas. Tapping a node opens it where it lives (Today for a
// daily note).
export function GraphScreen() {
  const { core, graph: api } = useCore();
  const openNode = useOpenGraphNode();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(async () => setGraph(await api.full()), [api]);
  useEffect(() => {
    void refresh();
    // Stay live as notes are edited, synced, or the index is rebuilt (PLAN §5.4).
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return (
    <TourAnchor id="graph.canvas" style={{ flex: 1 }}>
      <GraphCanvas graph={graph} onOpenNode={openNode} />
    </TourAnchor>
  );
}
