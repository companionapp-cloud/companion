import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { parseWikilinkBody } from "./wikilink";

// "Empty" (unresolved) wikilinks. When a user closes a `[[…]]` without picking an
// autocomplete result, the text isn't a real `type:id` reference, so the input rule leaves
// it as literal `[[label]]` text and the core link index ignores it (no graph edge yet).
// This plugin styles that leftover text as a distinct chip-like decoration and lets a
// double-click activate it — the host then opens a quick-create UI (see createEditor's
// onQuickCreate) that turns the label into a real note/task and swaps in a resolved chip.

export interface EmptyLink {
  from: number;
  to: number;
  label: string;
}

// A closed `[[…]]` whose body has no brackets/newlines and — crucially — hasn't been
// collapsed to the atom placeholder (￼), so it can't straddle an existing chip.
const EMPTY_RE = /\[\[([^[\]\n￼]+)\]\]/g;

/** Find every raw, closed `[[label]]` that is *not* a real `type:id` link (those are already
 * atomic chips). Returns each occurrence's doc range and its trimmed label. */
export function findEmptyLinks(doc: Node): EmptyLink[] {
  const out: EmptyLink[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // A `[[` inside a code block is literal text, never a link (mirrors detectTrigger).
    if (node.type.spec.code) return false;
    const start = pos + 1;
    // Collapse inline atoms (chips) to a single placeholder char so offsets map 1:1 to
    // doc positions and a match can't span across a chip.
    const text = doc.textBetween(start, pos + node.nodeSize - 1, undefined, "￼");
    EMPTY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMPTY_RE.exec(text))) {
      if (parseWikilinkBody(m[1])) continue; // a real type:id link — leave it to the chip path
      const from = start + m.index;
      out.push({ from, to: from + m[0].length, label: m[1].trim() });
    }
    return false; // textblocks don't nest textblocks
  });
  return out;
}

export function emptyWikilinkPlugin(onActivate: (link: EmptyLink) => void): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const links = findEmptyLinks(state.doc);
        if (!links.length) return null;
        return DecorationSet.create(
          state.doc,
          links.map((l) => Decoration.inline(l.from, l.to, { class: "pm-wikilink-empty" })),
        );
      },
      handleDoubleClick(view, pos, event) {
        const hit = findEmptyLinks(view.state.doc).find((l) => pos >= l.from && pos <= l.to);
        if (!hit) return false;
        event.preventDefault();
        onActivate(hit);
        return true;
      },
    },
  });
}
