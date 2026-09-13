import { createRoot } from "react-dom/client";
import type { CanvasHost } from "../canvas/host";
// Resolves to CanvasView.web.tsx (the React Flow renderer) via the .web-first resolution
// configured in scripts/build-canvas.mjs.
import { CanvasView } from "../canvas/CanvasView.web";

// Entry for the native canvas WebView (bundled offline to a string by
// scripts/build-canvas.mjs, embedded by canvas/CanvasEditor.tsx). Renders the exact same
// React Flow board the web app uses, with a CanvasHost implemented over postMessage: every
// host call becomes an RPC the RN side answers through window.__canvasResolve, and change
// events arrive through window.__canvasChanged (PLAN-canvases.md §3.2, §5).
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __CANVAS_ID__?: string;
    __canvasResolve?: (requestId: number, result: { ok: true; value: unknown } | { ok: false; error: string }) => void;
    __canvasChanged?: (canvasId: string | null) => void;
  }
}

function post(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;
window.__canvasResolve = (requestId, result) => {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if (result.ok) p.resolve(result.value);
  else p.reject(new Error(result.error));
};

/** Call a host method on the RN side. Pickers can stay open indefinitely, so only the
 *  data calls carry a timeout. */
function rpc<T>(method: string, args: unknown[], timeoutMs: number | null = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = ++nextId;
    pending.set(requestId, { resolve: (v) => resolve(v as T), reject });
    post("rpc", { requestId, method, args });
    if (timeoutMs != null) {
      setTimeout(() => {
        if (pending.delete(requestId)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
    }
  });
}

const changeListeners = new Set<(id: string | null) => void>();
window.__canvasChanged = (id) => {
  for (const cb of changeListeners) cb(id);
};

const host: CanvasHost = {
  load: (id) => rpc("load", [id]),
  upsertNodes: (id, nodes) => rpc("upsertNodes", [id, nodes]),
  deleteNodes: (id, ids) => rpc("deleteNodes", [id, ids]),
  upsertEdges: (id, edges) => rpc("upsertEdges", [id, edges]),
  deleteEdges: (id, ids) => rpc("deleteEdges", [id, ids]),
  setView: (id, view) => rpc("setView", [id, view]),
  onChanged: (cb) => {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  },
  openRef: (ref) => post("rpc", { requestId: 0, method: "openRef", args: [ref] }),
  openUrl: (url) => post("rpc", { requestId: 0, method: "openUrl", args: [url] }),
  setTaskStatus: (id, status) => rpc("setTaskStatus", [id, status]),
  pickRef: (type) => rpc("pickRef", [type], null),
  pickImage: () => rpc("pickImage", [], null),
  // Files can't cross postMessage; native ingests through the OS picker instead.
  ingestImage: undefined,
  // A lazy download + base64 encode can take a while on a big image.
  resolveDocument: (id) => rpc("resolveDocument", [id], 60000),
  pickLink: () => rpc("pickLink", [], null),
  linkPreview: (url) => rpc("linkPreview", [url], 30000),
  newCanvas: () => post("rpc", { requestId: 0, method: "newCanvas", args: [] }),
};

function CanvasApp() {
  const canvasId = window.__CANVAS_ID__ ?? "";
  return <CanvasView host={host} canvasId={canvasId} />;
}

const mount = document.getElementById("canvas");
if (mount) {
  createRoot(mount).render(<CanvasApp />);
  post("ready", null);
}
