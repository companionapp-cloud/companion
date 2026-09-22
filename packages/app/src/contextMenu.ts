import { Platform } from "react-native";
import type { TableMenuItem, TableMenuPresenter } from "@companion/editor";

// Right-click menus, native only. A menu is a list of entries that carry their own actions; the
// desktop shell injects a presenter that shows it as a real OS menu (a Wails context menu, see
// apps/desktop/context_menu.go). Where there is none — the web app in a browser — nothing is
// drawn in its place: the right-click is left alone and the browser shows its own menu. The
// presenter only ever sees ids and labels; the actions stay here, run when a pick comes back.

export type MenuEntry =
  | "separator"
  | {
      label: string;
      run?: () => void;
      /** Greyed out, not pickable. */
      disabled?: boolean;
      checked?: boolean;
      /** A submenu; the entry itself then has no `run`. */
      children?: MenuEntry[];
    };

let injected: TableMenuPresenter | undefined;

/** Register the platform's native menu presenter (called once by the desktop shell). */
export function setContextMenuPresenter(presenter: TableMenuPresenter | undefined): void {
  injected = presenter;
}

/** Whether right-clicks open the app's menus here (a native presenter is registered). */
export function hasContextMenus(): boolean {
  return Platform.OS === "web" && !!injected;
}

/** Show `entries` natively at a point in the window (client coordinates). Empty submenus and
 *  doubled or trailing separators are dropped, so builders can add entries conditionally.
 *  False when there's no native menu to show (the caller then leaves the event alone). */
export function openContextMenu(at: { x: number; y: number }, entries: MenuEntry[]): boolean {
  const present = injected;
  if (!present || Platform.OS !== "web") return false;
  const runs = new Map<string, () => void>();
  const convert = (list: MenuEntry[], prefix: string): TableMenuItem[] => {
    const out: TableMenuItem[] = [];
    list.forEach((e, i) => {
      if (e === "separator") {
        if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
        return;
      }
      const id = `${prefix}${i}`;
      if (e.children) {
        const children = convert(e.children, `${id}.`);
        // A submenu with nothing in it shows as a greyed item when marked disabled (so the
        // action reads as unavailable), and is dropped otherwise.
        if (children.length && !e.disabled) out.push({ label: e.label, children });
        else if (e.disabled) out.push({ id: `${prefix}${i}`, label: e.label, enabled: false });
        return;
      }
      if (e.run) runs.set(id, e.run);
      out.push({ id, label: e.label, enabled: !e.disabled && !!e.run, checked: e.checked });
    });
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  };
  const items = convert(entries, "");
  if (!items.length) return false;
  present({
    anchor: at,
    items,
    onSelect: (id) => runs.get(id)?.(),
    onDismiss: () => {},
  });
  return true;
}

/** The pointer event a context-menu handler gets on web (RN's types don't carry it). */
export interface ContextMenuEvent {
  preventDefault(): void;
  stopPropagation(): void;
  clientX?: number;
  clientY?: number;
  nativeEvent?: { clientX?: number; clientY?: number };
}

/** Props that open a menu on right-click, for a react-native-web element (`onContextMenu`
 *  reaches the DOM). `build` runs at the click, so the menu reflects the current state. Null
 *  where there are no native menus, so it can be spread unconditionally. */
export function contextMenuProps(build: (() => MenuEntry[]) | null): { onContextMenu: (e: ContextMenuEvent) => void } | null {
  if (!hasContextMenus() || !build) return null;
  return {
    onContextMenu: (e: ContextMenuEvent) => {
      const x = e.clientX ?? e.nativeEvent?.clientX ?? 0;
      const y = e.clientY ?? e.nativeEvent?.clientY ?? 0;
      if (!openContextMenu({ x, y }, build())) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
