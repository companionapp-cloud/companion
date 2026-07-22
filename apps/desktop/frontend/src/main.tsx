// Side-effect import: initializes the Wails runtime, including the window drag /
// resize handlers that act on elements marked `--wails-draggable: drag` (our rail
// and toolbar). No-ops outside the Wails webview.
import "@wailsio/runtime";
import { Window } from "@wailsio/runtime";
import { createElement } from "react";
import { AppRegistry } from "react-native";
import { App, setFocusWindowOpener, setCaptureWindowCloser, setTableMenuPresenter, setShortcutStore } from "@companion/app";
import type { ShortcutBinding, ShortcutId } from "@companion/app";
import { createHttpBridge, documentsApi } from "@companion/core-bridge";
import type { CoreBridge } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import { desktopNotificationScheduler } from "./notifications";
import { desktopTableMenuPresenter } from "./tableMenu";

// Double-clicking the window chrome (any `--wails-draggable: drag` region, e.g. the
// toolbar or rail) zooms the window, matching native macOS titlebar behaviour. The
// runtime deliberately ignores double-clicks for dragging, so we handle them here.
if (typeof window !== "undefined" && (window as unknown as { _wails?: unknown })._wails) {
  window.addEventListener("dblclick", (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (getComputedStyle(el).getPropertyValue("--wails-draggable").trim() !== "drag") return;
    void Window.ToggleMaximise();
  });
}

// Quick-capture window (main.go opens /?capture=1 in a frameless, transparent window on the
// global Option/Alt+Space shortcut). The page's default body/#root background (index.html)
// is opaque; clear it so the window is see-through and CaptureView's rounded card + shadow
// read against it. Harmless on the main window, which never carries ?capture.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

// Desktop shell: the Wails Go process hosts the core and exposes it over HTTP + SSE
// on the asset server (same origin). Wire a CoreBridge to it and mount the shared UI.
const core = createHttpBridge();

// Expand/pop-out: ask the Go side to spawn a real focus-mode window (browser window.open
// can't create app windows in the Wails webview).
setFocusWindowOpener(({ kind, id }) => {
  void fetch(`/window?kind=${kind}&id=${encodeURIComponent(id)}`, { method: "POST" });
});

// Quick-capture dismiss: close the current (frameless) window via the Wails runtime. The
// browser `window.close()` doesn't close a native Wails window, so CaptureView routes its
// Cancel / Esc / post-save dismiss through here.
setCaptureWindowCloser(() => {
  void Window.Close();
});

// Global shortcuts: only the Go process can register an OS-wide hotkey, so Settings ›
// Shortcuts reads and rebinds through it. Injecting this store is also what makes that
// settings section appear — web and mobile leave it unset and never show it.
setShortcutStore({
  async list(): Promise<ShortcutBinding[]> {
    const res = await fetch("/shortcuts");
    if (!res.ok) throw new Error("Couldn’t read the current shortcuts.");
    return (await res.json()) as ShortcutBinding[];
  },
  async set(id: ShortcutId, accelerator: string): Promise<ShortcutBinding> {
    const res = await fetch("/shortcuts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, accelerator }),
    });
    // The Go side answers 422 with the OS/parser message ("'foo' is not a valid key"),
    // which is more useful to show than a generic failure.
    if (!res.ok) throw new Error((await res.text()).trim() || "The system wouldn’t take that shortcut.");
    return (await res.json()) as ShortcutBinding;
  },
});

// Editor tables: present a native Wails context menu instead of the built-in HTML popup. The
// presenter posts the menu state to /table-menu and runs the chosen action on the "table:action"
// event (see ./tableMenu.ts + apps/desktop/table_menu.go).
setTableMenuPresenter(desktopTableMenuPresenter());

// macOS uses a transparent titlebar (main.go MacTitleBarHiddenInset), so content
// draws under the traffic lights — reserve space for them. Windows/Linux keep their
// native titlebar above the webview, so no inset is needed.
const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
const topInset = isMac ? 28 : 0;

// Reminders (PLAN §6.4): register OS notifications via the Go notifications service
// rather than the shared web fallback, which the Wails webview can't honour.
const notificationScheduler = desktopNotificationScheduler();

// File embedding (PLAN §6.9): the webview passes file bytes to the Go filesystem blob store
// through the same invoke bridge every other core call uses (ingestBytes to add, dataUrl to
// render), while the core owns blob sync. Same editor UX as web — attach button, drag-drop,
// paste — since desktop is DOM.
const documentSource = desktopDocumentSource(core);

const rootTag = document.getElementById("root")!;
rootTag.innerHTML = "";
AppRegistry.registerComponent(
  "Companion",
  // shell: "desktop" — the desktop app never renders the mobile shell, however narrow
  // its window gets.
  () => () => createElement(App, { core, shell: "desktop", topInset, notificationScheduler, documentSource }),
);
AppRegistry.runApplication("Companion", { rootTag });

function desktopDocumentSource(core: CoreBridge): DocumentSource {
  const documents = documentsApi(core);
  return {
    async ingest(file: File) {
      const data = base64FromArrayBuffer(await file.arrayBuffer());
      const doc = await documents.ingestBytes(data, file.name, file.type || "application/octet-stream");
      return { id: doc.id, filename: doc.filename, mime: doc.mime };
    },
    async resolveUrl(id: string) {
      const res = await documents.dataUrl(id); // ensures bytes locally (downloads lazily if synced)
      if (!res.present || !res.url) return null;
      return { url: res.url, mime: res.mime ?? "application/octet-stream", filename: res.filename ?? "" };
    },
  };
}

// Base64-encode an ArrayBuffer in chunks (a single String.fromCharCode(...bytes) overflows
// the call stack for large files).
function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
