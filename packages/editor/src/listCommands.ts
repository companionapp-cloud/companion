import { Fragment, Slice, NodeRange, type NodeType, type Attrs, type Node } from "prosemirror-model";
import { Selection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { canSplit, canJoin, liftTarget, ReplaceAroundStep } from "prosemirror-transform";

// The list-editing commands prosemirror-schema-list provides — ported here (that package
// isn't a dependency, matching how inputrules.ts reimplements prosemirror-inputrules). The
// bare editor only ran baseKeymap, whose Enter splits the paragraph *inside* a list item;
// these make Enter split the item, Enter on an empty item leave the list, and Tab / Shift-Tab
// nest / un-nest. Ported faithfully from prosemirror-schema-list so nested lists behave.

type Dispatch = ((tr: Transaction) => void) | undefined;

/** Enter inside a list item: split it into a new item (or, in an empty nested item, split
 * the wrapping item). `itemAttrs`, when given, is applied to the new item. */
export function splitListItem(itemType: NodeType, itemAttrs?: Attrs): Command {
  return function (state: EditorState, dispatch?: Dispatch) {
    const sel = state.selection as typeof state.selection & { node?: Node };
    const { $from, $to } = sel;
    const node = sel.node;
    if ((node && node.isBlock) || $from.depth < 2 || !$from.sameParent($to)) return false;
    const grandParent = $from.node(-1);
    if (grandParent.type != itemType) return false;
    if ($from.parent.content.size == 0 && $from.node(-1).childCount == $from.indexAfter(-1)) {
      // In an empty block. If this is a nested list, split the wrapping list item; otherwise
      // bail so the next command (leave-list) can handle it.
      if ($from.depth == 3 || $from.node(-3).type != itemType || $from.index(-2) != $from.node(-2).childCount - 1)
        return false;
      if (dispatch) {
        let wrap = Fragment.empty;
        const depthBefore = $from.index(-1) ? 1 : $from.index(-2) ? 2 : 3;
        // Build a fragment of empty versions of the structure from the outer list item down.
        for (let d = $from.depth - depthBefore; d >= $from.depth - 3; d--) wrap = Fragment.from($from.node(d).copy(wrap));
        const depthAfter =
          $from.indexAfter(-1) < $from.node(-2).childCount ? 1 : $from.indexAfter(-2) < $from.node(-3).childCount ? 2 : 3;
        wrap = wrap.append(Fragment.from(itemType.createAndFill()!));
        const start = $from.before($from.depth - (depthBefore - 1));
        const tr = state.tr.replace(start, $from.after(-depthAfter), new Slice(wrap, 4 - depthBefore, 0));
        let selPos = -1;
        tr.doc.nodesBetween(start, tr.doc.content.size, (n, pos) => {
          if (selPos > -1) return false;
          if (n.isTextblock && n.content.size == 0) selPos = pos + 1;
          return undefined;
        });
        if (selPos > -1) tr.setSelection(Selection.near(tr.doc.resolve(selPos)));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    const nextType = $to.pos == $from.end() ? grandParent.contentMatchAt(0).defaultType : null;
    const tr = state.tr.delete($from.pos, $to.pos);
    const types = nextType
      ? [itemAttrs ? { type: itemType, attrs: itemAttrs } : null, { type: nextType }]
      : undefined;
    if (!canSplit(tr.doc, $from.pos, 2, types)) return false;
    if (dispatch) dispatch(tr.split($from.pos, 2, types).scrollIntoView());
    return true;
  };
}

/** Split that keeps plain bullets plain but starts a new todo *unchecked* — pressing Enter
 * on `- [x] done` gives you a fresh `- [ ]`, not another checked item. */
export function splitListItemKeepingType(itemType: NodeType): Command {
  const splitTodo = splitListItem(itemType, { checked: false });
  const splitPlain = splitListItem(itemType);
  return (state, dispatch) => {
    const isTask = state.selection.$from.node(-1)?.type == itemType && state.selection.$from.node(-1).attrs.checked !== null;
    return (isTask ? splitTodo : splitPlain)(state, dispatch);
  };
}

/** Tab: nest the current list item under the previous one. */
export function sinkListItem(itemType: NodeType): Command {
  return function (state: EditorState, dispatch?: Dispatch) {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to, (n) => n.childCount > 0 && n.firstChild!.type == itemType);
    if (!range) return false;
    const startIndex = range.startIndex;
    if (startIndex == 0) return false;
    const parent = range.parent,
      nodeBefore = parent.child(startIndex - 1);
    if (nodeBefore.type != itemType) return false;
    if (dispatch) {
      const nestedBefore = nodeBefore.lastChild && nodeBefore.lastChild.type == parent.type;
      const inner = Fragment.from(nestedBefore ? itemType.create() : null);
      const slice = new Slice(
        Fragment.from(itemType.create(null, Fragment.from(parent.type.create(null, inner)))),
        nestedBefore ? 3 : 1,
        0,
      );
      const before = range.start,
        after = range.end;
      dispatch(
        state.tr
          .step(new ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true))
          .scrollIntoView(),
      );
    }
    return true;
  };
}

/** Shift-Tab (and Enter on an empty item): lift the current item out one level of nesting,
 * or out of the list entirely. */
export function liftListItem(itemType: NodeType): Command {
  return function (state: EditorState, dispatch?: Dispatch) {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to, (n) => n.childCount > 0 && n.firstChild!.type == itemType);
    if (!range) return false;
    if (!dispatch) return true;
    if ($from.node(range.depth - 1).type == itemType) return liftToOuterList(state, dispatch, itemType, range);
    return liftOutOfList(state, dispatch, range);
  };
}

function liftToOuterList(state: EditorState, dispatch: (tr: Transaction) => void, itemType: NodeType, range: NodeRange) {
  const tr = state.tr,
    end = range.end,
    endOfList = range.$to.end(range.depth);
  if (end < endOfList) {
    // Siblings after the lifted items must become children of the last lifted item.
    tr.step(
      new ReplaceAroundStep(
        end - 1,
        endOfList,
        end,
        endOfList,
        new Slice(Fragment.from(itemType.create(null, range.parent.copy())), 1, 0),
        1,
        true,
      ),
    );
    range = new NodeRange(tr.doc.resolve(range.$from.pos), tr.doc.resolve(endOfList), range.depth);
  }
  const target = liftTarget(range);
  if (target == null) return false;
  tr.lift(range, target);
  const after = tr.mapping.map(end, -1) - 1;
  if (canJoin(tr.doc, after)) tr.join(after);
  dispatch(tr.scrollIntoView());
  return true;
}

function liftOutOfList(state: EditorState, dispatch: (tr: Transaction) => void, range: NodeRange) {
  const tr = state.tr,
    list = range.parent;
  // Merge the list items into a single big item.
  for (let pos = range.end, i = range.endIndex - 1, e = range.startIndex; i > e; i--) {
    pos -= list.child(i).nodeSize;
    tr.delete(pos - 1, pos + 1);
  }
  const $start = tr.doc.resolve(range.start),
    item = $start.nodeAfter!;
  if (tr.mapping.map(range.end) != range.start + $start.nodeAfter!.nodeSize) return false;
  const atStart = range.startIndex == 0,
    atEnd = range.endIndex == list.childCount;
  const parent = $start.node(-1),
    indexBefore = $start.index(-1);
  if (
    !parent.canReplace(
      indexBefore + (atStart ? 0 : 1),
      indexBefore + 1,
      item.content.append(atEnd ? Fragment.empty : Fragment.from(list)),
    )
  )
    return false;
  const start = $start.index(-1);
  // Strip off the surrounding list. Where we're not at an end, keep a wrapping list.
  tr.step(
    new ReplaceAroundStep(
      start ? range.start - 1 : range.start,
      atEnd ? range.end + 1 : range.end,
      range.start + 1,
      range.end - 1,
      new Slice(
        (atStart ? Fragment.empty : Fragment.from(list.copy(Fragment.empty))).append(
          atEnd ? Fragment.empty : Fragment.from(list.copy(Fragment.empty)),
        ),
        atStart ? 0 : 1,
        atEnd ? 0 : 1,
      ),
      atStart ? 0 : 1,
    ),
  );
  dispatch(tr.scrollIntoView());
  return true;
}
