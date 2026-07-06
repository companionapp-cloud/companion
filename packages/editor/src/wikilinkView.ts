import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import type { LinkRef, LinkSource } from "./types";

// A NodeView for the wikilink chip. Non-task links render the same pill as toDOM; a
// `[[task:…]]` chip additionally hydrates from the host (linkSource.lookup) to show the
// task's done state and its due / reminder dates — so a referenced task reads like a todo
// inline. Clicking follows a select-then-open gesture: the first click selects the chip
// (so it can be edited/deleted like any atom); clicking the already-selected chip opens
// the target via onOpenRef (the host puts it in a new tab).

export interface WikilinkViewDeps {
  linkSource?: LinkSource;
  onOpenRef?: (ref: LinkRef) => void;
  /** Register a live view so the host can re-hydrate task chips when the underlying task
   * data changes elsewhere (see {@link WikilinkView.rehydrate}). Returns an unregister fn. */
  register?: (view: WikilinkView) => () => void;
}

interface Attrs {
  embed: boolean;
  type: string;
  id: string;
  alias: string | null;
}

export function wikilinkNodeView(deps: WikilinkViewDeps) {
  return (node: Node, view: EditorView, getPos: () => number | undefined): NodeView =>
    new WikilinkView(node, view, getPos, deps);
}

export class WikilinkView implements NodeView {
  dom: HTMLElement;
  private attrs: Attrs;
  // A lookup token so a slow response for a stale node (after update()) is ignored.
  private token = 0;
  private unregister?: () => void;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
    private deps: WikilinkViewDeps,
  ) {
    this.attrs = node.attrs as Attrs;
    this.dom = document.createElement("span");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    this.dom.addEventListener("click", this.onClick);
    this.render();
    this.unregister = deps.register?.(this);
  }

  private isTask(): boolean {
    return this.attrs.type === "task";
  }

  // Re-fetch a task chip's state from the host. Called when task data changed elsewhere
  // (e.g. its done state toggled in another tab) so an open note reflects it. No-op for
  // non-task chips, whose label is fixed by the doc.
  rehydrate(): void {
    if (this.isTask()) this.hydrateTask();
  }

  private render(): void {
    const { embed, type, id, alias } = this.attrs;
    const el = this.dom;
    el.className = "pm-wikilink" + (embed ? " pm-wikilink-embed" : "") + (this.isTask() ? " pm-wikilink-task" : "");
    el.setAttribute("data-type", type);
    el.setAttribute("data-id", id);
    if (alias) el.setAttribute("data-alias", alias);
    else el.removeAttribute("data-alias");
    el.textContent = "";

    if (this.isTask()) {
      const status = document.createElement("span");
      status.className = "pm-wikilink-status";
      el.appendChild(status);
    }
    const label = document.createElement("span");
    label.className = "pm-wikilink-label";
    label.textContent = alias || id;
    el.appendChild(label);

    if (this.isTask()) {
      const meta = document.createElement("span");
      meta.className = "pm-wikilink-meta";
      el.appendChild(meta);
      this.hydrateTask();
    }
  }

  // Fetch the task's done state + dates and fill in the status dot and the meta chips.
  private hydrateTask(): void {
    const src = this.deps.linkSource;
    if (!src) return;
    const token = ++this.token;
    const id = this.attrs.id;
    src
      .lookup(id)
      .then((hit) => {
        if (token !== this.token || !hit || hit.type !== "task") return;
        const done = hit.status === "done";
        this.dom.setAttribute("data-status", done ? "done" : "open");
        const meta = this.dom.querySelector(".pm-wikilink-meta");
        if (!meta) return;
        meta.textContent = "";
        if (hit.dueAt) meta.appendChild(metaChip("pm-wikilink-due", formatDue(hit.dueAt)));
        if (hit.remindAt) meta.appendChild(metaChip("pm-wikilink-remind", "⏰ " + formatReminder(hit.remindAt)));
      })
      .catch(() => {
        /* leave the chip in its un-hydrated (label-only) state */
      });
  }

  // First click selects the chip; a click on the already-selected chip opens the target.
  // We drive selection ourselves (preventDefault on mousedown) so the gesture is
  // deterministic regardless of the browser's native atom-selection timing.
  private onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onClick = (e: MouseEvent): void => {
    e.preventDefault();
    const pos = this.getPos();
    if (pos == null) return;
    const sel = this.view.state.selection;
    const alreadySelected = sel instanceof NodeSelection && sel.from === pos;
    if (alreadySelected) {
      this.deps.onOpenRef?.({ type: this.attrs.type as LinkRef["type"], id: this.attrs.id });
    } else {
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
      this.view.focus();
    }
  };

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.attrs = node.attrs as Attrs;
    this.render();
    return true;
  }

  // The chip is an atom; ProseMirror should never try to read our DOM back into the doc.
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.token++;
    this.unregister?.();
    this.dom.removeEventListener("mousedown", this.onMouseDown);
    this.dom.removeEventListener("click", this.onClick);
  }
}

function metaChip(className: string, text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function formatReminder(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDue(iso)}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
