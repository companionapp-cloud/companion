import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Schema } from "prosemirror-model";
import { wikilinkNode } from "./wikilink";
import { detectTrigger, triggerKey as key, type Trigger } from "./wikilinkTrigger";
import type { LinkSource, LinkSuggestion, LinkType } from "./types";

// The `[[` autocomplete (web/desktop). Typing `[[` (or `![[` for an embed) anchors a
// floating link picker at the caret: a search input plus a type dropdown to scope by
// entity type, over a keyboard-navigable result list. The picker owns keyboard focus
// while open, so it's a self-contained widget — the editor just supplies the anchor range
// and receives the chosen wikilink. Plain DOM appended to <body>. Native uses a host
// modal instead (see hostAutocomplete.ts).

const TYPES: { value: LinkType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "note", label: "Notes" },
  { value: "task", label: "Tasks" },
  { value: "habit", label: "Habits" },
  { value: "project", label: "Projects" },
];

export function wikilinkAutocomplete(linkSource: LinkSource, schema: Schema): Plugin {
  const ui = {
    root: null as HTMLElement | null,
    input: null as HTMLInputElement | null,
    typeSel: null as HTMLSelectElement | null,
    list: null as HTMLElement | null,
    view: null as EditorView | null,
    open: false,
    items: [] as LinkSuggestion[],
    index: 0,
    range: null as { from: number; to: number; embed: boolean } | null,
    dismissedFrom: null as number | null,
    token: 0,
    timer: 0 as ReturnType<typeof setTimeout> | 0,
  };

  const onDocMouseDown = (e: MouseEvent) => {
    if (ui.root && !ui.root.contains(e.target as Node)) {
      if (ui.range) ui.dismissedFrom = ui.range.from;
      close(false);
    }
  };

  function build(): void {
    if (ui.root) return;
    const root = document.createElement("div");
    root.className = "pm-wikilink-menu";
    root.style.display = "none";

    const header = document.createElement("div");
    header.className = "pm-wikilink-menu-header";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "pm-wikilink-menu-input";
    input.placeholder = "Search links…";
    input.addEventListener("input", () => runSearch());
    input.addEventListener("keydown", onInputKey);

    const typeSel = document.createElement("select");
    typeSel.className = "pm-wikilink-menu-typesel";
    for (const t of TYPES) {
      const opt = document.createElement("option");
      opt.value = t.value;
      opt.textContent = t.label;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener("change", () => {
      ui.input?.focus();
      runSearch();
    });

    const list = document.createElement("div");
    list.className = "pm-wikilink-menu-list";

    header.append(input, typeSel);
    root.append(header, list);
    document.body.appendChild(root);

    ui.root = root;
    ui.input = input;
    ui.typeSel = typeSel;
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

  function openAt(view: EditorView, t: Trigger): void {
    build();
    ui.range = { from: t.from, to: t.to, embed: t.embed };
    // Bail if the caret has no coords (e.g. a detached view).
    try {
      view.coordsAtPos(t.from);
    } catch {
      ui.range = null;
      return;
    }
    ui.open = true;
    ui.input!.value = t.query;
    ui.typeSel!.value = "all";
    ui.root!.style.display = "block";
    reposition(); // measure the shown element, then place it edge-aware
    document.addEventListener("mousedown", onDocMouseDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    ui.input!.focus();
    runSearch();
  }

  function close(refocus: boolean): void {
    if (ui.timer) clearTimeout(ui.timer);
    ui.token++;
    ui.open = false;
    if (ui.root) ui.root.style.display = "none";
    document.removeEventListener("mousedown", onDocMouseDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
    if (refocus) ui.view?.focus();
  }

  function runSearch(): void {
    if (!ui.input || !ui.typeSel) return;
    const query = ui.input.value;
    const type = ui.typeSel.value as LinkType | "all";
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
      empty.textContent = "No matches";
      list.appendChild(empty);
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
        e.preventDefault(); // don't blur the search input before we handle the click
        choose(i);
      });
      list.appendChild(row);
    });
    const active = list.children[ui.index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
    reposition(); // the list just changed height — re-check the viewport edges
  }

  function onInputKey(e: KeyboardEvent): void {
    if (!ui.open) return;
    switch (e.key) {
      case "ArrowDown":
        if (ui.items.length) {
          ui.index = (ui.index + 1) % ui.items.length;
          renderList();
        }
        e.preventDefault();
        break;
      case "ArrowUp":
        if (ui.items.length) {
          ui.index = (ui.index - 1 + ui.items.length) % ui.items.length;
          renderList();
        }
        e.preventDefault();
        break;
      case "Enter":
      case "Tab":
        if (ui.items.length) choose(ui.index);
        e.preventDefault();
        break;
      case "Escape":
        if (ui.range) ui.dismissedFrom = ui.range.from;
        close(true);
        e.preventDefault();
        break;
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
    close(true);
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
    view() {
      return {
        update(view) {
          ui.view = view;
          const t = key.getState(view.state);
          if (!t) {
            ui.dismissedFrom = null;
            if (ui.open) close(false);
            return;
          }
          // Only (re)open on a fresh trigger; once open the picker owns focus and the
          // editor no longer changes, so we leave it alone.
          if (!ui.open && t.from !== ui.dismissedFrom) openAt(view, t);
        },
        destroy: teardown,
      };
    },
  });
}
