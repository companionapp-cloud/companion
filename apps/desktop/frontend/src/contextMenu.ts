import { Events } from "@wailsio/runtime";
import type { TableMenuPresenter, TableMenuRequest } from "@companion/editor";

// Desktop right-click menus: the app's context menus (packages/app/src/contextMenu.ts) shown as
// native menus. The whole menu — labels, separators, submenus, enabled/checked — is posted with
// a correlation token to the Go side (POST /context-menu, apps/desktop/context_menu.go), which
// builds and opens it; a pick emits "context:action" back with the item id and the token, and
// the request's onSelect runs the matching action. Mirrors the table menu (tableMenu.ts).

export function desktopContextMenuPresenter(): TableMenuPresenter {
  const pending = new Map<string, TableMenuRequest>();

  Events.On("context:action", (event: { data?: unknown }) => {
    const raw = Array.isArray(event?.data) ? event.data[0] : event?.data;
    const payload = raw as { id?: string; corr?: string } | undefined;
    if (!payload?.id || !payload?.corr) return;
    const req = pending.get(payload.corr);
    if (!req) return;
    pending.delete(payload.corr);
    req.onSelect(payload.id);
  });

  return (req) => {
    const corr = `c${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // Only the latest menu can be picked from: opening one replaces the last.
    for (const [key, old] of pending) {
      pending.delete(key);
      old.onDismiss();
    }
    pending.set(corr, req);
    // The native menu doesn't report a dismissal without a pick, so let the request lapse.
    setTimeout(() => {
      if (pending.delete(corr)) req.onDismiss();
    }, 30000);
    void fetch("/context-menu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: Math.round(req.anchor.x), y: Math.round(req.anchor.y), corr, items: req.items }),
    });
  };
}
