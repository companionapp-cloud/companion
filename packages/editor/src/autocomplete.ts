import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Schema } from "prosemirror-model";
import { wikilinkNode, LINK_TYPES, normalizeLinkType } from "./wikilink";
import { detectTrigger, triggerKey as key, type Trigger } from "./wikilinkTrigger";
import type { LinkSource, LinkSuggestion, LinkType } from "./types";

// The `[[` autocomplete (web/desktop). Typing `[[` (or `![[` for an embed) anchors a
// floating result list at the caret. Unlike the old popup, focus stays in the editor: what
// you type after `[[` is the live query, ArrowUp/Down move the highlight, and Enter/Tab
// complete the highlighted result into a chip. The plugin owns no focusable DOM — it's a
// pure read-out driven by the trigger state, with keyboard handled via handleKeyDown.
// Native uses a host modal instead (see hostAutocomplete.ts).

// Optional `type:` scope prefix on the query (the visible dropdown is gone; power users can
// still scope by typing e.g. `[[task:standup`). Splits a leading known type token off the
// query; everything else searches across all types.
function scopeQuery(query: string): { query: string; type: LinkType | "all" } {
  const m = /^\s*([a-zA-Z]+)\s*:\s*(.*)$/s.exec(query);
  if (m) {
    const type = normalizeLinkType(m[1]);
    if (LINK_TYPES.has(type)) return { query: m[2], type: type as LinkType };
  }
  return { query, type: "all" };
}

export function wikilinkAutocomplete(linkSource: LinkSource, schema: Schema): Plugin {
  const ui = {
    root: null as HTMLElement | null,
    list: null as HTMLElement | null,
    view: null as EditorView | null,
    open: false,
    items: [] as LinkSuggestion[],
    index: 0,
    query: "",
    range: null as { from: number; to: number; embed: boolean } | null,
    dismissedFrom: null as number | null,
    token: 0,
    timer: 0 as ReturnType<typeof setTimeout> | 0,
  };

  const onDocMouseDown = (e: MouseEvent) => {
    if (ui.root && !ui.root.contains(e.target as Node)) {
      if (ui.range) ui.dismissedFrom = ui.range.from;
      close();
    }
  };

  function build(): void {
    if (ui.root) return;
    const root = document.createElement("div");
    root.className = "pm-wikilink-menu";
    root.style.display = "none";

    const list = document.createElement("div");
    list.className = "pm-wikilink-menu-list";

    root.append(list);
    document.body.appendChild(root);

    ui.root = root;
    ui.list = list;
  }

  // Place the picker at the caret, but flip above / shift inward so it never spills off a
  // viewport edge. Runs on open, whenever the result list resizes, and on scroll/resize.
  function reposition(): void {
    if (!ui.root || !ui.view || !ui.range) return;
    let coords: ReturnType<EditorView["coordsAtPos"]>;
    try {
      coords = ui.view.coordsAtPos(ui.range.from);
    } catch {
      return;
    }
    const margin = 8;
    const rect = ui.root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: align under the caret, then pull back inside the right/left edges.
    let left = coords.left;
    if (left + rect.width + margin > vw) left = vw - rect.width - margin;
    if (left < margin) left = margin;

    // Vertical: below the caret by default; flip above when it wouldn't fit below but
    // would above; otherwise clamp to the bottom edge.
    const below = coords.bottom + 4;
    const above = coords.top - rect.height - 4;
    let top = below;
    if (below + rect.height + margin > vh && above >= margin) top = above;
    else if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin);

    ui.root.style.left = `${Math.round(left)}px`;
    ui.root.style.top = `${Math.round(top)}px`;
  }

  const onViewportChange = () => reposition();

  // Open (or, if already open, keep in sync with) the picker for the given trigger. Focus
  // never leaves the editor — the list just tracks the trigger's growing query.
  function sync(view: EditorView, t: Trigger): void {
    build();
    const fresh = !ui.open;
    ui.view = view;
    ui.range = { from: t.from, to: t.to, embed: t.embed };
    // Bail if the caret has no coords (e.g. a detached view).
    try {
      view.coordsAtPos(t.from);
    } catch {
      ui.range = null;
      if (ui.open) close();
      return;
    }
    if (fresh) {
      ui.open = true;
      ui.root!.style.display = "block";
      document.addEventListener("mousedown", onDocMouseDown, true);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
    }
    // Re-run the search only when the query actually changed (or on first open); the caret
    // may have moved either way, so always reposition.
    if (fresh || t.query !== ui.query) {
      ui.query = t.query;
      runSearch();
    } else {
      reposition();
    }
  }

  function close(): void {
    if (ui.timer) clearTimeout(ui.timer);
    ui.token++;
    ui.open = false;
    ui.query = "";
    if (ui.root) ui.root.style.display = "none";
    document.removeEventListener("mousedown", onDocMouseDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
  }

  function runSearch(): void {
    const { query, type } = scopeQuery(ui.query);
    if (ui.timer) clearTimeout(ui.timer);
    const token = ++ui.token;
    ui.timer = setTimeout(() => {
      linkSource
        .search(query, type)
        .then((items) => {
          if (token !== ui.token) return;
          ui.items = items;
          ui.index = 0;
          renderList();
        })
        .catch(() => {
          if (token === ui.token) {
            ui.items = [];
            renderList();
          }
        });
    }, 120);
  }

  function renderList(): void {
    const list = ui.list;
    if (!list) return;
    list.textContent = "";
    if (!ui.items.length) {
      const empty = document.createElement("div");
      empty.className = "pm-wikilink-menu-empty";
      empty.textContent = "No matches — finish with ]] to leave an empty link";
      list.appendChild(empty);
      reposition();
      return;
    }
    ui.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "pm-wikilink-menu-item" + (i === ui.index ? " is-active" : "");
      const badge = document.createElement("span");
      badge.className = "pm-wikilink-menu-type";
      badge.textContent = it.type;
      const title = document.createElement("span");
      title.className = "pm-wikilink-menu-title";
      title.textContent = it.title || it.id;
      row.append(badge, title);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the editor while we handle the click
        choose(i);
      });
      list.appendChild(row);
    });
    const active = list.children[ui.index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
    reposition(); // the list just changed height — re-check the viewport edges
  }

  // Keyboard, handled from the editor (focus never left it). Returns true to swallow the
  // key. With no results, Enter/Tab fall through so the editor behaves normally.
  function onKeyDown(event: KeyboardEvent): boolean {
    if (!ui.open) return false;
    switch (event.key) {
      case "ArrowDown":
        if (!ui.items.length) return false;
        ui.index = (ui.index + 1) % ui.items.length;
        renderList();
        return true;
      case "ArrowUp":
        if (!ui.items.length) return false;
        ui.index = (ui.index - 1 + ui.items.length) % ui.items.length;
        renderList();
        return true;
      case "Enter":
      case "Tab":
        if (!ui.items.length) return false;
        choose(ui.index);
        return true;
      case "Escape":
        if (ui.range) ui.dismissedFrom = ui.range.from;
        close();
        return true;
      default:
        return false;
    }
  }

  function choose(i: number): void {
    const item = ui.items[i];
    const range = ui.range;
    const view = ui.view;
    if (!item || !range || !view) return;
    // Bake the resolved title in as the chip's alias so it reads as a title, not a raw id.
    const node = wikilinkNode(schema, { type: item.type, id: item.id, alias: item.title, embed: range.embed });
    try {
      view.dispatch(view.state.tr.replaceRangeWith(range.from, range.to, node).scrollIntoView());
    } catch {
      /* view torn down */
    }
    ui.dismissedFrom = null;
    close();
    view.focus();
  }

  function teardown(): void {
    if (ui.timer) clearTimeout(ui.timer);
    document.removeEventListener("mousedown", onDocMouseDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
    ui.root?.remove();
    ui.root = null;
  }

  return new Plugin<Trigger | null>({
    key,
    state: {
      init: () => null,
      apply: (_tr, _prev, _old, next) => detectTrigger(next),
    },
    props: {
      handleKeyDown: (_view, event) => onKeyDown(event),
    },
    view() {
      return {
        update(view) {
          ui.view = view;
          const t = key.getState(view.state);
          if (!t) {
            ui.dismissedFrom = null;
            if (ui.open) close();
            return;
          }
          // Don't reopen on the same trigger the user just dismissed (Escape / click-away).
          if (!ui.open && t.from === ui.dismissedFrom) return;
          sync(view, t);
        },
        destroy: teardown,
      };
    },
  });
}
