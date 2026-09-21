import { DOMSerializer, type Node } from "prosemirror-model";
import { parser, schema } from "./wikilink";
import type { ResolvedDocument } from "./types";

// Rendering a note's markdown for export (File › Export): static HTML, plain text, or markdown
// that reads outside the app. It goes through the editor's own parser and schema, so an export
// holds exactly what the editor shows — task items, tables, strikethrough, wikilinks, embeds.
// DOM-only (DOMSerializer needs a document); imported as "@companion/editor/export" so native
// bundles, which host the editor in a WebView, never pull ProseMirror in.

export interface MarkdownExportOptions {
  /** The title of a `[[type:id]]` target; null when it's gone. Omit and chips show their alias or id. */
  resolveLink?: (type: string, id: string) => Promise<string | null>;
  /** An embedded document's bytes as a URL (PLAN §6.9). Omit and embeds become filename chips. */
  resolveDocument?: (id: string) => Promise<ResolvedDocument | null>;
}

interface LinkAttrs {
  embed: boolean;
  type: string;
  id: string;
  alias: string | null;
}

const isEmbed = (a: LinkAttrs) => a.type === "document" && a.embed;

function parse(markdown: string): Node {
  return parser.parse(markdown) ?? schema.node("doc", null, [schema.node("paragraph")]);
}

/** Every wikilink's label, keyed `type:id`: the alias when the writer gave one, else the target's title. */
async function linkLabels(doc: Node, opts: MarkdownExportOptions): Promise<Map<string, string>> {
  const found = new Map<string, LinkAttrs>();
  doc.descendants((node) => {
    if (node.type.name === "wikilink") {
      const a = node.attrs as LinkAttrs;
      found.set(`${a.type}:${a.id}`, a);
    }
  });
  const labels = new Map<string, string>();
  await Promise.all(
    [...found].map(async ([key, a]) => {
      let title: string | null = null;
      if (isEmbed(a)) title = (await opts.resolveDocument?.(a.id).catch(() => null))?.filename || null;
      else title = (await opts.resolveLink?.(a.type, a.id).catch(() => null)) ?? null;
      labels.set(key, title || a.alias || a.id);
    }),
  );
  return labels;
}

const labelOf = (a: LinkAttrs, labels: Map<string, string>) => (isEmbed(a) ? null : a.alias) || labels.get(`${a.type}:${a.id}`) || a.id;

/** A URL's bytes as a data: URL, so exported HTML carries its images with it. */
async function dataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The markdown as an HTML fragment. Wikilinks read as their target's title; embedded images are
 *  inlined as data: URLs and other embedded files become filename chips. */
export async function markdownToHtml(markdown: string, opts: MarkdownExportOptions = {}): Promise<string> {
  const doc = parse(markdown);
  const labels = await linkLabels(doc, opts);
  const holder = document.createElement("div");
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));

  for (const chip of Array.from(holder.querySelectorAll<HTMLElement>("span.pm-wikilink"))) {
    const a: LinkAttrs = {
      embed: chip.classList.contains("pm-wikilink-embed"),
      type: chip.getAttribute("data-type") || "note",
      id: chip.getAttribute("data-id") || "",
      alias: chip.getAttribute("data-alias"),
    };
    chip.removeAttribute("data-id");
    chip.removeAttribute("data-alias");
    if (!isEmbed(a)) {
      chip.textContent = labelOf(a, labels);
      continue;
    }
    const res = await opts.resolveDocument?.(a.id).catch(() => null);
    const src = res && res.mime.startsWith("image/") ? await dataUrl(res.url) : null;
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = res?.filename || "";
      chip.replaceWith(img);
    } else {
      chip.className = "pm-file";
      chip.textContent = res?.filename || labelOf(a, labels);
    }
  }
  // A static page has nothing to toggle or edit.
  holder.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  return holder.innerHTML;
}

/** The markdown with app-only syntax made portable: `[[note:<id>]]` becomes `[[Title]]` (an alias
 *  is kept as `[[Title|alias]]`) and `![[doc:<id>]]` becomes `![[filename]]`. */
export async function portableMarkdown(markdown: string, opts: MarkdownExportOptions = {}): Promise<string> {
  const labels = await linkLabels(parse(markdown), opts);
  return markdown.replace(/(!?)\[\[([a-z]+):([^\]|]+)(?:\|([^\]]*))?\]\]/g, (whole, bang: string, type: string, id: string, alias?: string) => {
    const canonical = type === "doc" ? "document" : type;
    const title = labels.get(`${canonical}:${id}`);
    if (!title) return whole;
    return `${bang}[[${title}${alias && alias !== title ? `|${alias}` : ""}]]`;
  });
}

/** The markdown as plain text: headings and paragraphs as lines, lists with their bullets,
 *  numbers and checkboxes, tables tab-separated, links as their text. */
export async function markdownToText(markdown: string, opts: MarkdownExportOptions = {}): Promise<string> {
  const doc = parse(markdown);
  const labels = await linkLabels(doc, opts);

  const inline = (node: Node): string => {
    let out = "";
    node.forEach((child) => {
      if (child.isText) out += child.text ?? "";
      else if (child.type.name === "wikilink") out += labelOf(child.attrs as LinkAttrs, labels);
      else if (child.type.name === "hard_break") out += "\n";
      else if (child.type.name === "image") out += (child.attrs.alt as string) || (child.attrs.src as string) || "";
      else out += inline(child);
    });
    return out;
  };

  const indent = (text: string, first: string) => {
    const pad = " ".repeat(first.length);
    return text
      .split("\n")
      .map((line, i) => (i === 0 ? first + line : line ? pad + line : line))
      .join("\n");
  };

  const blocks = (parent: Node): string[] => {
    const out: string[] = [];
    parent.forEach((node) => {
      switch (node.type.name) {
        case "bullet_list":
        case "ordered_list": {
          const start = (node.attrs.order as number | undefined) ?? 1;
          const items: string[] = [];
          node.forEach((item, _offset, i) => {
            const checked = item.attrs.checked as boolean | null;
            const marker = checked === null || checked === undefined ? (node.type.name === "ordered_list" ? `${start + i}. ` : "- ") : checked ? "[x] " : "[ ] ";
            items.push(indent(blocks(item).join("\n"), marker));
          });
          out.push(items.join("\n"));
          break;
        }
        case "blockquote":
          out.push(
            blocks(node)
              .join("\n\n")
              .split("\n")
              .map((line) => `> ${line}`.trimEnd())
              .join("\n"),
          );
          break;
        case "code_block":
          out.push(node.textContent);
          break;
        case "horizontal_rule":
          out.push("----------");
          break;
        case "table": {
          const rows: string[] = [];
          node.forEach((row) => {
            const cells: string[] = [];
            // A cell holds its text directly (tables.ts), not paragraphs.
            row.forEach((cell) => cells.push((cell.inlineContent ? inline(cell) : blocks(cell).join(" ")).replace(/\s+/g, " ")));
            rows.push(cells.join("\t"));
          });
          out.push(rows.join("\n"));
          break;
        }
        default:
          out.push(node.isTextblock ? inline(node) : blocks(node).join("\n\n"));
      }
    });
    return out;
  };

  return blocks(doc).join("\n\n").trim() + "\n";
}
