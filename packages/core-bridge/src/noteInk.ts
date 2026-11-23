import type { CoreBridge, NoteInk } from "./types";

/** One ink group as the editor writes it: its id (the editor picks it) and its whole payload.
 *  Writing a deleted group's id again brings it back (an undone erase). */
export interface NoteInkInput {
  id: string;
  data: Record<string, unknown>;
}

/** Recognized handwriting: the text and the ink groups it was read from. */
export interface InkTranscript {
  groupIds: string[];
  text: string;
  confidence: number;
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
    /** Whether this device can read handwriting (the desktop app on a Mac, via Apple Vision). */
    canTranscribe: () => core.invoke<{ available: boolean }>("noteInk.canTranscribe", {}),
    /** Read the handwriting on a note as stored: what each piece of ink says. Changes nothing. */
    transcribe: (noteId: string, groupIds?: string[]) =>
      core.invoke<{ transcripts: InkTranscript[]; unread: string[] }>("noteInk.transcribe", { noteId, groupIds }),
  };
}

export type NoteInkApi = ReturnType<typeof noteInkApi>;
