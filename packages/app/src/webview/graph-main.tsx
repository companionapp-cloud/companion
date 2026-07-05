import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Graph } from "@companion/core-bridge";
// Resolves to GraphView.web.tsx (the React Flow renderer) via the .web-first resolution
// configured in scripts/build-graph.mjs.
import { GraphView } from "../GraphView.web";

// Entry for the native graph WebView (bundled offline to a string by
// scripts/build-graph.mjs, embedded by GraphCanvas.tsx). Renders the exact same React
// Flow canvas the web app uses, seeded with the graph the host inlines and kept live via
// window.__setGraph. Node opens are posted back to the host, which drives navigation.
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __GRAPH__?: Graph;
    __FOCUS_KEY__?: string | null;
    __setGraph?: (graph: Graph) => void;
  }
}

function post(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

function GraphApp() {
  const [graph, setGraph] = useState<Graph>(window.__GRAPH__ ?? { nodes: [], edges: [] });
  const focusKey = window.__FOCUS_KEY__ ?? null;

  useEffect(() => {
    // The host pushes fresh graphs here as data.changed fires on the native side.
    window.__setGraph = (g) => setGraph(g);
    post("ready", null);
    return () => {
      window.__setGraph = undefined;
    };
  }, []);

  return (
    <GraphView graph={graph} focusKey={focusKey} onOpenNode={(type, id) => post("openNode", { type, id })} />
  );
}

const mount = document.getElementById("graph");
if (mount) createRoot(mount).render(<GraphApp />);
