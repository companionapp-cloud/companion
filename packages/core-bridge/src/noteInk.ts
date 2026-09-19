import type { CoreBridge, NoteInk } from "./types";

/** One ink group as the editor writes it: its id (the editor picks it) and its whole payload.
 *  Writing a deleted group's id again brings it back (an undone erase). */
export interface NoteInkInput {
  id: string;
  data: Record<string, unknown>;
}

/** Typed wrappers over the noteInk.* core methods (PLAN-drawing.md). A note's ink is a set of
 *  groups, each its own synced row; writes are batched so one undo that touches several
 *  groups is one call. Local writes emit `noteInk.changed {noteId}`; pulled ink arrives with
 *  the bulk `data.changed` every sync emits. */
export function noteInkApi(core: CoreBridge) {
  return {
    /** A note's live groups, in the order they were drawn. */
    list: (noteId: string) => core.invoke<NoteInk[]>("noteInk.list", { noteId }),
    upsert: (noteId: string, groups: NoteInkInput[]) => core.invoke<NoteInk[]>("noteInk.upsert", { noteId, groups }),
    remove: (noteId: string, ids: string[]) => core.invoke<{ count: number }>("noteInk.delete", { noteId, ids }),
  };
}

export type NoteInkApi = ReturnType<typeof noteInkApi>;
