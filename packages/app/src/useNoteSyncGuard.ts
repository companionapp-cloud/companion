import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

export type NoteConflictKind = "updated" | "deleted";

export interface NoteSyncGuardOptions {
  noteId: string;
  /** The editor's current buffer, read when saving local edits as a new note. */
  getEditorContent: () => { title: string; contentMd: string };
  /** Reseed the editor to a server version the editor silently adopts (clean case). */
  onReseed: (note: Note) => void;
  /** The note was deleted remotely while the editor was clean — show a gone state. */
  onGone?: () => void;
  /** Called with the id of a note created via "save my changes as a new note". */
  onCreatedNote?: (id: string) => void;
}

export interface NoteSyncGuard {
  /** Non-null when a decision is required (only ever set for a *dirty* editor). */
  conflict: NoteConflictKind | null;
  /** Discard local edits and take the server version (or accept the delete). */
  discard: () => Promise<void>;
  /** Keep local edits as a brand-new note; the original takes the server version/delete. */
  saveAsNewNote: () => Promise<void>;
  /** Deleted case: bring the note back to life. */
  restore: () => Promise<void>;
}

/** Reconciles an open note editor with incoming synced changes (PLAN §7.3 editor UX).
 *
 * While mounted it "holds" the note so the sync engine stashes a conflicting server
 * version instead of silently forking it. Then:
 *  - editor **clean** + remote change  → silently reseed the editor to it;
 *  - editor **clean** + remote delete  → onGone();
 *  - editor **dirty** + remote change/delete → surface a `conflict` for the user to resolve
 *    (discard / save-as-new / restore).
 */
export function useNoteSyncGuard({
  noteId,
  getEditorContent,
  onReseed,
  onGone,
  onCreatedNote,
}: NoteSyncGuardOptions): NoteSyncGuard {
  const { core, notes } = useCore();
  const [conflict, setConflict] = useState<NoteConflictKind | null>(null);

  // Refs so the long-lived subscriptions never close over stale values.
  const conflictRef = useRef<NoteConflictKind | null>(null);
  conflictRef.current = conflict;
  const baseVersionRef = useRef<number | null>(null);
  const cbs = useRef({ getEditorContent, onReseed, onGone, onCreatedNote });
  cbs.current = { getEditorContent, onReseed, onGone, onCreatedNote };

  // Hold the note for the editor's lifetime.
  useEffect(() => {
    baseVersionRef.current = null;
    setConflict(null);
    void notes.hold(noteId);
    return () => {
      void notes.release();
    };
  }, [noteId, notes]);

  useEffect(() => {
    const reconcile = async () => {
      if (conflictRef.current) return; // a decision is already pending
      let fresh: Note | null = null;
      try {
        fresh = await notes.get(noteId);
      } catch {
        fresh = null;
      }
      if (fresh === null) {
        // Deleted/trashed. A dirty conflict would have raised notes.conflict; double-check
        // for a stash, otherwise it was a clean remote delete.
        const pc = await notes.conflict().catch(() => null);
        if (pc && pc.id === noteId) {
          setConflict("deleted");
          return;
        }
        cbs.current.onGone?.();
        return;
      }
      if (baseVersionRef.current === null) {
        baseVersionRef.current = fresh.version; // first observation: establish the base
        return;
      }
      if (fresh.version === baseVersionRef.current) return;
      const cur = cbs.current.getEditorContent();
      if (fresh.contentMd === cur.contentMd && fresh.title === cur.title) {
        baseVersionRef.current = fresh.version; // our own edit echoing back from the server
        return;
      }
      if (!fresh.dirty) {
        baseVersionRef.current = fresh.version;
        cbs.current.onReseed(fresh); // clean remote change: adopt silently
      }
      // else: dirty local edits differ — the conflict arrives via notes.conflict.
    };

    const offConflict = core.on("notes.conflict", (payload) => {
      const c = payload as { id: string; deleted: boolean } | null;
      if (!c || c.id !== noteId) return;
      setConflict(c.deleted ? "deleted" : "updated");
    });
    const offChanged = core.on("notes.changed", () => {
      void reconcile();
    });
    void reconcile(); // establish the base version on mount
    return () => {
      offConflict();
      offChanged();
    };
  }, [noteId, core, notes]);

  const reflectServer = useCallback(async () => {
    try {
      const fresh = await notes.get(noteId);
      baseVersionRef.current = fresh.version;
      cbs.current.onReseed(fresh);
    } catch {
      cbs.current.onGone?.();
    }
  }, [noteId, notes]);

  const discard = useCallback(async () => {
    await notes.resolveConflict(noteId, "adopt");
    setConflict(null);
    await reflectServer();
  }, [noteId, notes, reflectServer]);

  const saveAsNewNote = useCallback(async () => {
    const cur = cbs.current.getEditorContent();
    const created = await notes.create({ title: cur.title || "Untitled", contentMd: cur.contentMd });
    await notes.resolveConflict(noteId, "adopt"); // the original takes the server version/delete
    setConflict(null);
    cbs.current.onCreatedNote?.(created.id);
    await reflectServer();
  }, [noteId, notes, reflectServer]);

  const restore = useCallback(async () => {
    await notes.resolveConflict(noteId, "restore");
    setConflict(null);
    await reflectServer();
  }, [noteId, notes, reflectServer]);

  return { conflict, discard, saveAsNewNote, restore };
}
