import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Slice, type Node } from "prosemirror-model";

// Writing assists (the host's AI panel): the editor's half is capturing what an assist acts on
// — the selection, or the whole note — and later putting the result back. A captured range is a
// "target": it follows edits made while the model works (so a reply lands where it belongs even
// if the reader kept typing), is highlighted until released, and can be replaced or have the
// result inserted beside it. The host owns the model call; this file never talks to one.

/** Marks the insertion point in the document sent with a generate request. Mirrors
 *  aiCursorMarker in core/bridge/ai_tasks.go. */
export const AI_CURSOR_MARKER = "⟦CURSOR⟧";

/** What an assist acts on, as captured by {@link EditorHandle.aiCapture}. */
export interface AiTarget {
  /** Handle for {@link EditorHandle.aiApply} / {@link EditorHandle.aiRelease}. */
  id: number;
  /** True when the reader had text selected; false means the whole note. */
  selection: boolean;
  /** The markdown the assist acts on: the selection, or the whole note. */
  markdown: string;
  /** The whole note for context. Without a selection it carries {@link AI_CURSOR_MARKER} where
   *  the cursor was, so generated text can fit in around it. */
  document: string;
}

/** Where a result goes: `replace` swaps the target (selection or whole note); `insertAfter` /
 *  `insertBefore` add it as blocks after / before the target (the note's end / start when the
 *  target is the whole note); `cursor` inserts it at the cursor (the selection, when there was
 *  one, is replaced). */
export type AiApplyMode = "replace" | "insertAfter" | "insertBefore" | "cursor";

interface TrackedTarget {
  from: number;
  to: number;
  /** The caret when captured (== from/to for a selection). */
  cursor: number;
  selection: boolean;
}

type Meta = { add: { id: number; target: TrackedTarget } } | { remove: number };

const key = new PluginKey<Map<number, TrackedTarget>>("aiTargets");

/** Tracks captured targets through every transaction and decorates them: a highlight over a
 *  selection, a caret marker where generated text will land. */
export function aiTargetsPlugin(): Plugin {
  return new Plugin<Map<number, TrackedTarget>>({
    key,
    state: {
      init: () => new Map(),
      apply(tr, prev) {
        const meta = tr.getMeta(key) as Meta | undefined;
        if (!tr.docChanged && !meta) return prev;
        const next = new Map<number, TrackedTarget>();
        prev.forEach((t, id) => {
          if (!tr.docChanged) return next.set(id, t);
          if (!t.selection) {
            // The whole note: the range is always the document; only the caret moves.
            const size = tr.doc.content.size;
            return next.set(id, { ...t, from: 0, to: size, cursor: tr.mapping.map(t.cursor, 1) });
          }
          // Text typed at either edge stays outside the range.
          const from = tr.mapping.map(t.from, 1);
          const to = Math.max(from, tr.mapping.map(t.to, -1));
          next.set(id, { ...t, from, to, cursor: from });
        });
        if (meta && "add" in meta) next.set(meta.add.id, meta.add.target);
        if (meta && "remove" in meta) next.delete(meta.remove);
        return next;
      },
    },
    props: {
      decorations(state) {
        const targets = key.getState(state);
        if (!targets?.size) return null;
        const decos: Decoration[] = [];
        targets.forEach((t) => {
          if (t.selection && t.to > t.from) decos.push(Decoration.inline(t.from, t.to, { class: "pm-ai-target" }));
          else if (!t.selection)
            decos.push(
              Decoration.widget(t.cursor, () => {
                const el = document.createElement("span");
                el.className = "pm-ai-caret";
                el.setAttribute("aria-hidden", "true");
                return el;
              }, { side: 1, key: "ai-caret" }),
            );
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

/** Everything the editor instance supplies to capture and apply. */
export interface AiCodec {
  parse(md: string): Node | undefined;
  serialize(doc: Node): string;
}

let nextId = 0;

/** Capture the current selection (or the whole note) as a target; returns the transaction that
 *  registers it and the target for the host. */
export function captureAiTarget(state: EditorState, codec: AiCodec): { tr: Transaction; target: AiTarget } {
  const { selection, doc } = state;
  const hasSelection = !selection.empty && doc.textBetween(selection.from, selection.to, "\n", "\n").trim() !== "";
  const id = ++nextId;
  const tracked: TrackedTarget = hasSelection
    ? { from: selection.from, to: selection.to, cursor: selection.from, selection: true }
    : { from: 0, to: doc.content.size, cursor: selection.head, selection: false };

  const whole = codec.serialize(doc);
  let document = whole;
  if (!hasSelection) {
    // The whole note, with the caret marked. Built on a throwaway transaction, so the real
    // document is never touched.
    try {
      document = codec.serialize(state.tr.insertText(AI_CURSOR_MARKER, selection.head).doc);
    } catch {
      document = whole;
    }
  }
  const markdown = hasSelection ? codec.serialize(doc.cut(selection.from, selection.to)) : whole;
  const tr = state.tr.setMeta(key, { add: { id, target: tracked } } satisfies Meta).setMeta("addToHistory", false);
  return { tr, target: { id, selection: hasSelection, markdown, document } };
}

export function releaseAiTarget(state: EditorState, id: number): Transaction | null {
  if (!key.getState(state)?.has(id)) return null;
  return state.tr.setMeta(key, { remove: id } satisfies Meta).setMeta("addToHistory", false);
}

/** Build the transaction that puts `markdown` into the note for a target, or null when the
 *  target is gone or the markdown parses to nothing. It is an ordinary, undoable edit. */
export function applyAiResult(
  state: EditorState,
  id: number,
  mode: AiApplyMode,
  markdown: string,
  codec: AiCodec,
): Transaction | null {
  const t = key.getState(state)?.get(id);
  if (!t) return null;
  const parsed = codec.parse(markdown.trim());
  if (!parsed || parsed.content.size === 0) return null;
  const content = parsed.content;
  const { doc } = state;
  const tr = state.tr;

  // A block boundary at the top level just past / before a position.
  const blockAfter = (pos: number) => {
    const $pos = doc.resolve(pos);
    return $pos.depth === 0 ? pos : $pos.after(1);
  };
  const blockBefore = (pos: number) => {
    const $pos = doc.resolve(pos);
    return $pos.depth === 0 ? pos : $pos.before(1);
  };

  let end: number;
  if (mode === "replace" && !t.selection) {
    tr.replaceWith(0, doc.content.size, content);
    end = tr.doc.content.size;
  } else if (mode === "cursor" && !t.selection && besideBlock(doc, t.cursor) !== null) {
    // The caret sits at the end (or start) of a block with text: the result is new blocks of
    // its own after (or before) it, not a run-on of that block's last sentence.
    const at = besideBlock(doc, t.cursor)!;
    tr.insert(at, content);
    end = at + content.size;
  } else if (mode === "replace" || mode === "cursor") {
    // Paste-like: open the result as deeply as it goes, so a single paragraph flows into the
    // text around it and blocks split the surrounding block where needed.
    const from = t.selection ? t.from : t.cursor;
    const to = t.selection ? t.to : t.cursor;
    tr.replaceRange(from, to, Slice.maxOpen(content));
    end = tr.mapping.map(to, 1);
  } else {
    const at = mode === "insertAfter" ? blockAfter(t.selection ? t.to : doc.content.size) : blockBefore(t.selection ? t.from : 0);
    tr.insert(at, content);
    end = at + content.size;
  }
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
  } catch {
    /* leave the selection where the mapping put it */
  }
  return tr.scrollIntoView();
}

// The position just after (or before) the textblock holding `pos`, when `pos` is at its end (or
// start) and the block has text; else null (mid-text, or an empty block the result can fill).
function besideBlock(doc: Node, pos: number): number | null {
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if ($pos.depth === 0 || !block.isTextblock || block.content.size === 0) return null;
  if ($pos.parentOffset === block.content.size) return $pos.after();
  if ($pos.parentOffset === 0) return $pos.before();
  return null;
}
