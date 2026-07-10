import { Plugin } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { buildTableMenuModel, type ClipboardWriter } from "./tableCommands";
import { openTableMenu, type TableMenuPresenter, type TableMenuRequest } from "./tableMenuView";

export type { TableMenuPresenter, TableMenuRequest };

// Opens the table menu for the cell the user is acting on. The affordances are the same
// everywhere; only the menu *chrome* differs by platform (web HTML popup by default, or a
// native menu when a presenter is injected — see createEditor's tableMenuPresenter):
//   - hover a cell → a vertical-ellipsis button appears at its end; click it,
//   - right-click a cell (contextmenu),
//   - long-press a cell (touch, for the iOS WebView).

export interface TableMenuOptions {
  /** Injected by native hosts to present a platform menu; omitted on web (HTML popup). */
  presenter?: TableMenuPresenter;
  /** Host clipboard writer for the copy actions (iOS); web/desktop use navigator.clipboard. */
  clipboard?: ClipboardWriter;
}

const LONG_PRESS_MS = 500;

export function tableMenuPlugin(options: TableMenuOptions = {}): Plugin {
  const present = options.presenter ?? openTableMenu;

  return new Plugin({
    view(view) {
      // A single floating ellipsis button, reused across cells. Appended to <body> (fixed) so
      // it doesn't depend on the mount's positioning and can't be clipped by the editor.
      let btn: HTMLDivElement | null = null;
      let btnCellPos = -1; // document position inside the cell the button targets
      let longPress: ReturnType<typeof setTimeout> | null = null;
      let hideTimer: ReturnType<typeof setTimeout> | null = null;

      const exec = (cmd: Command) => {
        cmd(view.state, view.dispatch, view);
        view.focus();
      };

      const openFor = (insidePos: number, anchor: { x: number; y: number }) => {
        const model = buildTableMenuModel(view.state, insidePos, exec, { clipboard: options.clipboard });
        if (!model) return;
        hideButton();
        const req: TableMenuRequest = {
          anchor,
          items: model.items,
          onSelect: (id) => model.run(id),
          onDismiss: () => {},
        };
        present(req);
      };

      const cellPos = (cellEl: HTMLElement): number => {
        try {
          return view.posAtDOM(cellEl, 0);
        } catch {
          return -1;
        }
      };

      const ensureButton = (): HTMLDivElement => {
        if (btn) return btn;
        const el = document.createElement("div");
        el.className = "pm-table-cellbtn";
        el.textContent = "⋮";
        el.setAttribute("aria-label", "Table options");
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btnCellPos < 0) return;
          const r = el.getBoundingClientRect();
          openFor(btnCellPos, { x: r.left, y: r.bottom + 2 });
        });
        // Hovering the button keeps it up (the cursor has left the cell, so no mousemove will
        // re-show it) and lets it take its hover style; leaving it schedules the hide.
        el.addEventListener("mouseenter", cancelHide);
        el.addEventListener("mouseleave", scheduleHide);
        document.body.appendChild(el);
        btn = el;
        return el;
      };

      const showButton = (cellEl: HTMLElement) => {
        const inside = cellPos(cellEl);
        if (inside < 0) return;
        cancelHide();
        btnCellPos = inside;
        const rect = cellEl.getBoundingClientRect();
        const el = ensureButton();
        el.style.display = "flex";
        el.style.left = `${rect.right - 22}px`;
        el.style.top = `${rect.top + 3}px`;
      };

      const hideButton = () => {
        if (btn) btn.style.display = "none";
        btnCellPos = -1;
      };

      const cancelHide = () => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
      };

      // Hide on a short delay so moving the cursor from a cell onto the button (which sits at the
      // cell's edge, over a border gap) doesn't flicker it away before it can be clicked.
      const scheduleHide = () => {
        cancelHide();
        hideTimer = setTimeout(hideButton, 140);
      };

      const clearLongPress = () => {
        if (longPress) {
          clearTimeout(longPress);
          longPress = null;
        }
      };

      // The td/th under an event, if it belongs to this editor.
      const cellOf = (event: Event): HTMLElement | null => {
        const el = (event.target as HTMLElement | null)?.closest?.("td, th") as HTMLElement | null;
        return el && view.dom.contains(el) ? el : null;
      };

      const onMouseMove = (e: MouseEvent) => {
        const cell = cellOf(e);
        if (cell) showButton(cell);
        else scheduleHide();
      };
      const onMouseLeave = () => scheduleHide();
      const onContextMenu = (e: MouseEvent) => {
        const cell = cellOf(e);
        if (!cell) return;
        e.preventDefault();
        const inside = cellPos(cell);
        if (inside >= 0) openFor(inside, { x: e.clientX, y: e.clientY });
      };
      const onTouchStart = (e: TouchEvent) => {
        clearLongPress();
        const cell = cellOf(e);
        const touch = e.touches[0];
        if (!cell || !touch) return;
        const inside = cellPos(cell);
        if (inside < 0) return;
        const anchor = { x: touch.clientX, y: touch.clientY };
        longPress = setTimeout(() => openFor(inside, anchor), LONG_PRESS_MS);
      };
      const onScroll = () => hideButton();

      const dom = view.dom;
      dom.addEventListener("mousemove", onMouseMove);
      dom.addEventListener("mouseleave", onMouseLeave);
      dom.addEventListener("contextmenu", onContextMenu);
      dom.addEventListener("touchstart", onTouchStart, { passive: true });
      dom.addEventListener("touchmove", clearLongPress, { passive: true });
      dom.addEventListener("touchend", clearLongPress, { passive: true });
      window.addEventListener("scroll", onScroll, true);

      return {
        update() {
          if (btnCellPos > view.state.doc.content.size) hideButton();
        },
        destroy() {
          clearLongPress();
          cancelHide();
          dom.removeEventListener("mousemove", onMouseMove);
          dom.removeEventListener("mouseleave", onMouseLeave);
          dom.removeEventListener("contextmenu", onContextMenu);
          dom.removeEventListener("touchstart", onTouchStart);
          dom.removeEventListener("touchmove", clearLongPress);
          dom.removeEventListener("touchend", clearLongPress);
          window.removeEventListener("scroll", onScroll, true);
          btn?.remove();
          btn = null;
        },
      };
    },
  });
}
