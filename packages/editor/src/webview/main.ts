// Entry for the native WebView build (bundled offline to a string by
// scripts/build-editor.mjs). Mounts the shared ProseMirror editor, seeds it from the
// markdown the host inlines, and reports edits back via postMessage. Kept separate
// from Editor.tsx so the native app never bundles ProseMirror into its JS.
import { createEditor } from "../createEditor";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __INITIAL_MARKDOWN__?: string;
  }
}

function post(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

function init(): void {
  const mount = document.getElementById("editor");
  if (!mount) return;
  createEditor(mount, window.__INITIAL_MARKDOWN__ ?? "", (markdown) => post("change", markdown));
  post("ready", null);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
