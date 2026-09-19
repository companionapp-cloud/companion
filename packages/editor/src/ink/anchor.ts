import type { Node } from "prosemirror-model";
import type { InkAnchor } from "./types";

// Anchoring ink to text (PLAN-drawing.md). A group is pinned to a point in the note's text,
// stored as the text on either side of it. On load the point is found again by matching that
// text, so the group follows its words through edits made anywhere (another device, the AI,
// an import) and through different screen widths. While the note is open, ProseMirror's
// position mapping keeps the point exact, and the stored text is refreshed after edits.

/** How much text is kept on each side of an anchor. */
export const ANCHOR_CONTEXT = 24;

/** The note's text as one string, with a map back to document positions. Blocks are joined by
 *  "\n"; inline atoms (link chips, hard breaks) stand in as one character each. */
export interface TextIndex {
  text: string;
  /** The document position of a text offset. */
  posAt(offset: number): number;
  /** The text offset of a document position (the nearest one when the position sits between
   *  blocks). */
  offsetAt(pos: number): number;
}

interface Segment {
  /** Offset of the segment's first character in `text`. */
  t: number;
  /** Document position of that character. */
  p: number;
  /** Length in characters (0 marks the start of an empty textblock). */
  n: number;
}

export function buildTextIndex(doc: Node): TextIndex {
  let text = "";
  const segs: Segment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      segs.push({ t: text.length, p: pos, n: node.text!.length });
      text += node.text!;
      return false;
    }
    if (node.isInline && node.isLeaf) {
      segs.push({ t: text.length, p: pos, n: 1 });
      text += node.type.name === "hard_break" ? "\n" : "￼";
      return false;
    }
    if (node.isTextblock) {
      if (text.length > 0) text += "\n";
      // An empty paragraph still needs an address, so anchors can sit in one.
      segs.push({ t: text.length, p: pos + 1, n: 0 });
    }
    return true;
  });
  const maxPos = doc.content.size;

  const posAt = (offset: number): number => {
    if (segs.length === 0) return Math.min(1, maxPos);
    const o = Math.max(0, Math.min(offset, text.length));
    // The last segment starting at or before `o` (segments are in document order).
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].t <= o) lo = mid;
      else hi = mid - 1;
    }
    let s = segs[lo];
    // Prefer a segment with text over an empty-block marker at the same offset.
    while (lo + 1 < segs.length && segs[lo + 1].t === o && s.n === 0) s = segs[++lo];
    return Math.min(maxPos, s.p + Math.min(o - s.t, s.n));
  };

  const offsetAt = (pos: number): number => {
    if (segs.length === 0) return 0;
    let lo = 0;
    let hi = segs.length - 1;
    if (pos < segs[0].p) return segs[0].t;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].p <= pos) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.t + Math.min(pos - s.p, s.n);
  };

  return { text, posAt, offsetAt };
}

/** The anchor for a text offset: the text on either side of it, and the offset itself. */
export function snapshotAnchor(index: TextIndex, offset: number, free = false): InkAnchor {
  const o = Math.max(0, Math.min(offset, index.text.length));
  const anchor: InkAnchor = {
    before: index.text.slice(Math.max(0, o - ANCHOR_CONTEXT), o),
    after: index.text.slice(o, o + ANCHOR_CONTEXT),
    offset: o,
  };
  if (free) anchor.free = true;
  return anchor;
}

/** Every start index of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function nearest(candidates: number[], hint: number): number {
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - hint) < Math.abs(best - hint)) best = c;
  return best;
}

/** How an anchor was found: exactly as written; partly (the text around it changed, so the
 *  caller re-pins it to the new text); or not at all (its text is gone — placed near its old
 *  offset, and kept as written in case the text comes back, e.g. on undo). */
export type AnchorMatch = "exact" | "partial" | "lost";

/** Find an anchor's point in the current text. */
export function resolveAnchor(index: TextIndex, anchor: InkAnchor): { offset: number; match: AnchorMatch } {
  const { text } = index;
  const { before, after, offset: hint } = anchor;
  const near = Math.max(0, Math.min(hint, text.length));

  // Drawn on an empty note: exact while it stays empty, then pinned to the text that arrives.
  if (!before && !after) return { offset: near, match: text.length === 0 ? "exact" : "partial" };

  // 1. The full context, as written. Repeated passages resolve to the one nearest the hint.
  const full = occurrences(text, before + after);
  if (full.length) return { offset: nearest(full, hint) + before.length, match: "exact" };

  // 2. One side survived the edit intact.
  const tries: { needle: string; shift: number }[] = [];
  if (after.length >= 4) tries.push({ needle: after, shift: 0 });
  if (before.length >= 4) tries.push({ needle: before, shift: before.length });
  // 3. Shorter windows hugging the point: an edit a few characters away is still found.
  for (const k of [12, 6]) {
    const b = before.slice(-k);
    const a = after.slice(0, k);
    if (b.length + a.length >= 6) tries.push({ needle: b + a, shift: b.length });
    if (a.length >= 4) tries.push({ needle: a, shift: 0 });
    if (b.length >= 4) tries.push({ needle: b, shift: b.length });
  }
  // Longest needles first; the first one found wins, at its hit nearest the hint.
  for (const { needle, shift } of tries) {
    const hits = occurrences(text, needle).map((i) => i + shift);
    if (hits.length) return { offset: nearest(hits, hint), match: "partial" };
  }

  // 4. The text is gone: stay near where it was.
  return { offset: near, match: "lost" };
}
