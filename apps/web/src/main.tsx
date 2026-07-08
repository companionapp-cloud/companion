import { AppRegistry } from "react-native";
import { App, webNotificationScheduler, activateReminder } from "@companion/app";
import { documentsApi } from "@companion/core-bridge";
import {
  createWaSqliteDriver,
  createWasmBridge,
  createOpfsBlobStore,
  isWebBlobStoreAvailable,
  type WebBlobStore,
} from "@companion/core-bridge/wasm";
import type { CoreBridge } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import { createElement } from "react";

// Web shell (PLAN §3.2): build the SQLite driver (wa-sqlite/IndexedDB), hand it to
// the core compiled to wasm, then mount the shared React Native UI via RNW.
async function boot() {
  const sqlite = await createWaSqliteDriver({ dbName: "companion" });
  // Document bytes live in OPFS (PLAN §6.9); degrade gracefully if the browser lacks it —
  // metadata still syncs, but bytes can't be stored or rendered locally.
  const blobs = isWebBlobStoreAvailable() ? createOpfsBlobStore() : undefined;
  // core.wasm is an unhashed public asset, so bust the browser disk cache in dev — otherwise
  // a rebuilt core silently keeps serving the stale binary. Production serves it plainly.
  const wasmUrl = import.meta.env.DEV ? `/core.wasm?t=${Date.now()}` : "/core.wasm";
  const core = await createWasmBridge({ sqlite, wasmUrl, blobs });

  // File embedding for the note editor (PLAN §6.9): stage bytes into OPFS, record the
  // document row, and resolve embeds to object URLs. Only when OPFS is available.
  const documentSource = blobs ? webDocumentSource(core, blobs) : undefined;

  // Dev-only debug handle: lets the browser console (and preview verification) reach the
  // live core + blob store, e.g. window.__companion.blobs.put(file). Stripped in production.
  if (import.meta.env.DEV) {
    (globalThis as unknown as { __companion?: unknown }).__companion = { core, blobs, documentSource };
  }

  // Reminder notifications (PLAN §6.4, web W3). The SW routes notification *clicks* back to
  // the app; the in-tab scheduler shows fires through its registration so a click can
  // refocus/reopen the app and deep-link. Best-effort — fires only while a tab is open.
  const registration = await registerServiceWorker();
  wireReminderActivation();

  const notificationScheduler = webNotificationScheduler({ registration });

  const rootTag = document.getElementById("root")!;
  rootTag.innerHTML = "";
  AppRegistry.registerComponent("Companion", () => () =>
    createElement(App, { core, notificationScheduler, documentSource }),
  );
  AppRegistry.runApplication("Companion", { rootTag });
}

// webDocumentSource wires the editor's file embedding (PLAN §6.9) to the OPFS blob store and
// the documents.* core API: ingest stages bytes + records a document row; resolveUrl fetches
// the bytes (lazily, on first view) and hands back an object URL. Bytes never touch the core.
function webDocumentSource(core: CoreBridge, blobs: WebBlobStore): DocumentSource {
  const documents = documentsApi(core);
  return {
    async ingest(file: File) {
      const { sha256, size } = await blobs.put(file);
      const doc = await documents.create({
        filename: file.name,
        mime: file.type || "application/octet-stream",
        size,
        sha256,
      });
      return { id: doc.id, filename: doc.filename, mime: doc.mime };
    },
    async resolveUrl(id: string) {
      const doc = await documents.get(id).catch(() => null);
      if (!doc) return null;
      const local = await documents.ensureLocal(id);
      if (!local.present) return null;
      const url = await blobs.objectUrl(doc.sha256);
      if (!url) return null;
      return { url, mime: doc.mime, filename: doc.filename };
    },
  };
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null; // scheduler falls back to new Notification + inline onclick
  }
}

// Turn a tapped reminder into in-app navigation. Two entry points: the SW postMessage (a
// click that refocused an open tab) and a `?reminder=<taskId>` param (a click that had to
// open a fresh tab). Both funnel through activateReminder, which buffers until the
// navigator mounts.
function wireReminderActivation() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string } | null;
      if (data?.type === "reminder-activate" && data.taskId) activateReminder({ taskId: data.taskId });
    });
  }
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get("reminder");
  if (taskId) {
    activateReminder({ taskId });
    // Strip the param so a reload doesn't re-trigger the deep-link.
    params.delete("reminder");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }
}

boot().catch((err: unknown) => {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<div class="boot">Failed to start: ${
      err instanceof Error ? err.message : String(err)
    }</div>`;
  }
  // eslint-disable-next-line no-console
  console.error("boot failed", err);
});
