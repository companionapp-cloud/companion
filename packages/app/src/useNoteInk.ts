import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteInk } from "@companion/core-bridge";
import type { InkGroupRecord } from "@companion/editor";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface NoteInkStore {
  /** The note's ink groups, for `<Editor ink={{ groups }}>`. Stable until something changes. */
  groups: InkGroupRecord[];
  save: (groups: InkGroupRecord[]) => void;
  remove: (ids: string[]) => void;
}

const EMPTY: InkGroupRecord[] = [];
const rev = (r: NoteInk) => `${r.version}:${r.updatedAt}`;
const toRecord = (r: NoteInk): InkGroupRecord => ({ id: r.id, data: r.data, rev: rev(r) });

function sameRows(prev: InkGroupRecord[], rows: NoteInk[]): boolean {
  return prev.length === rows.length && rows.every((r, i) => prev[i].id === r.id && prev[i].rev === rev(r));
}

/** A note's ink (PLAN-drawing.md), kept live: loaded from the core, reloaded when this device
 *  draws (`noteInk.changed`) and after every sync (pulled ink arrives with the bulk
 *  `data.changed` each sync emits). Writes go straight to the core and nudge a sync.
 *
 *  `ensureNoteId` serves hosts whose note may not exist yet (a daily note before anything is
 *  written): the first stroke creates the note, then its ink is saved to it. */
export function useNoteInk(noteId: string | null, ensureNoteId?: () => Promise<string | null>): NoteInkStore {
  const { core, noteInk } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [groups, setGroups] = useState<InkGroupRecord[]>(EMPTY);
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const ensureRef = useRef(ensureNoteId);
  ensureRef.current = ensureNoteId;
  // Only the latest load may land: an earlier read can resolve after a later write.
  const loadSeq = useRef(0);

  useEffect(() => {
    if (!noteId) {
      setGroups(EMPTY);
      return;
    }
    let alive = true;
    const load = () => {
      const seq = ++loadSeq.current;
      noteInk
        .list(noteId)
        .then((rows) => {
          if (alive && seq === loadSeq.current) setGroups((prev) => (sameRows(prev, rows) ? prev : rows.map(toRecord)));
        })
        .catch(() => {});
    };
    load();
    const offInk = core.on("noteInk.changed", (p) => {
      if ((p as { noteId?: string } | null)?.noteId === noteId) load();
    });
    const offData = core.on("data.changed", (p) => {
      if (!(p as { entityType?: string } | null)?.entityType) load();
    });
    return () => {
      alive = false;
      offInk();
      offData();
    };
  }, [core, noteInk, noteId]);

  const save = useCallback(
    (records: InkGroupRecord[]) => {
      void (async () => {
        const id = noteIdRef.current ?? (await ensureRef.current?.()) ?? null;
        if (!id || records.length === 0) return;
        await noteInk.upsert(
          id,
          records.map((r) => ({ id: r.id, data: r.data })),
        );
        syncTrigger();
      })().catch((e) => console.warn("saving ink failed", e));
    },
    [noteInk, syncTrigger],
  );

  const remove = useCallback(
    (ids: string[]) => {
      const id = noteIdRef.current;
      if (!id || ids.length === 0) return;
      noteInk
        .remove(id, ids)
        .then(() => syncTrigger())
        .catch((e) => console.warn("deleting ink failed", e));
    },
    [noteInk, syncTrigger],
  );

  return { groups, save, remove };
}
