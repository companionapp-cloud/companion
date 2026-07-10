import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";
import {
  schema as baseSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import { Plugin } from "prosemirror-state";
import { addTableNodes, enableTableTokenizer, tableParseTokens, tableSerializerNodes } from "./tables";

// Wikilinks ([[type:id]] / ![[type:id|alias]]) are first-class in the editor: they
// round-trip as valid markdown (never bracket-escaped) and render as a chip. The
// recognized target types mirror core/domain/links.go so what the editor writes is what
// the link index parses.
export const LINK_TYPES = new Set(["note", "task", "habit", "project", "document"]);

// Short type tokens accepted in markdown, normalized to the canonical node type (mirrors
// core/domain/links.go typeAliases). Documents are embedded as `![[doc:<id>]]` (PLAN §6.9)
// but their canonical type is "document"; normalizing on parse keeps the editor's node
// attrs canonical, and the serializer writes the short form back out.
const TYPE_ALIASES: Record<string, string> = { doc: "document" };
const TYPE_SERIALIZE: Record<string, string> = { document: "doc" };

/** Normalize a markdown type token (e.g. "doc") to its canonical node type ("document"). */
export function normalizeLinkType(token: string): string {
  return TYPE_ALIASES[token] ?? token;
}

/** Build a wikilink node from a resolved target, in the given schema. Used by the
 * autocomplete menu and the UUID-paste handler so every inserted chip is shaped the same
 * way. The schema is passed in because the full and simple editors each own a distinct
 * `wikilink` node type, and a node made in one schema can't be inserted into the other. */
export function wikilinkNode(
  targetSchema: Schema,
  attrs: {
    type: string;
    id: string;
    alias?: string | null;
    embed?: boolean;
  },
) {
  return targetSchema.nodes.wikilink.create({
    // Documents have no meaningful plain-link chip — their canonical form is an
    // `![[doc:…]]` embed that renders the file inline (PLAN §6.9) — so always embed them,
    // regardless of whether the picker was opened with `[[` or `![[`.
    embed: attrs.type === "document" ? true : (attrs.embed ?? false),
    type: attrs.type,
    id: attrs.id,
    alias: attrs.alias ?? null,
  });
}

// The inner grammar of a wikilink body ("type:id" with an optional "|alias"), shared by
// the markdown tokenizer and the type-to-chip input rule.
const BODY_RE = /^\s*([a-zA-Z]+)\s*:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?$/;

/** Parse a wikilink body ("type:id" / "type:id|alias") into its resolved parts, or null if
 * it isn't a valid, known link type. Used to tell a real `[[type:id]]` from an unresolved
 * `[[label]]` "empty" link (see emptyWikilink.ts) and to scope `[[` autocomplete searches. */
export function parseWikilinkBody(
  body: string,
): { type: string; id: string; alias: string | null } | null {
  const m = BODY_RE.exec(body);
  if (!m) return null;
  const type = normalizeLinkType(m[1]);
  if (!LINK_TYPES.has(type)) return null;
  return { type, id: m[2], alias: m[3] || null };
}

// ---------------------------------------------------------------------------
// Schema: an inline, atomic chip node carrying the parsed target. Exported so the
// simple (plain-text) schema can reuse the exact same chip node (see simpleSchema.ts).
// ---------------------------------------------------------------------------
export const wikilinkSpec: NodeSpec = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: {
    embed: { default: false },
    type: { default: "note" },
    id: { default: "" },
    alias: { default: null },
  },
  toDOM(node) {
    const { embed, type, id, alias } = node.attrs as {
      embed: boolean;
      type: string;
      id: string;
      alias: string | null;
    };
    const attrs: Record<string, string> = {
      class: embed ? "pm-wikilink pm-wikilink-embed" : "pm-wikilink",
      "data-type": type,
      "data-id": id,
    };
    if (alias) attrs["data-alias"] = alias;
    // The chip label is the alias when given, else the raw id (the editor has no note
    // store to resolve titles); the type shows as a small leading badge via CSS.
    return ["span", attrs, alias || id];
  },
  parseDOM: [
    {
      tag: "span.pm-wikilink",
      getAttrs(dom) {
        const el = dom as HTMLElement;
        return {
          embed: el.classList.contains("pm-wikilink-embed"),
          type: el.getAttribute("data-type") || "note",
          id: el.getAttribute("data-id") || "",
          alias: el.getAttribute("data-alias"),
        };
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Task list items: `list_item` gains a `checked` attr (null = a plain bullet;
// true/false = a todo). It round-trips as GFM `- [ ]` / `- [x]` and renders with a
// round checkbox the reader can click (see createEditor's taskCheckboxPlugin).
// ---------------------------------------------------------------------------
const baseListItem = baseSchema.spec.nodes.get("list_item") as NodeSpec;
const listItem: NodeSpec = {
  ...baseListItem,
  attrs: { checked: { default: null } },
  toDOM(node) {
    if (node.attrs.checked === null) return ["li", 0];
    return [
      "li",
      { class: "pm-task-item", "data-checked": node.attrs.checked ? "true" : "false" },
      ["span", { class: "pm-task-checkbox", contenteditable: "false" }],
      ["div", { class: "pm-task-body" }, 0],
    ];
  },
  parseDOM: [
    {
      tag: "li",
      getAttrs(dom) {
        const c = (dom as HTMLElement).getAttribute("data-checked");
        return { checked: c === null ? null : c === "true" };
      },
    },
  ],
};

// Strikethrough (`~~text~~`) — the base prosemirror-markdown schema ships em/strong/code/link
// but no strike, so add it and teach the parser/serializer below to round-trip it as GFM.
const strikethroughSpec: MarkSpec = {
  parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
  toDOM() {
    return ["s", 0];
  },
};

export const schema = new Schema({
  nodes: addTableNodes(baseSchema.spec.nodes.update("list_item", listItem).addToEnd("wikilink", wikilinkSpec)),
  marks: baseSchema.spec.marks.addToEnd("strikethrough", strikethroughSpec),
});

// ---------------------------------------------------------------------------
// Parser: a markdown-it inline rule that emits a single leaf token per wikilink.
// ---------------------------------------------------------------------------
interface InlineToken {
  content: string;
  meta: unknown;
}
interface InlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): InlineToken;
}

function wikilinkRule(state: InlineState, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  let pos = start;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false; /* [[ */
  const close = src.indexOf("]]", pos + 2);
  if (close < 0) return false;
  const body = src.slice(pos + 2, close);
  const m = BODY_RE.exec(body);
  const type = m ? normalizeLinkType(m[1]) : "";
  if (!m || !LINK_TYPES.has(type)) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.content = body;
    token.meta = { embed, type, id: m[2], alias: m[3] || null };
  }
  state.pos = close + 2;
  return true;
}

// Register on the shared tokenizer. Only the parser below consumes these tokens, so
// mutating the default instance is safe (nothing else parses wikilinks). The tokenizer
// is a singleton that outlives module reloads, so guard against registering twice under
// HMR (which would stack duplicate rules).
type RulerBefore = typeof defaultMarkdownParser.tokenizer.inline.ruler.before;
const tokenizer = defaultMarkdownParser.tokenizer as typeof defaultMarkdownParser.tokenizer & {
  __wikilinkRule?: boolean;
  __taskListRule?: boolean;
  __strikethrough?: boolean;
  enable?(rules: string | string[], ignoreInvalid?: boolean): unknown;
};
// prosemirror-markdown's default tokenizer uses the CommonMark preset, which disables GFM
// strikethrough. Re-enable it so `~~text~~` tokenizes (the parser maps its `s` token below).
if (!tokenizer.__strikethrough) {
  tokenizer.enable?.("strikethrough");
  tokenizer.__strikethrough = true;
}
if (!tokenizer.__wikilinkRule) {
  tokenizer.inline.ruler.before("link", "wikilink", wikilinkRule as unknown as Parameters<RulerBefore>[2]);
  tokenizer.__wikilinkRule = true;
}
// GFM pipe tables — also disabled by the CommonMark preset (see tables.ts).
enableTableTokenizer(tokenizer);

// Task-list marker: after inline parsing, find list items whose first line starts with
// `[ ]`/`[x]`, record the checked state on the list_item token, and strip the marker so
// the paragraph keeps clean text. Mirrors markdown-it-task-lists (not a dependency).
interface CoreToken {
  type: string;
  content: string;
  children: { type: string; content: string }[] | null;
  attrSet(name: string, value: string): void;
  attrGet(name: string): string | null;
}
function taskListCoreRule(state: { tokens: CoreToken[] }): void {
  const { tokens } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline") continue;
    if (tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX])\]\s/.exec(inline.content);
    if (!m) continue;
    tokens[i - 2].attrSet("checked", m[1] === "x" || m[1] === "X" ? "true" : "false");
    inline.content = inline.content.slice(m[0].length);
    const child = inline.children?.[0];
    if (child && child.type === "text") child.content = child.content.slice(m[0].length);
  }
}
if (!tokenizer.__taskListRule) {
  (
    defaultMarkdownParser.tokenizer as unknown as {
      core: { ruler: { after(anchor: string, name: string, fn: (s: { tokens: CoreToken[] }) => void): void } };
    }
  ).core.ruler.after("inline", "companion_task_list", taskListCoreRule);
  tokenizer.__taskListRule = true;
}

function parseChecked(v: string | null | undefined): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export const parser = new MarkdownParser(schema, defaultMarkdownParser.tokenizer, {
  ...defaultMarkdownParser.tokens,
  ...tableParseTokens,
  // markdown-it emits s_open/s_close for `~~…~~`; map it onto our strikethrough mark.
  s: { mark: "strikethrough" },
  list_item: {
    block: "list_item",
    getAttrs: (tok) => ({ checked: parseChecked((tok as unknown as CoreToken).attrGet("checked")) }),
  },
  wikilink: {
    node: "wikilink",
    getAttrs: (tok) => {
      const meta = (tok.meta ?? {}) as {
        embed?: boolean;
        type?: string;
        id?: string;
        alias?: string | null;
      };
      return {
        embed: !!meta.embed,
        type: meta.type ?? "note",
        id: meta.id ?? "",
        alias: meta.alias ?? null,
      };
    },
  },
});

// ---------------------------------------------------------------------------
// Serializer: write the wikilink markdown raw so its brackets are never escaped.
// ---------------------------------------------------------------------------
// An unresolved "empty" link kept as literal `[[label]]` text (see emptyWikilink.ts). The
// default text serializer escapes `[`/`]`, which would write `\[\[label\]\]`; match these
// runs so they can be emitted raw and round-trip cleanly.
const EMPTY_LINK_RE = /\[\[[^[\]\n]+\]\]/g;

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    // GFM pipe-table subtree (table walks its own rows/cells; see tables.ts).
    ...tableSerializerNodes(),
    // Write text normally, but emit `[[label]]` empty-link runs without markdown escaping so
    // they persist as clean wikilink text (real `[[type:id]]` links are chip nodes, not text).
    text(state, node) {
      const text = node.text ?? "";
      let last = 0;
      let m: RegExpExecArray | null;
      EMPTY_LINK_RE.lastIndex = 0;
      while ((m = EMPTY_LINK_RE.exec(text)) !== null) {
        if (m.index > last) state.text(text.slice(last, m.index), true);
        state.text(m[0], false);
        last = m.index + m[0].length;
      }
      if (last < text.length) state.text(text.slice(last), true);
    },
    list_item(state, node) {
      // A todo writes its GFM marker before the item's content; plain bullets are unchanged.
      if (node.attrs.checked !== null) state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    wikilink(state, node) {
      const { embed, type, id, alias } = node.attrs as {
        embed: boolean;
        type: string;
        id: string;
        alias: string | null;
      };
      const token = TYPE_SERIALIZE[type] ?? type;
      state.write(`${embed ? "!" : ""}[[${token}:${id}${alias ? `|${alias}` : ""}]]`);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  },
);

// ---------------------------------------------------------------------------
// Input rule: turn a wikilink typed by hand into a chip the moment it's closed.
// ---------------------------------------------------------------------------
const INPUT_RE = /(!?)\[\[\s*([a-zA-Z]+)\s*:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]$/;

export function wikilinkInputRules(targetSchema: Schema): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, _to, text) {
        // Wikilinks close with "]]", so only bother when the input ends a bracket.
        if (!text.endsWith("]")) return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock) return false;
        const blockStart = $from.start();
        // Text of the current block up to the cursor, plus the char being typed (which
        // isn't in the doc yet). Existing atoms collapse to a placeholder so they can't
        // bleed into the match.
        const before = view.state.doc.textBetween(blockStart, from, undefined, "￼") + text;
        const m = INPUT_RE.exec(before);
        const type = m ? normalizeLinkType(m[2]) : "";
        if (!m || !LINK_TYPES.has(type)) return false;
        const matchStart = from - (m[0].length - text.length);
        if (matchStart < blockStart) return false;
        const node = targetSchema.nodes.wikilink.create({
          embed: m[1] === "!",
          type,
          id: m[3],
          alias: m[4] || null,
        });
        view.dispatch(view.state.tr.replaceRangeWith(matchStart, from, node).scrollIntoView());
        return true;
      },
    },
  });
}
