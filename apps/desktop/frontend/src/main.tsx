// Side-effect import: initializes the Wails runtime, including the window drag /
// resize handlers that act on elements marked `--wails-draggable: drag` (our rail
// and toolbar). No-ops outside the Wails webview.
import "@wailsio/runtime";
import { Window } from "@wailsio/runtime";
import { createElement } from "react";
import { AppRegistry } from "react-native";
import { App, setFocusWindowOpener } from "@companion/app";
import { createHttpBridge } from "@companion/core-bridge";

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

// Desktop shell: the Wails Go process hosts the core and exposes it over HTTP + SSE
// on the asset server (same origin). Wire a CoreBridge to it and mount the shared UI.
const core = createHttpBridge();

// Expand/pop-out: ask the Go side to spawn a real focus-mode window (browser window.open
// can't create app windows in the Wails webview).
setFocusWindowOpener(({ kind, id }) => {
  void fetch(`/window?kind=${kind}&id=${encodeURIComponent(id)}`, { method: "POST" });
});

// macOS uses a transparent titlebar (main.go MacTitleBarHiddenInset), so content
// draws under the traffic lights — reserve space for them. Windows/Linux keep their
// native titlebar above the webview, so no inset is needed.
const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
const topInset = isMac ? 28 : 0;

const rootTag = document.getElementById("root")!;
rootTag.innerHTML = "";
AppRegistry.registerComponent("Companion", () => () => createElement(App, { core, topInset }));
AppRegistry.runApplication("Companion", { rootTag });
