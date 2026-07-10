import type { Node, NodeSpec, Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { MarkdownSerializerState } from "prosemirror-markdown";
import { tableNodes, TableMap } from "prosemirror-tables";
import type Token from "markdown-it/lib/token.mjs";

// GFM pipe tables as first-class editor nodes. Like the wikilink/task-list extensions
// (see wikilink.ts) they round-trip as clean markdown: the note file keeps `| a | b |`
// syntax while the editor renders real <table> rows/cells. Built on prosemirror-tables for
// the node model + editing commands (add/delete/move), but the markdown parse/serialize and
// the column-alignment attr are ours (that package only speaks ProseMirror, not markdown).
//
// Cells hold inline content ("inline*") to mirror GFM, which is single-line-per-cell — so a
// cell's markdown is just its inline serialization with pipes escaped. We deliberately omit
// prosemirror-tables' columnResizing plugin: columns auto-size and are not resizable.

export type ColumnAlign = "left" | "center" | "right" | null;

// table / table_row / table_header / table_cell specs. `align` renders as `text-align` (so
// HTML copy/paste and rendering reflect it) and is read back from the same style on parse.
const { table, table_row, table_cell, table_header } = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom) {
        return (dom as HTMLElement).style.textAlign || null;
      },
      setDOMAttr(value, attrs) {
        if (value) attrs.style = `${(attrs.style as string) ?? ""}text-align: ${value};`;
      },
    },
  },
});

export const tableSpecs: Record<string, NodeSpec> = { table, table_row, table_header, table_cell };

/** Merge the four table node specs onto a schema's node OrderedMap (see wikilink.ts). */
export function addTableNodes<T extends { addToEnd(key: string, spec: NodeSpec): T }>(nodes: T): T {
  return nodes
    .addToEnd("table", table)
    .addToEnd("table_row", table_row)
    .addToEnd("table_header", table_header)
    .addToEnd("table_cell", table_cell);
}

// ---------------------------------------------------------------------------
// Parser: enable markdown-it's GFM table rule (the CommonMark preset ships it disabled,
// same as strikethrough) and map its tokens onto the table nodes.
// ---------------------------------------------------------------------------

// Inline rule: `<br>` / `<br/>` / `<br />` becomes a hardbreak token (mapped to hard_break by the
// default parser). The CommonMark preset has HTML off, so without this a `<br>` in a cell would
// round-trip as literal text; this is what lets multiline cells survive parse. Harmless elsewhere
// (a `<br>` anywhere is just a line break).
interface BrState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): unknown;
}
function brRule(state: BrState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
  const m = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += m[0].length;
  return true;
}

/** Enable the GFM `table` core rule and the `<br>` inline rule on the shared tokenizer (once). */
export function enableTableTokenizer(
  tokenizer: {
    enable?(rules: string | string[]): unknown;
    inline?: { ruler: { before(anchor: string, name: string, fn: (s: BrState, silent: boolean) => boolean): void } };
    __tables?: boolean;
  },
): void {
  if (tokenizer.__tables) return;
  tokenizer.enable?.("table");
  tokenizer.inline?.ruler.before("link", "companion_br", brRule);
  tokenizer.__tables = true;
}

function alignFromToken(tok: Token): { align: ColumnAlign } {
  const style = tok.attrGet?.("style");
  if (style) {
    const m = /text-align:\s*(left|center|right)/i.exec(style);
    if (m) return { align: m[1].toLowerCase() as ColumnAlign };
  }
  return { align: null };
}

// markdown-it emits table_open, thead/tbody wrappers, tr, and th/td. prosemirror-tables has
// no thead/tbody nodes (rows sit directly under the table), so those wrappers are ignored.
export const tableParseTokens = {
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok: Token) => alignFromToken(tok) },
  td: { block: "table_cell", getAttrs: (tok: Token) => alignFromToken(tok) },
} as const;

// ---------------------------------------------------------------------------
// Serializer: write a table as a GFM pipe table. The header row is row 0 (its cells are
// table_header, matching markdown-it's thead), then the alignment/delimiter row, then body.
// ---------------------------------------------------------------------------

const ALIGN_DELIM: Record<string, string> = { left: ":---", center: ":---:", right: "---:" };

// MarkdownSerializerState's constructor and `out` field are marked @internal, so reach them
// through a runtime-accurate shim (they exist; the public types just hide them).
type StateInternals = { renderInline(node: Node): void; out: string; options: unknown };
const StateImpl = MarkdownSerializerState as unknown as new (
  nodes: unknown,
  marks: unknown,
  options: unknown,
) => StateInternals;

/** A renderer that turns a single cell's inline content into escaped, single-line markdown.
 * Built from a serializer's node/mark maps so cell text uses the same wikilink/mark output. */
export function cellRenderer(nodes: unknown, marks: unknown, options: unknown = {}): (cell: Node) => string {
  // A cell can hold multiple lines (hard breaks). A literal newline would break the pipe table,
  // so a hard break renders as `<br>` — the only GFM-safe in-cell line break (it parses back to a
  // hard_break; see the `<br>` inline rule below).
  const cellNodes = { ...(nodes as Record<string, unknown>), hard_break: (state: { write(s: string): void }) => state.write("<br>") };
  return (cell) => {
    const sub = new StateImpl(cellNodes, marks, options);
    sub.renderInline(cell);
    // Pipes must be escaped inside a cell (markdown-it restores `\|` to `|` before parsing
    // the cell's inline content, so wikilink aliases survive); any stray newline collapses.
    return sub.out.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
  };
}

/** Render a table node to a GFM pipe-table string (no trailing newline). `cellToMd` renders
 * one cell's inline content; see {@link cellRenderer}. Shared by the serializer and copy. */
export function tableToMarkdown(node: Node, cellToMd: (cell: Node) => string): string {
  const rows: Node[][] = [];
  node.forEach((row) => {
    const cells: Node[] = [];
    row.forEach((cell) => cells.push(cell));
    rows.push(cells);
  });
  if (rows.length === 0) return "";
  const cols = rows[0].length;
  const line = (cells: (Node | null)[]) =>
    "| " + cells.map((c) => (c ? cellToMd(c) : "")).join(" | ") + " |";
  const lines: string[] = [];
  lines.push(line(rows[0]));
  const aligns = rows[0].map((c) => c.attrs.align as ColumnAlign);
  lines.push("| " + aligns.map((a) => ALIGN_DELIM[a ?? ""] ?? "---").join(" | ") + " |");
  for (let r = 1; r < rows.length; r++) {
    const cells: (Node | null)[] = rows[r].slice(0, cols);
    while (cells.length < cols) cells.push(null);
    lines.push(line(cells));
  }
  return lines.join("\n");
}

/** Serializer node entries for the table subtree. Only `table` does work; rows/cells are
 * walked by it, so their own serializers are no-ops (they're never reached at block level). */
export function tableSerializerNodes(): Record<
  string,
  (state: MarkdownSerializerState, node: Node) => void
> {
  const noop = () => {};
  return {
    table(state, node) {
      const s = state as unknown as { nodes: unknown; marks: unknown; options: unknown };
      const render = cellRenderer(s.nodes, s.marks, s.options);
      // text(..., false) writes the multi-line table verbatim while still applying any block
      // delimiter (so a table nested in a blockquote/list keeps its prefix per line).
      state.text(tableToMarkdown(node, render), false);
      state.closeBlock(node);
    },
    table_row: noop,
    table_header: noop,
    table_cell: noop,
  };
}

// ---------------------------------------------------------------------------
// Construction: a starter table for the "insert table" action, and a builder used by the
// paste handler to turn a grid of cell strings into a table node.
// ---------------------------------------------------------------------------

/** A blank `rows`×`cols` table (row 0 is the header). Cells are empty inline content. */
export function createTable(schema: Schema, rows = 2, cols = 2): Node {
  const nodes = schema.nodes;
  const headerCells: Node[] = [];
  for (let c = 0; c < cols; c++) headerCells.push(nodes.table_header.createAndFill()!);
  const rowNodes: Node[] = [nodes.table_row.create(null, headerCells)];
  for (let r = 1; r < rows; r++) {
    const cells: Node[] = [];
    for (let c = 0; c < cols; c++) cells.push(nodes.table_cell.createAndFill()!);
    rowNodes.push(nodes.table_row.create(null, cells));
  }
  return nodes.table.create(null, rowNodes);
}

// ---------------------------------------------------------------------------
// Typed-markdown conversion: pressing Enter on a GFM delimiter row (`| --- | --- |`) directly
// under a pipe header line turns the two lines into a table (with a fresh empty body row). The
// weakest of the three insert paths (toolbar + paste are the dependable ones), but it lets a
// hand-typed table "just work".
// ---------------------------------------------------------------------------

// A delimiter row: pipe-separated runs of dashes, each optionally flanked by colons.
const DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on unescaped pipes; a wikilink alias etc. can escape a literal `|` as `\|`.
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function alignOfDelim(cell: string): ColumnAlign {
  const s = cell.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** Enter command: convert a header+delimiter pair at the cursor into a table. Returns false
 * (so the keymap chain continues) unless the two lines form a valid GFM table head. */
export function tableFromMarkdownCommand(schema: Schema): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!sel.empty) return false;
    const $from = sel.$from;
    const para = $from.parent;
    if (para.type.name !== "paragraph" || $from.parentOffset !== para.content.size) return false;
    if (!DELIM_ROW.test(para.textContent) || !para.textContent.includes("-")) return false;
    const index = $from.index(-1);
    if (index < 1) return false;
    const container = $from.node(-1);
    const header = container.child(index - 1);
    if (header.type.name !== "paragraph" || !header.textContent.includes("|")) return false;

    const headers = splitRow(header.textContent);
    const delims = splitRow(para.textContent);
    if (headers.length < 1 || headers.length !== delims.length) return false;

    if (dispatch) {
      const nodes = schema.nodes;
      const unescape = (t: string) => t.replace(/\\\|/g, "|");
      const headerCells = headers.map((h, i) =>
        nodes.table_header.createAndFill({ align: alignOfDelim(delims[i]) }, h ? [schema.text(unescape(h))] : undefined)!,
      );
      const bodyCells = headers.map(() => nodes.table_cell.createAndFill()!);
      const table = nodes.table.create(null, [
        nodes.table_row.create(null, headerCells),
        nodes.table_row.create(null, bodyCells),
      ]);
      // Replace the two source paragraphs (header + delimiter) with the table.
      const start = $from.before() - header.nodeSize;
      const end = $from.after();
      const tr = state.tr.replaceWith(start, end, table);
      const map = TableMap.get(table);
      const cell = start + 1 + map.positionAt(1, 0, table);
      tr.setSelection(TextSelection.create(tr.doc, cell + 1)).scrollIntoView();
      dispatch(tr);
    }
    return true;
  };
}

/** Build a table node from a grid of plain-text cells (first row = header). Used by the
 * TSV paste handler; ragged rows are padded to the header width. */
export function tableFromGrid(schema: Schema, grid: string[][]): Node | null {
  const rows = grid.filter((r) => r.length > 0);
  if (rows.length === 0) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  const nodes = schema.nodes;
  const mkCell = (type: "table_header" | "table_cell", text: string): Node => {
    const content = text ? [schema.text(text)] : undefined;
    return nodes[type].createAndFill(null, content)!;
  };
  const rowNodes: Node[] = [];
  rows.forEach((cells, r) => {
    const type = r === 0 ? "table_header" : "table_cell";
    const cellNodes: Node[] = [];
    for (let c = 0; c < cols; c++) cellNodes.push(mkCell(type, cells[c] ?? ""));
    rowNodes.push(nodes.table_row.create(null, cellNodes));
  });
  return nodes.table.create(null, rowNodes);
}
