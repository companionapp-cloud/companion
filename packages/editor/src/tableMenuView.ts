import type { TableMenuItem } from "./tableCommands";

// The built-in web/desktop-webview HTML popup for the table menu. Desktop (Wails) and iOS
// present a *native* menu from the same model instead (see tableMenu.ts / the host shells);
// this is the default when no host presenter is injected. Plain DOM appended to <body>,
// positioned at the anchor, mirroring the wikilink picker's approach.

/** What a presenter receives: where to anchor, the item tree, and callbacks. Shared shape
 * across the HTML popup and the native presenters. */
export interface TableMenuRequest {
  anchor: { x: number; y: number };
  items: TableMenuItem[];
  onSelect(id: string): void;
  onDismiss(): void;
}

export type TableMenuPresenter = (req: TableMenuRequest) => void;

function renderItems(list: TableMenuItem[], onPick: (id: string) => void): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "pm-table-submenu";
  for (const item of list) menu.appendChild(renderItem(item, onPick));
  return menu;
}

function renderItem(item: TableMenuItem, onPick: (id: string) => void): HTMLElement {
  if (item.separator) {
    const sep = document.createElement("div");
    sep.className = "pm-table-menu-sep";
    return sep;
  }
  const row = document.createElement("div");
  row.className = "pm-table-menu-item";
  const disabled = item.enabled === false;
  if (disabled) row.classList.add("is-disabled");

  const check = document.createElement("span");
  check.className = "pm-table-menu-check";
  check.textContent = item.checked ? "✓" : "";
  row.appendChild(check);

  const label = document.createElement("span");
  label.className = "pm-table-menu-label";
  label.textContent = item.label ?? "";
  row.appendChild(label);

  if (item.children && item.children.length) {
    row.classList.add("has-submenu");
    const arrow = document.createElement("span");
    arrow.className = "pm-table-menu-arrow";
    arrow.textContent = "▸";
    row.appendChild(arrow);
    row.appendChild(renderItems(item.children, onPick));
  } else if (item.id && !disabled) {
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onPick(item.id!);
    });
  } else if (disabled) {
    row.addEventListener("mousedown", (e) => e.preventDefault());
  }
  return row;
}

/** Show the HTML table menu at the anchor and wire dismissal (outside click / Escape / scroll).
 * The single active menu is tracked so a second open closes the first. */
let active: (() => void) | null = null;

export function openTableMenu(req: TableMenuRequest): void {
  active?.();

  const root = document.createElement("div");
  root.className = "pm-table-menu";
  const pick = (id: string) => {
    close();
    req.onSelect(id);
  };
  for (const item of req.items) root.appendChild(renderItem(item, pick));
  document.body.appendChild(root);

  // Clamp within the viewport.
  const { innerWidth, innerHeight } = window;
  const rect = root.getBoundingClientRect();
  const x = Math.min(req.anchor.x, innerWidth - rect.width - 8);
  const y = Math.min(req.anchor.y, innerHeight - rect.height - 8);
  root.style.left = `${Math.max(8, x)}px`;
  root.style.top = `${Math.max(8, y)}px`;

  const onDocMouseDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const onScroll = () => close();

  function close() {
    if (active !== close) return;
    active = null;
    root.remove();
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    req.onDismiss();
  }
  active = close;
  // Defer so the opening click doesn't immediately dismiss.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
  }, 0);
}
