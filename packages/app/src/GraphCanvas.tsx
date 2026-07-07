import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { Graph } from "@companion/core-bridge";
import { GRAPH_CSS, GRAPH_JS } from "./graphBundle.generated";
import { useStyledGraph } from "./useStyledGraph";

// Native graph canvas: the exact same React Flow renderer the web app uses, hosted in a
// WebView (React Flow is DOM-only) so the UX is identical on mobile. The bundle is built
// offline by scripts/build-graph.mjs. The host seeds the graph, keeps it live via
// window.__setGraph, and turns node-open messages into navigation. Web/desktop resolve
// GraphCanvas.web.tsx (React Flow straight in the DOM) instead.
export interface GraphCanvasProps {
  graph: Graph;
  /** When set (e.g. "note:<id>"), that node is centered and the rest fan out in rings. */
  focusKey?: string | null;
  /** Called when a node is opened in the canvas (only notes are navigable today). */
  onOpenNode?: (type: string, id: string) => void;
}

function buildHtml(focusKey: string | null): string {
  const f = JSON.stringify(focusKey).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;height:100%;width:100%;background:#f5f5f3;}#graph{position:absolute;inset:0;}${GRAPH_CSS}</style>
</head>
<body>
<div id="graph"></div>
<script>window.__FOCUS_KEY__ = ${f};</script>
<script>${GRAPH_JS}</script>
</body>
</html>`;
}

export function GraphCanvas({ graph, focusKey = null, onOpenNode }: GraphCanvasProps) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  // Enrich here (native side, in the provider tree) so the archetype color/icon travels to
  // the isolated WebView through the existing graph channel — the bundle has no providers.
  const styledGraph = useStyledGraph(graph);
  const graphRef = useRef(styledGraph);
  graphRef.current = styledGraph;

  // Built once; the focus node never changes for a given canvas, and graph data flows in
  // via injectJavaScript so the WebView never reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildHtml(focusKey), []);

  const pushGraph = () => {
    const g = JSON.stringify(graphRef.current).replace(/</g, "\\u003c");
    webRef.current?.injectJavaScript(`window.__setGraph && window.__setGraph(${g}); true;`);
  };

  // Push updates once the canvas has mounted (before that, the "ready" message pushes the
  // current graph).
  useEffect(() => {
    if (readyRef.current) pushGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styledGraph]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "ready") {
        readyRef.current = true;
        pushGraph();
      } else if (msg.type === "openNode") {
        onOpenNode?.(msg.payload.type, msg.payload.id);
      }
    } catch {
      // ignore malformed messages
    }
  };

  return (
    <View style={styles.root}>
      <WebView
        ref={webRef}
        style={styles.web}
        originWhitelist={["*"]}
        source={{ html }}
        onMessage={onMessage}
        automaticallyAdjustContentInsets={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
});
