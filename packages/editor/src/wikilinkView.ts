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
  // Whether the referenced target no longer exists (lookup resolved to null). Cached so a
  // re-render can restore the broken visual immediately, before the re-check resolves.
  private broken = false;
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

  // Re-verify the chip against the host. Called when data changed elsewhere (e.g. a task's
  // done state toggled, or a referenced note deleted, in another tab) so an open editor
  // reflects it — refreshing task status/dates and flipping the broken state either way.
  rehydrate(): void {
    if (this.deps.linkSource) this.hydrate();
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
    }

    // Restore the last-known broken visual immediately (no flash on re-render), then re-check
    // that the target still exists (and, for tasks, refresh status/dates) against the host.
    if (this.broken) this.applyBroken(true);
    if (this.deps.linkSource) this.hydrate();
  }

  private hydrate(): void {
    if (this.isTask()) this.hydrateTask();
    else this.hydrateLink();
  }

  // Fetch the task's done state + dates and fill in the status dot and the meta chips. A null
  // lookup means the task was deleted — mark the chip broken.
  private hydrateTask(): void {
    const src = this.deps.linkSource;
    if (!src) return;
    const token = ++this.token;
    const id = this.attrs.id;
    src
      .lookup(id)
      .then((hit) => {
        if (token !== this.token) return;
        if (!hit) {
          this.applyBroken(true);
          return;
        }
        this.applyBroken(false);
        if (hit.type !== "task") return;
        const done = hit.status === "done";
        this.dom.setAttribute("data-status", done ? "done" : "open");
        const meta = this.dom.querySelector(".pm-wikilink-meta");
        if (!meta) return;
        meta.textContent = "";
        if (hit.dueAt) meta.appendChild(metaChip("pm-wikilink-due", formatDue(hit.dueAt)));
        if (hit.remindAt) meta.appendChild(metaChip("pm-wikilink-remind", "⏰ " + formatReminder(hit.remindAt)));
      })
      .catch(() => {
        /* transient error: leave the chip as it is */
      });
  }

  // Non-task chips carry a static label, so we only confirm the target still exists; a null
  // lookup (deleted note / habit / project) marks the chip broken.
  private hydrateLink(): void {
    const src = this.deps.linkSource;
    if (!src) return;
    const token = ++this.token;
    src
      .lookup(this.attrs.id)
      .then((hit) => {
        if (token !== this.token) return;
        this.applyBroken(!hit);
      })
      .catch(() => {
        /* transient error: leave the chip as it is */
      });
  }

  // Toggle the broken-reference visual: a leading unlink icon plus the muted, struck-through
  // chip styling (see styles.ts). Idempotent against the current DOM so it survives re-render.
  private applyBroken(broken: boolean): void {
    this.broken = broken;
    this.dom.classList.toggle("pm-wikilink-broken", broken);
    const existing = this.dom.querySelector(".pm-wikilink-brokenicon");
    if (broken && !existing) this.dom.insertBefore(brokenIcon(), this.dom.firstChild);
    else if (!broken && existing) existing.remove();
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

// A small "unlink" glyph (feather-style) shown when a chip's target no longer exists.
function brokenIcon(): HTMLElement {
  const span = document.createElement("span");
  span.className = "pm-wikilink-brokenicon";
  span.setAttribute("aria-label", "Broken reference");
  span.setAttribute("title", "This reference no longer exists");
  span.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
    '<line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/>' +
    '<line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>';
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
