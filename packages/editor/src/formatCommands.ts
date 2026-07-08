import type { Schema, MarkType, NodeType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { toggleMark, setBlockType, wrapIn, lift } from "prosemirror-commands";
import { wrapInList, liftListItem } from "./listCommands";

// The formatting actions the toolbar exposes. The host UI (web selection bar / native
// keyboard toolbar) drives these through EditorHandle.format and reflects their active /
// enabled state from computeFormatState. `insertReference` is handled separately (it opens
// the `[[` picker), so it's not in this set.
export type FormatName =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeBlock"
  | "blockquote"
  | "bulletList"
  | "orderedList";

export const FORMAT_NAMES: FormatName[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "codeBlock",
  "blockquote",
  "bulletList",
  "orderedList",
];

/** A snapshot the host toolbar renders from: whether text is selected, which actions are
 * currently applied, and which are available given the selection. */
export interface FormatState {
  /** The selection spans some content (the web bar only shows on a non-empty selection). */
  hasSelection: boolean;
  active: Record<FormatName, boolean>;
  enabled: Record<FormatName, boolean>;
}

// Toggle a block between a type and paragraph — used for the code-block button, which turns
// the current block into a code block or back into a plain paragraph.
function toggleBlockType(type: NodeType, fallback: NodeType): Command {
  return (state, dispatch) => {
    if (blockTypeActive(state, type)) return setBlockType(fallback)(state, dispatch);
    return setBlockType(type)(state, dispatch);
  };
}

// Toggle a wrapping block (blockquote): wrap the selection, or lift it back out if already
// inside one.
function toggleWrap(type: NodeType): Command {
  return (state, dispatch) => {
    if (ancestorActive(state, type)) return lift(state, dispatch);
    return wrapIn(type)(state, dispatch);
  };
}

// Toggle a list: leave the list if already in one of this type, convert if in the other
// list type, else wrap the selection in a fresh list.
function toggleList(listType: NodeType, itemType: NodeType, otherList: NodeType): Command {
  return (state, dispatch) => {
    const $from = state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === listType) return liftListItem(itemType)(state, dispatch);
      if (node.type === otherList) {
        if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(d), listType));
        return true;
      }
    }
    return wrapInList(listType)(state, dispatch);
  };
}

/** Build the toggle command for each formatting action against the full document schema. */
export function buildFormatCommands(schema: Schema): Record<FormatName, Command> {
  const { strong, em, code, strikethrough } = schema.marks;
  const { code_block, blockquote, bullet_list, ordered_list, list_item, paragraph } = schema.nodes;
  return {
    bold: toggleMark(strong),
    italic: toggleMark(em),
    strike: toggleMark(strikethrough),
    code: toggleMark(code),
    codeBlock: toggleBlockType(code_block, paragraph),
    blockquote: toggleWrap(blockquote),
    bulletList: toggleList(bullet_list, list_item, ordered_list),
    orderedList: toggleList(ordered_list, list_item, bullet_list),
  };
}

// --- active-state probes --------------------------------------------------------------

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

// The selection's textblock is (entirely) of this type — used for code blocks.
function blockTypeActive(state: EditorState, type: NodeType): boolean {
  const { $from, to } = state.selection;
  return to <= $from.end() && $from.parent.type === type;
}

// Some ancestor of the selection head is of this type — used for blockquotes and lists.
function ancestorActive(state: EditorState, type: NodeType): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

/** Compute the toolbar snapshot for the current selection. `commands` is the map from
 * {@link buildFormatCommands}; each is run without a dispatch to test availability. */
export function computeFormatState(
  state: EditorState,
  commands: Record<FormatName, Command>,
  schema: Schema,
): FormatState {
  const { strong, em, code, strikethrough } = schema.marks;
  const { code_block, blockquote, bullet_list, ordered_list } = schema.nodes;
  const active: Record<FormatName, boolean> = {
    bold: markActive(state, strong),
    italic: markActive(state, em),
    strike: markActive(state, strikethrough),
    code: markActive(state, code),
    codeBlock: blockTypeActive(state, code_block),
    blockquote: ancestorActive(state, blockquote),
    bulletList: ancestorActive(state, bullet_list),
    orderedList: ancestorActive(state, ordered_list),
  };
  const enabled = {} as Record<FormatName, boolean>;
  for (const name of FORMAT_NAMES) enabled[name] = commands[name](state);
  return { hasSelection: !state.selection.empty, active, enabled };
}
