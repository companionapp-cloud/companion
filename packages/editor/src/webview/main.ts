// Entry for the native WebView build (bundled offline to a string by
// scripts/build-editor.mjs). Mounts the shared ProseMirror editor, seeds it from the
// markdown the host inlines, and reports edits back via postMessage. Kept separate
// from Editor.tsx so the native app never bundles ProseMirror into its JS.
import { createEditor } from "../createEditor";
import type { LinkSource, LinkSuggestion } from "../types";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __INITIAL_MARKDOWN__?: string;
    __HAS_LINK_SOURCE__?: boolean;
    __resolveLink?: (requestId: number, payload: unknown) => void;
  }
}

function post(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

// Bridge the editor's LinkSource to the RN host over postMessage. Each call gets a
// request id; the host answers by invoking window.__resolveLink(id, result).
function bridgedLinkSource(): LinkSource {
  const pending = new Map<number, (value: unknown) => void>();
  let nextId = 0;
  window.__resolveLink = (requestId, payload) => {
    const resolve = pending.get(requestId);
    if (resolve) {
      pending.delete(requestId);
      resolve(payload);
    }
  };
  const rpc = <T>(type: string, body: object, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const requestId = ++nextId;
      pending.set(requestId, (v) => resolve(v as T));
      post(type, { requestId, ...body });
      // Don't hang the menu if the host never answers.
      setTimeout(() => {
        if (pending.delete(requestId)) resolve(fallback);
      }, 4000);
    });
  return {
    search: (query, type) => rpc<LinkSuggestion[]>("linkSearch", { query, type }, []),
    lookup: (id) => rpc<LinkSuggestion | null>("linkLookup", { id }, null),
  };
}

function init(): void {
  const mount = document.getElementById("editor");
  if (!mount) return;
  const hasLinks = !!window.__HAS_LINK_SOURCE__;
  createEditor(mount, window.__INITIAL_MARKDOWN__ ?? "", (markdown) => post("change", markdown), {
    // linkSource still resolves pasted UUIDs; `[[` delegates to the native modal, which
    // posts linkTrigger/linkTriggerEnd and injects window.__insertRef / __cancelRef.
    linkSource: hasLinks ? bridgedLinkSource() : undefined,
    hostAutocomplete: hasLinks
      ? {
          open: (embed) => post("linkTrigger", { embed }),
          close: () => post("linkTriggerEnd", null),
        }
      : undefined,
    onFocusChange: (focused) => post("focus", focused),
  });
  post("ready", null);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
