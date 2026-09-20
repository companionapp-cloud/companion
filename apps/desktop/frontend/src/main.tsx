// Side-effect import: initializes the Wails runtime, including the window drag /
// resize handlers that act on elements marked `--wails-draggable: drag` (our rail
// and toolbar). No-ops outside the Wails webview.
import "@wailsio/runtime";
import { Browser, Window } from "@wailsio/runtime";
import { createElement } from "react";
import { AppRegistry } from "react-native";
import {
  App,
  setExternalUrlOpener,
  setFocusWindowOpener,
  setCaptureWindowCloser,
  setCaptureResultOpener,
  setTableMenuPresenter,
  setShortcutStore,
  setThingsSourcePicker,
} from "@companion/app";
import type { ShortcutBinding, ShortcutId, WindowControls } from "@companion/app";
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

// OAuth sign-in (Google) has to open in the system browser, not this webview; inside Wails that
// is the runtime's job. Outside it (a plain browser hitting the dev server) keep the default.
if (typeof window !== "undefined" && (window as unknown as { _wails?: unknown })._wails) {
  setExternalUrlOpener((url) => Browser.OpenURL(url).then(() => undefined));
}

// Quick-capture window (main.go opens /?capture=1 in a frameless, transparent window on the
// global Option/Alt+Space shortcut). The page's default body/#root background (index.html)
// is opaque; clear it so the window is see-through and CaptureView's palette card + shadow
// read against it. Harmless on the main window, which never carries ?capture.
const isCaptureWindow = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture");
if (isCaptureWindow) {
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

// Quick-capture results: that window's palette can find things but has no navigator to show
// them in, so the Go side brings the main window forward and relays the ref to it as a
// `palette.open` event (apps/desktop/palette.go → AppShell's PaletteNavigationBridge).
setCaptureResultOpener((ref) => {
  void fetch("/palette/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ref) });
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

// Things 3 import (PLAN §6.12): the Go side shows the native open panel — beside Things' database,
// able to pick the "Things Database.thingsdatabase" package whole — and core reads the chosen path.
setThingsSourcePicker(async () => {
  const res = await fetch("/import/things/pick", { method: "POST" });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error((await res.text()).trim() || "Couldn’t open the file panel.");
  const { path } = (await res.json()) as { path: string };
  return { source: { path }, label: path.split("/").filter(Boolean).pop() ?? path };
}, "panel");

// Editor tables: present a native Wails context menu instead of the built-in HTML popup. The
// presenter posts the menu state to /table-menu and runs the chosen action on the "table:action"
// event (see ./tableMenu.ts + apps/desktop/table_menu.go).
setTableMenuPresenter(desktopTableMenuPresenter());

// macOS uses a transparent titlebar (main.go MacTitleBarHiddenInset), so content draws
// under the traffic lights and the shell has to keep clear of them: the rail pads its top
// past their bottom edge, the toolbar beside it starts after their right edge and centres
// on them vertically. Their box is measured from the real window (GET /chrome, see
// apps/desktop/window_chrome_darwin.go) because macOS 26 draws them larger and lower than
// earlier releases. Windows/Linux keep their native titlebar above the webview: /chrome
// answers 204 and no inset applies.
const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
// Fallback if the measurement fails on macOS (macOS 26 geometry).
const MAC_WINDOW_CONTROLS: WindowControls = { left: 80, top: 20, bottom: 34 };
async function fetchWindowControls(): Promise<WindowControls | undefined> {
  try {
    const res = await fetch("/chrome");
    if (res.status === 204) return undefined;
    if (!res.ok) throw new Error(res.statusText);
    const box = (await res.json()) as WindowControls;
    if (!(box.left > 0 && box.bottom > box.top)) throw new Error("empty window-controls box");
    return box;
  } catch (err) {
    console.warn("window controls: falling back to defaults", err);
    return isMac ? MAC_WINDOW_CONTROLS : undefined;
  }
}

// Reminders (PLAN §6.4): register OS notifications via the Go notifications service
// rather than the shared web fallback, which the Wails webview can't honour.
const notificationScheduler = desktopNotificationScheduler();

// File embedding (PLAN §6.9): the webview passes file bytes to the Go filesystem blob store
// through the same invoke bridge every other core call uses (ingestBytes to add, dataUrl to
// render), while the core owns blob sync. Same editor UX as web — attach button, drag-drop,
// paste — since desktop is DOM.
const documentSource = desktopDocumentSource(core);

void fetchWindowControls().then((windowControls) => {
  // The rail (and a focus window's drag strip) clear the lights' bottom edge.
  const topInset = windowControls ? Math.ceil(windowControls.bottom) : 0;
  const rootTag = document.getElementById("root")!;
  rootTag.innerHTML = "";
  AppRegistry.registerComponent(
    "Companion",
    // shell: "desktop" — the desktop app never renders the mobile shell, however narrow
    // its window gets. Updates install in a window of their own (updater.html), so no app
    // window shows anything for them.
    () => () =>
      createElement(App, { core, shell: "desktop", topInset, windowControls, notificationScheduler, documentSource }),
  );
  AppRegistry.runApplication("Companion", { rootTag });
});

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
