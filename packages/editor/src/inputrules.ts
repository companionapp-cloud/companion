import { Plugin } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { MarkType, NodeType, Attrs, Schema } from "prosemirror-model";
import { canJoin, findWrapping } from "prosemirror-transform";

// A small, dependency-free reimplementation of prosemirror-inputrules (that package
// isn't installed) plus the CommonMark block/inline rules the editor turns on as you
// type: markdown you'd write by hand becomes the real node/mark immediately, so what the
// serializer writes back stays clean markdown.

type Handler = (
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
) => Transaction | null;

export class InputRule {
  constructor(
    readonly match: RegExp,
    readonly handler: Handler,
  ) {}
}

const MAX_MATCH = 500;

type RuleMeta = { transform: Transaction; from: number; to: number; text: string } | null;

export function inputRules(rules: readonly InputRule[]): Plugin {
  // eslint-disable-next-line prefer-const
  let plugin: Plugin<RuleMeta>;

  function run(view: EditorView, from: number, to: number, text: string): boolean {
    if (view.composing) return false;
    const state = view.state;
    const $from = state.doc.resolve(from);
    if ($from.parent.type.spec.code) return false; // never reformat inside code blocks
    const textBefore =
      $from.parent.textBetween(
        Math.max(0, $from.parentOffset - MAX_MATCH),
        $from.parentOffset,
        undefined,
        "￼",
      ) + text;
    for (const rule of rules) {
      const match = rule.match.exec(textBefore);
      if (!match) continue;
      const tr = rule.handler(state, match, from - (match[0].length - text.length), to);
      if (!tr) continue;
      view.dispatch(tr.setMeta(plugin, { transform: tr, from, to, text }));
      return true;
    }
    return false;
  }

  plugin = new Plugin<RuleMeta>({
    state: {
      init() {
        return null;
      },
      apply(tr, prev) {
        const stored = tr.getMeta(plugin) as RuleMeta;
        if (stored) return stored;
        return tr.selectionSet || tr.docChanged ? null : prev;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        return run(view, from, to, text);
      },
      handleKeyDown(view, event) {
        // Backspace right after a rule fired undoes the transform (so "# " → heading is
        // recoverable to literal "# ").
        if (event.key !== "Backspace") return false;
        const undoable = plugin.getState(view.state);
        if (!undoable) return false;
        const tr = view.state.tr;
        const toUndo = undoable.transform;
        for (let i = toUndo.steps.length - 1; i >= 0; i--) {
          tr.step(toUndo.steps[i].invert(toUndo.docs[i]));
        }
        const marks = tr.doc.resolve(undoable.from).marks();
        view.dispatch(tr.replaceWith(undoable.from, undoable.to, view.state.schema.text(undoable.text, marks)));
        return true;
      },
    },
  });
  return plugin;
}

// --- Rule builders -------------------------------------------------------------------

/** Type a block from a leading token, e.g. "# " → heading. */
export function textblockTypeInputRule(
  regexp: RegExp,
  nodeType: NodeType,
  getAttrs?: Attrs | ((m: RegExpMatchArray) => Attrs | null) | null,
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const attrs = getAttrs instanceof Function ? getAttrs(match) : (getAttrs ?? null);
    if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType)) return null;
    return state.tr.delete(start, end).setBlockType(start, start, nodeType, attrs);
  });
}

/** Wrap a block from a leading token, e.g. "> " → blockquote, "- " → bullet list. */
export function wrappingInputRule(
  regexp: RegExp,
  nodeType: NodeType,
  getAttrs?: Attrs | ((m: RegExpMatchArray) => Attrs | null) | null,
  joinPredicate?: (m: RegExpMatchArray, node: import("prosemirror-model").Node) => boolean,
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const attrs = getAttrs instanceof Function ? getAttrs(match) : (getAttrs ?? null);
    const tr = state.tr.delete(start, end);
    const $start = tr.doc.resolve(start);
    const range = $start.blockRange();
    const wrapping = range && findWrapping(range, nodeType, attrs);
    if (!wrapping) return null;
    tr.wrap(range!, wrapping);
    const before = tr.doc.resolve(start - 1).nodeBefore;
    if (
      before &&
      before.type === nodeType &&
      canJoin(tr.doc, start - 1) &&
      (!joinPredicate || joinPredicate(match, before))
    ) {
      tr.join(start - 1);
    }
    return tr;
  });
}

/** Apply an inline mark once its closing delimiter is typed, e.g. "**bold**" → strong.
 * The inner text is the last capture group. */
export function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const inner = match[match.length - 1];
    if (inner == null) return null;
    const $start = state.doc.resolve(start);
    if (!$start.parent.type.allowsMarkType(markType)) return null;
    const full = match[0];
    const textStart = start + full.indexOf(inner);
    const textEnd = textStart + inner.length;
    const tr = state.tr;
    if (textEnd < end) tr.delete(textEnd, end);
    if (textStart > start) tr.delete(start, textStart);
    tr.addMark(start, start + inner.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

// --- The CommonMark rule set ---------------------------------------------------------

export function commonmarkInputRules(schema: Schema): Plugin {
  const rules: InputRule[] = [];
  const { nodes, marks } = schema;

  // Headings: "# " … "###### ".
  if (nodes.heading) {
    rules.push(
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
    );
  }
  // Blockquote: "> ".
  if (nodes.blockquote) rules.push(wrappingInputRule(/^\s*>\s$/, nodes.blockquote));
  // Fenced code block: "```".
  if (nodes.code_block) rules.push(textblockTypeInputRule(/^```$/, nodes.code_block));
  // Bullet list: "- ", "* ", or "+ ".
  if (nodes.bullet_list) rules.push(wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list));
  // Ordered list: "1. " (continue the surrounding list's numbering when joining).
  if (nodes.ordered_list) {
    rules.push(
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (m) => ({ order: Number(m[1]) }),
        (m, node) => node.childCount + node.attrs.order === Number(m[1]),
      ),
    );
  }
  // Horizontal rule: "---", "***", or "___".
  if (nodes.horizontal_rule) {
    rules.push(
      new InputRule(/^(?:---|\*\*\*|___)$/, (state, _m, start, end) => {
        const tr = state.tr.replaceRangeWith(start, end, nodes.horizontal_rule.create());
        return tr;
      }),
    );
  }

  // Inline emphasis and code. Underscore emphasis is left to load-time parsing to avoid
  // reformatting intraword underscores (snake_case), which CommonMark doesn't emphasize.
  if (marks.strong) rules.push(markInputRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong));
  if (marks.em) rules.push(markInputRule(/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em));
  if (marks.code) rules.push(markInputRule(/`([^`]+)`$/, marks.code));

  return inputRules(rules);
}
