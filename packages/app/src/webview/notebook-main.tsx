import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EditorController, FormatState, InkState, InkTool } from "@companion/editor";
import type { NotebookHost, NotebookPage, NotebookViewMode } from "../notebooks/host";
// Resolves to the DOM view via the .web-first resolution in scripts/build-notebook.mjs.
import { NotebookView } from "../notebooks/NotebookView.web";
import type { NotebookViewController, NotebookZoom } from "../notebooks/viewTypes";

// Entry for the native notebook WebView (bundled to a string by scripts/build-notebook.mjs,
// embedded by notebooks/NotebookView.tsx). Renders the same page view the web app uses. The
// NotebookHost is implemented over postMessage (every call an RPC the RN side answers through
// window.__notebookResolve); the view's props arrive through window.__notebookProps, its
// callbacks post "event" messages, and the controller is driven through window.__notebookCall
// (PLAN-notebooks.md §5).
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __NOTEBOOK_ID__?: string;
    __notebookResolve?: (requestId: number, result: { ok: true; value: unknown } | { ok: false; error: string }) => void;
    __notebookProps?: (props: ViewProps) => void;
    __notebookCall?: (method: string, args: unknown[]) => void;
  }
}

interface ViewProps {
  mode: NotebookViewMode;
  zoom: NotebookZoom;
  tool: InkTool | null;
  penTool: InkTool | null;
  rulers: boolean;
  revision: number;
}

function post(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;
window.__notebookResolve = (requestId, result) => {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if (result.ok) p.resolve(result.value);
  else p.reject(new Error(result.error));
};

function rpc<T>(method: string, args: unknown[], timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = ++nextId;
    pending.set(requestId, { resolve: (v) => resolve(v as T), reject });
    post("rpc", { requestId, method, args });
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`${method} timed out`));
    }, timeoutMs);
  });
}

const host: NotebookHost = {
  load: (id) => rpc("load", [id]),
  loadPage: (id) => rpc("loadPage", [id]),
  savePage: (id, md) => rpc("savePage", [id, md]),
  loadInk: (id) => rpc("loadInk", [id]),
  saveInk: (id, groups) => rpc("saveInk", [id, groups]),
  deleteInk: (id, ids) => rpc("deleteInk", [id, ids]),
  addPage: (nb, after, paper) => rpc("addPage", [nb, after, paper]),
  setPaper: (id, paper) => rpc("setPaper", [id, paper]),
  deletePage: (id) => rpc("deletePage", [id]),
  setGuides: (nb, guides) => rpc("setGuides", [nb, guides]),
  resolveDocument: (id) => rpc("resolveDocument", [id], 60000),
};

let setPropsExternal: ((p: ViewProps) => void) | null = null;
let controller: NotebookViewController | null = null;

window.__notebookProps = (p) => setPropsExternal?.(p);
window.__notebookCall = (method, args) => {
  if (!controller) return;
  if (method === "goTo") controller.goTo(Number(args[0]));
  else if (method === "addPage") controller.addPage();
  else {
    // Editor controller calls for the current page: format, insertTable, inkUndo, …
    const ed = controller.editor() as unknown as Record<string, (...a: unknown[]) => void> | null;
    const fn = ed?.[method];
    if (typeof fn === "function") fn.apply(ed, args);
  }
};

function NotebookApp() {
  const notebookId = window.__NOTEBOOK_ID__ ?? "";
  const [props, setProps] = useState<ViewProps>({ mode: "scroll", zoom: "fit", tool: null, penTool: null, rulers: false, revision: 0 });
  const ref = useRef<NotebookViewController>(null);
  useEffect(() => {
    setPropsExternal = setProps;
    return () => {
      setPropsExternal = null;
    };
  }, []);
  useEffect(() => {
    controller = ref.current;
  });
  return (
    <NotebookView
      ref={ref}
      host={host}
      notebookId={notebookId}
      mode={props.mode}
      zoom={props.zoom}
      onZoom={(z) => post("event", { name: "zoom", value: z })}
      tool={props.tool}
      penTool={props.penTool}
      rulers={props.rulers}
      revision={props.revision}
      onState={(s) => post("event", { name: "state", value: s })}
      onActivePage={(p: NotebookPage | null) => post("event", { name: "activePage", value: p })}
      onFormatState={(s: FormatState | null) => post("event", { name: "formatState", value: s })}
      onInkState={(s: InkState | null) => post("event", { name: "inkState", value: s })}
      onExitDrawing={() => post("event", { name: "exitDrawing", value: null })}
    />
  );
}

// Keep the EditorController shape in view for the RN proxy (NotebookView.tsx).
export type { EditorController };

const mount = document.getElementById("notebook");
if (mount) {
  createRoot(mount).render(<NotebookApp />);
  post("ready", null);
}
