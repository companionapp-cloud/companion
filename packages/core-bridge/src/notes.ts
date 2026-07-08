import type { CoreBridge, Note, ObjectProps } from "./types";

export interface CreateNoteInput {
  title: string;
  contentMd?: string;
  date?: string | null;
  /** Archetype the note (PLAN §6.3): an object type id plus its schema-validated props. */
  objectTypeId?: string | null;
  props?: ObjectProps;
}

export interface UpdateNoteInput {
  title?: string;
  contentMd?: string;
  date?: string | null;
  objectTypeId?: string | null;
  /** Remove the archetype (JSON can't distinguish absent from null on a pointer). */
  clearObjectType?: boolean;
  props?: ObjectProps;
}

/** A conflicting server version stashed for a note the UI holds open (PLAN §7.3 / editor
 *  sync UX). `deleted` distinguishes a remote edit from a remote delete. */
export interface NoteConflict {
  id: string;
  deleted: boolean;
}

/** How the user chose to resolve a held-note conflict: adopt the server version (discard
 *  local edits / accept the delete) or restore a remotely-deleted note. */
export type NoteConflictAction = "adopt" | "restore";

/** Typed wrappers over the notes.* core methods. */
export function notesApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Note[]>("notes.list"),
    get: (id: string) => core.invoke<Note>("notes.get", { id }),
    create: (input: CreateNoteInput) => core.invoke<Note>("notes.create", input),
    update: (id: string, fields: UpdateNoteInput) =>
      core.invoke<Note>("notes.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("notes.delete", { id }),
    /** Bulk-trash several notes in one call (multiselect delete). */
    removeMany: (ids: string[]) => core.invoke<{ count: number }>("notes.deleteMany", { ids }),
    /** Mark a note open in an editor so sync defers its conflicts to the UI. */
    hold: (id: string) => core.invoke<{ ok: boolean }>("notes.hold", { id }),
    /** Stop holding the open note (editor closed). */
    release: () => core.invoke<{ ok: boolean }>("notes.release"),
    /** The pending held-note conflict awaiting resolution, or null. */
    conflict: () => core.invoke<NoteConflict | null>("notes.conflict"),
    /** Resolve a held-note conflict by adopting the server version or restoring it. */
    resolveConflict: (id: string, action: NoteConflictAction) =>
      core.invoke<{ ok: boolean }>("notes.conflictResolve", { id, action }),
  };
}

export type NotesApi = ReturnType<typeof notesApi>;
