import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import type { DocumentSource } from "./types";

// A NodeView for a document embed — `![[doc:<id>]]` (PLAN §6.9). Unlike the plain wikilink
// pill, it renders the file's contents inline: an image preview, an audio player, or a file
// chip with a download link for anything else. The bytes are resolved to a URL through the
// host's DocumentSource (which downloads them lazily on first view); raw bytes never reach
// the editor. Without a DocumentSource it degrades to a static filename chip.

export interface DocumentViewDeps {
  documentSource?: DocumentSource;
}

interface Attrs {
  embed: boolean;
  type: string;
  id: string;
  alias: string | null;
}

/** True when a node should render as a rich document embed rather than a link chip. */
export function isDocumentEmbed(node: Node): boolean {
  const a = node.attrs as Attrs;
  return a.type === "document" && a.embed;
}

export function documentNodeView(deps: DocumentViewDeps) {
  return (node: Node, view: EditorView, getPos: () => number | undefined): NodeView =>
    new DocumentView(node, view, getPos, deps);
}

export class DocumentView implements NodeView {
  dom: HTMLElement;
  private attrs: Attrs;
  private token = 0;
  private objectUrl: string | null = null;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
    private deps: DocumentViewDeps,
  ) {
    this.attrs = node.attrs as Attrs;
    this.dom = document.createElement("span");
    this.dom.className = "pm-doc-embed";
    this.dom.setAttribute("data-id", this.attrs.id);
    this.dom.addEventListener("mousedown", this.onMouseDown);
    this.dom.addEventListener("click", this.onClick);
    this.render();
  }

  private label(): string {
    return this.attrs.alias || this.attrs.id;
  }

  private render(): void {
    const token = ++this.token;
    this.revoke();
    this.dom.textContent = "";
    this.dom.appendChild(chip("pm-doc-loading", this.label(), "Loading…"));

    const src = this.deps.documentSource;
    if (!src) {
      // No host store: show a static filename chip (the reference is still valid markdown).
      this.dom.textContent = "";
      this.dom.appendChild(fileChip(this.label(), null, null));
      return;
    }
    src
      .resolveUrl(this.attrs.id)
      .then((res) => {
        if (token !== this.token) return; // stale (node updated / destroyed)
        this.dom.textContent = "";
        if (!res) {
          this.dom.appendChild(fileChip(this.label(), null, null, /*broken*/ true));
          return;
        }
        this.objectUrl = res.url;
        this.dom.appendChild(this.renderMedia(res.url, res.mime, res.filename));
      })
      .catch(() => {
        if (token !== this.token) return;
        this.dom.textContent = "";
        this.dom.appendChild(fileChip(this.label(), null, null, true));
      });
  }

  // Pick a renderer by MIME family: images inline, audio as a player, everything else a
  // downloadable file chip.
  private renderMedia(url: string, mime: string, filename: string): HTMLElement {
    if (mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "pm-doc-image";
      img.src = url;
      img.alt = filename;
      img.draggable = false;
      return img;
    }
    if (mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.className = "pm-doc-audio";
      audio.controls = true;
      audio.src = url;
      // Let the player receive clicks without the node stealing them for selection.
      audio.addEventListener("mousedown", (e) => e.stopPropagation());
      return audio;
    }
    return fileChip(filename, url, mime);
  }

  // First click selects the node (so it can be deleted); download links handle their own
  // clicks (they stopPropagation), so they never trigger selection.
  private onMouseDown = (e: MouseEvent): void => {
    if ((e.target as HTMLElement)?.closest("a")) return;
    e.preventDefault();
  };

  private onClick = (e: MouseEvent): void => {
    if ((e.target as HTMLElement)?.closest("a")) return; // let the download link work
    e.preventDefault();
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.view.focus();
  };

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  update(node: Node): boolean {
    // Only handles document embeds; any other shape forces ProseMirror to rebuild the view
    // (e.g. back into the plain wikilink chip).
    if (node.type !== this.node.type || !isDocumentEmbed(node)) return false;
    const next = node.attrs as Attrs;
    const changed = next.id !== this.attrs.id || next.alias !== this.attrs.alias;
    this.node = node;
    this.attrs = next;
    if (changed) this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  destroy(): void {
    this.token++;
    this.revoke();
    this.dom.removeEventListener("mousedown", this.onMouseDown);
    this.dom.removeEventListener("click", this.onClick);
  }
}

// A small labeled chip used for the loading state.
function chip(className: string, label: string, hint: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "pm-doc-chip " + className;
  const name = document.createElement("span");
  name.className = "pm-doc-name";
  name.textContent = label;
  span.appendChild(name);
  const meta = document.createElement("span");
  meta.className = "pm-doc-hint";
  meta.textContent = hint;
  span.appendChild(meta);
  return span;
}

// A file chip: filename plus, when a URL is available, a download link. `broken` marks a
// document whose bytes couldn't be resolved (not synced/downloaded yet, or missing).
function fileChip(filename: string, url: string | null, mime: string | null, broken = false): HTMLElement {
  const span = document.createElement("span");
  span.className = "pm-doc-chip pm-doc-file" + (broken ? " pm-doc-broken" : "");
  const icon = document.createElement("span");
  icon.className = "pm-doc-fileicon";
  icon.textContent = "📄";
  span.appendChild(icon);
  const name = document.createElement("span");
  name.className = "pm-doc-name";
  name.textContent = filename;
  span.appendChild(name);
  if (url) {
    const link = document.createElement("a");
    link.className = "pm-doc-download";
    link.href = url;
    link.download = filename;
    link.textContent = "Download";
    span.appendChild(link);
  } else if (broken) {
    const hint = document.createElement("span");
    hint.className = "pm-doc-hint";
    hint.textContent = "unavailable";
    span.appendChild(hint);
  }
  void mime;
  return span;
}
