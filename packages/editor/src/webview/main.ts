// Entry for the native WebView build (bundled offline to a string by
// scripts/build-editor.mjs). Mounts the shared ProseMirror editor, seeds it from the
// markdown the host inlines, and reports edits back via postMessage. Kept separate
// from Editor.tsx so the native app never bundles ProseMirror into its JS.
import { createEditor } from "../createEditor";
import type { FormatName } from "./../formatCommands";
import type { LinkSource, LinkSuggestion } from "../types";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __INITIAL_MARKDOWN__?: string;
    __HAS_LINK_SOURCE__?: boolean;
    __EDITOR_VARIANT__?: "full" | "simple";
    __PLACEHOLDER__?: string;
    __SUBMIT_ON_ENTER__?: boolean;
    __DEBOUNCE_MS__?: number;
    __resolveLink?: (requestId: number, payload: unknown) => void;
    __refreshLinks?: () => void;
    __clear?: () => void;
    __format?: (name: FormatName) => void;
    __insertReference?: () => void;
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
  const simple = window.__EDITOR_VARIANT__ === "simple";
  const handle = createEditor(mount, window.__INITIAL_MARKDOWN__ ?? "", (markdown) => post("change", markdown), {
    variant: simple ? "simple" : "full",
    placeholder: window.__PLACEHOLDER__,
    debounceMs: window.__DEBOUNCE_MS__,
    // In the composer, Enter sends: post the exact content so the host sends what's shown.
    // Task notes leave this off (Enter makes a new paragraph).
    onSubmit: window.__SUBMIT_ON_ENTER__ ? (md) => post("submit", md) : undefined,
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
    // Report the formatting-toolbar snapshot so the native keyboard toolbar can reflect it.
    onFormatStateChange: (state) => post("format", state),
    // Opening a referenced entity is the shell's job; hand the ref up over the bridge.
    onOpenRef: (ref) => post("openRef", ref),
  });
  // The host injects __refreshLinks() to re-hydrate task chips after task data changes.
  window.__refreshLinks = () => handle.refreshLinks();
  // The host injects __clear() to empty the composer after a send.
  window.__clear = () => handle.clear();
  // The host's keyboard toolbar injects these to drive formatting / reference insertion.
  window.__format = (name) => handle.format(name);
  window.__insertReference = () => handle.insertReference();

  // The simple editor is an inline field (task note / composer), not a full-screen page, so
  // report its content height and let the host size the WebView to it (bounded by the host's
  // min/max). The full editor fills the screen and ignores this.
  if (simple) {
    const report = () => post("height", document.body.scrollHeight);
    report();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(report).observe(document.body);
  }
  post("ready", null);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
