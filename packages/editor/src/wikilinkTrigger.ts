import { PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

// Shared `[[` trigger detection used by both autocomplete presenters: the web DOM popup
// (autocomplete.ts) and the native host bridge (hostAutocomplete.ts). Only one presenter
// is installed per editor, so they can share a single plugin key.

export interface Trigger {
  from: number;
  to: number;
  query: string;
  embed: boolean;
}

export const triggerKey = new PluginKey<Trigger | null>("wikilinkTrigger");

// Detect an active, unclosed `[[` (or `![[` for an embed) at the empty selection. Returns
// the doc range covering `[[query` so it can be replaced when a target is chosen.
export function detectTrigger(state: EditorState): Trigger | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const to = $from.pos;
  const start = $from.start();
  const before = state.doc.textBetween(start, to, "￼", "￼");
  const m = /(!?)\[\[([^[\]\n]*)$/.exec(before);
  if (!m) return null;
  return { from: to - m[0].length, to, embed: m[1] === "!", query: m[2] };
}
