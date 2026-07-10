import type { Command, EditorState } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { DOMSerializer, Fragment } from "prosemirror-model";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  isInTable,
  selectedRect,
  TableMap,
} from "prosemirror-tables";
import { schema, serializer } from "./wikilink";
import { cellRenderer, tableToMarkdown, type ColumnAlign } from "./tables";

// Table menu commands and the menu model. All three platforms (web HTML popup, desktop Wails
// menu, iOS native menu) share this: the model is a tree of items with stable ids + enabled/
// checked flags, and `run(id)` executes the matching command. Presentation is the only thing
// that differs per platform (see tableMenu.ts). Commands are anchored to a specific cell (the
// one the menu was opened over), not the live selection, so they behave the same regardless of
// where the caret is when the user finally picks an item.

// ---------------------------------------------------------------------------
// Clipboard: copy the whole table as markdown / HTML / CSV. `clipboard` is the host writer
// (iOS routes through expo-clipboard; web/desktop fall back to navigator.clipboard).
// ---------------------------------------------------------------------------

export type ClipboardWriter = (text: string) => void;

function writeClipboard(text: string, clipboard?: ClipboardWriter): void {
  if (clipboard) {
    clipboard(text);
    return;
  }
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}

function tableMarkdown(table: Node): string {
  const s = serializer as unknown as { nodes: unknown; marks: unknown };
  return tableToMarkdown(table, cellRenderer(s.nodes, s.marks, {}));
}

function tableHtml(table: Node): string {
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(table));
  const holder = document.createElement("div");
  holder.appendChild(dom);
  return holder.innerHTML;
}

function csvCell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableCsv(table: Node): string {
  const lines: string[] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(csvCell(cell.textContent)));
    lines.push(cells.join(","));
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cell resolution: find the table/row/col for an in-cell document position. Used to compute
// the menu model (enabled/checked) without touching the selection.
// ---------------------------------------------------------------------------

interface CellInfo {
  table: Node;
  tableStart: number; // position just inside the table node
  map: TableMap;
  row: number;
  col: number;
}

function resolveCell(state: EditorState, insidePos: number): CellInfo | null {
  const $pos = state.doc.resolve(insidePos);
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") {
      const table = $pos.node(d - 2);
      if (!table || table.type.spec.tableRole !== "table") return null;
      const tableStart = $pos.start(d - 2);
      const map = TableMap.get(table);
      const rect = map.findCell($pos.before(d) - tableStart);
      return { table, tableStart, map, row: rect.top, col: rect.left };
    }
  }
  return null;
}

/** Run `cmd` as if the caret sat inside the given cell. setSelection doesn't change the doc,
 * so the command's transaction (built on the same doc) is valid to dispatch to the live view. */
function withCell(insidePos: number, cmd: Command): Command {
  return (state, dispatch, view) => {
    let target = insidePos;
    if (target > state.doc.content.size) return false;
    const selState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, target)));
    return cmd(selState, dispatch, view);
  };
}

// ---------------------------------------------------------------------------
// Custom structural commands (prosemirror-tables has no move/align).
// ---------------------------------------------------------------------------

function replaceTable(state: EditorState, rect: { table: Node; tableStart: number }, rows: Node[]) {
  const newTable = rect.table.type.create(rect.table.attrs, rows);
  const from = rect.tableStart - 1;
  return { tr: state.tr.replaceWith(from, from + rect.table.nodeSize, newTable), newTable };
}

// Cursor back into the cell at (row,col) of a freshly built table.
function selectCell(tr: ReturnType<EditorState["tr"]["setSelection"]>, tableStart: number, table: Node, row: number, col: number) {
  const map = TableMap.get(table);
  const pos = tableStart + map.positionAt(row, col, table);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
}

// Move the current row up/down. The header (row 0) is fixed and body rows never cross it.
function moveRow(dir: 1 | -1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const from = rect.top;
    const to = from + dir;
    if (from === 0 || to === 0 || to < 0 || to >= rect.table.childCount) return false;
    if (dispatch) {
      const rows: Node[] = [];
      rect.table.forEach((r) => rows.push(r));
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      const { tr, newTable } = replaceTable(state, rect, rows);
      selectCell(tr, rect.tableStart, newTable, to, rect.left);
      dispatch(tr);
    }
    return true;
  };
}

// Move the current column left/right (swap the cell at every row — GFM has no colspans).
function moveColumn(dir: 1 | -1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const from = rect.left;
    const to = from + dir;
    if (to < 0 || to >= rect.map.width) return false;
    if (dispatch) {
      const rows: Node[] = [];
      rect.table.forEach((r) => {
        const cells: Node[] = [];
        r.forEach((c) => cells.push(c));
        [cells[from], cells[to]] = [cells[to], cells[from]];
        rows.push(r.type.create(r.attrs, cells));
      });
      const { tr, newTable } = replaceTable(state, rect, rows);
      selectCell(tr, rect.tableStart, newTable, rect.top, to);
      dispatch(tr);
    }
    return true;
  };
}

// Set the alignment of every cell in the current column (targeted setNodeMarkup keeps the caret).
function setColumnAlign(align: ColumnAlign): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (dispatch) {
      const tr = state.tr;
      const seen = new Set<number>();
      for (let row = 0; row < rect.map.height; row++) {
        const rel = rect.map.map[row * rect.map.width + rect.left];
        if (seen.has(rel)) continue;
        seen.add(rel);
        const pos = rect.tableStart + rel;
        const cell = tr.doc.nodeAt(pos);
        if (cell) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
      }
      dispatch(tr);
    }
    return true;
  };
}

// Copy commands are side effects (no doc change): they return true and write the clipboard.
function copyTable(format: "md" | "html" | "csv", clipboard?: ClipboardWriter): Command {
  return (state) => {
    if (!isInTable(state)) return false;
    const table = selectedRect(state).table;
    const text = format === "md" ? tableMarkdown(table) : format === "html" ? tableHtml(table) : tableCsv(table);
    writeClipboard(text, clipboard);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Menu model. Ids are stable and shared with the desktop Wails menu (apps/desktop/table_menu.go)
// and the iOS native menu — keep them in sync there.
// ---------------------------------------------------------------------------

export interface TableMenuItem {
  id?: string; // action id (leaf); absent for separators and pure submenu parents
  label?: string;
  enabled?: boolean; // default true
  checked?: boolean; // align options reflect the column's current alignment
  separator?: boolean;
  children?: TableMenuItem[];
}

export interface TableMenuModel {
  items: TableMenuItem[];
  /** Execute an action by id. Returns false if the id is unknown / not applicable. */
  run(id: string): boolean;
}

export interface TableMenuOptions {
  /** Host clipboard writer for the copy actions (iOS). Web/desktop use navigator.clipboard. */
  clipboard?: ClipboardWriter;
}

/** Build the menu model + action registry for the cell at `insidePos` (a document position
 * inside the target cell). `exec` runs the chosen command against the live view (typically
 * `(cmd) => cmd(view.state, view.dispatch, view)`); copy actions are side effects. */
export function buildTableMenuModel(
  state: EditorState,
  insidePos: number,
  exec: (command: Command) => void,
  opts: TableMenuOptions = {},
): TableMenuModel | null {
  const info = resolveCell(state, insidePos);
  if (!info) return null;
  const { map, row, col, table } = info;

  const canRowUp = row > 1; // body rows only, never into/over the header
  const canRowDown = row >= 1 && row < map.height - 1;
  const canColLeft = col > 0;
  const canColRight = col < map.width - 1;
  const currentAlign = (table.child(0)?.child(col)?.attrs.align ?? null) as ColumnAlign;

  // id -> command factory, all anchored to this cell.
  const registry: Record<string, Command> = {
    "copy.md": copyTable("md", opts.clipboard),
    "copy.html": copyTable("html", opts.clipboard),
    "copy.csv": copyTable("csv", opts.clipboard),
    "align.left": withCell(insidePos, setColumnAlign("left")),
    "align.right": withCell(insidePos, setColumnAlign("right")),
    "align.center": withCell(insidePos, setColumnAlign("center")),
    "row.add.below": withCell(insidePos, addRowAfter),
    "row.add.above": withCell(insidePos, addRowBefore),
    "col.add.after": withCell(insidePos, addColumnAfter),
    "col.add.before": withCell(insidePos, addColumnBefore),
    "row.move.up": withCell(insidePos, moveRow(-1)),
    "row.move.down": withCell(insidePos, moveRow(1)),
    "col.move.left": withCell(insidePos, moveColumn(-1)),
    "col.move.right": withCell(insidePos, moveColumn(1)),
    "row.delete": withCell(insidePos, deleteRow),
    "col.delete": withCell(insidePos, deleteColumn),
  };

  const items: TableMenuItem[] = [
    {
      label: "Copy table as",
      children: [
        { id: "copy.md", label: "Markdown" },
        { id: "copy.html", label: "HTML" },
        { id: "copy.csv", label: "CSV" },
      ],
    },
    {
      label: "Align column",
      children: [
        { id: "align.left", label: "Left", checked: currentAlign === "left" },
        { id: "align.right", label: "Right", checked: currentAlign === "right" },
        { id: "align.center", label: "Center", checked: currentAlign === "center" },
      ],
    },
    { separator: true },
    { id: "row.add.below", label: "Add Row" },
    { id: "row.add.above", label: "Add Row Above" },
    { id: "col.add.after", label: "Add Column" },
    { id: "col.add.before", label: "Add Column Before" },
    { separator: true },
    { id: "row.move.up", label: "Move Row Up", enabled: canRowUp },
    { id: "row.move.down", label: "Move Row Down", enabled: canRowDown },
    { id: "col.move.left", label: "Move Column Left", enabled: canColLeft },
    { id: "col.move.right", label: "Move Column Right", enabled: canColRight },
    { separator: true },
    { id: "row.delete", label: "Delete Row" },
    { id: "col.delete", label: "Delete Column" },
  ];

  return {
    items,
    run(id) {
      const cmd = registry[id];
      if (!cmd) return false;
      exec(cmd);
      return true;
    },
  };
}
