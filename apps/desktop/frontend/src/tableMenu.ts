import { Events } from "@wailsio/runtime";
import type { TableMenuPresenter, TableMenuRequest, TableMenuItem } from "@companion/editor";

// Desktop table menu: present the native Wails context menu for editor tables. The editor calls
// this presenter with the menu model + anchor; we post the model state (enabled/checked) + a
// correlation token to the Go side (POST /table-menu, which opens the native menu), then the Go
// item click emits "table:action" back with the token so we run the chosen action in the editor.
// See apps/desktop/table_menu.go and packages/editor/src/tableMenu.ts.

function collectState(
  items: TableMenuItem[],
  enabled: Record<string, boolean>,
  checked: Record<string, boolean>,
): void {
  for (const item of items) {
    if (item.id) {
      if (item.enabled === false) enabled[item.id] = false;
      if (item.checked) checked[item.id] = true;
    }
    if (item.children) collectState(item.children, enabled, checked);
  }
}

/** Build the desktop presenter and attach the one-time "table:action" listener. */
export function desktopTableMenuPresenter(): TableMenuPresenter {
  const pending = new Map<string, TableMenuRequest>();

  Events.On("table:action", (event: { data?: unknown }) => {
    const raw = Array.isArray(event?.data) ? event.data[0] : event?.data;
    const payload = raw as { id?: string; corr?: string } | undefined;
    if (!payload?.id || !payload?.corr) return;
    const req = pending.get(payload.corr);
    if (req) {
      pending.delete(payload.corr);
      req.onSelect(payload.id);
    }
  });

  return (req) => {
    const corr = `t${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const enabled: Record<string, boolean> = {};
    const checked: Record<string, boolean> = {};
    collectState(req.items, enabled, checked);
    pending.set(corr, req);
    // The native menu doesn't tell us when it's dismissed without a pick, so expire the pending
    // request after a while and let the editor know it was dismissed.
    setTimeout(() => {
      if (pending.delete(corr)) req.onDismiss();
    }, 30000);
    void fetch("/table-menu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: Math.round(req.anchor.x), y: Math.round(req.anchor.y), corr, enabled, checked }),
    });
  };
}
