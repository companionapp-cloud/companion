import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
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
// Ink is written (and synced) only once inking has stopped for this long. A write that lands
// while a sync is pushing the group's previous version is marked clean by that push and then
// overwritten by the pull that follows it, losing the strokes drawn in between; holding writes
// until the hand rests keeps them out of a sync's way.
const SAVE_DEBOUNCE_MS = 3000;
const rev = (r: NoteInk) => `${r.version}:${r.updatedAt}`;
const toRecord = (r: NoteInk): InkGroupRecord => ({ id: r.id, data: r.data, rev: rev(r) });

/** Ink the editor has handed over that the core doesn't have yet. */
interface InkBatch {
  /** Null while the note doesn't exist yet: `ensure` creates it when the batch is written. */
  noteId: string | null;
  ensure?: () => Promise<string | null>;
  saves: Map<string, Record<string, unknown>>;
  deletes: Set<string>;
}

function sameRecords(prev: InkGroupRecord[], next: InkGroupRecord[]): boolean {
  return (
    prev.length === next.length &&
    next.every((n, i) => prev[i].id === n.id && prev[i].rev === n.rev && (n.rev !== undefined || prev[i].data === n.data))
  );
}

/** The core's rows as the editor should see them: a read taken while ink is still held here
 *  is stale for those groups, and must not replace what was just drawn. */
function withUnwritten(rows: InkGroupRecord[], batches: InkBatch[], noteId: string): InkGroupRecord[] {
  let out = rows;
  for (const b of batches) {
    if (b.noteId !== noteId || (b.saves.size === 0 && b.deletes.size === 0)) continue;
    const seen = new Set<string>();
    const next: InkGroupRecord[] = [];
    for (const r of out) {
      if (b.deletes.has(r.id)) continue;
      seen.add(r.id);
      const data = b.saves.get(r.id);
      next.push(data ? { id: r.id, data } : r);
    }
    for (const [id, data] of b.saves) if (!seen.has(id)) next.push({ id, data });
    out = next;
  }
  return out;
}

/** A note's ink (PLAN-drawing.md), kept live: loaded from the core, reloaded when this device
 *  draws (`noteInk.changed`) and after every sync (pulled ink arrives with the bulk
 *  `data.changed` each sync emits). Writes are held until inking has stopped for
 *  {@link SAVE_DEBOUNCE_MS} (or the note closes, or the app goes to the background), then go
 *  to the core and nudge a sync.
 *
 *  `ensureNoteId` serves hosts whose note may not exist yet (a daily note before anything is
 *  written): the first write creates the note, then its ink is saved to it. */
export function useNoteInk(noteId: string | null, ensureNoteId?: () => Promise<string | null>): NoteInkStore {
  const { core, noteInk } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [groups, setGroups] = useState<InkGroupRecord[]>(EMPTY);
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const ensureRef = useRef(ensureNoteId);
  ensureRef.current = ensureNoteId;
  const syncTriggerRef = useRef(syncTrigger);
  syncTriggerRef.current = syncTrigger;
  // Only the latest load may land: an earlier read can resolve after a later write.
  const loadSeq = useRef(0);
  const reload = useRef<() => void>(() => {});
  /** The batch still collecting, and the ones on their way to the core. */
  const pending = useRef<InkBatch | null>(null);
  const writing = useRef<InkBatch[]>([]);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const batch = pending.current;
    pending.current = null;
    if (!batch || (batch.saves.size === 0 && batch.deletes.size === 0)) return;
    writing.current.push(batch);
    // One at a time, in order: a later batch may rewrite a group an earlier one wrote.
    writes.current = writes.current.then(async () => {
      try {
        const id = batch.noteId ?? (await batch.ensure?.()) ?? null;
        if (!id) return;
        if (batch.saves.size) {
          await noteInk.upsert(
            id,
            [...batch.saves].map(([gid, data]) => ({ id: gid, data })),
          );
        }
        if (batch.deletes.size) await noteInk.remove(id, [...batch.deletes]);
        syncTriggerRef.current();
      } catch (e) {
        console.warn("saving ink failed", e);
      } finally {
        writing.current = writing.current.filter((b) => b !== batch);
        reload.current();
      }
    });
  }, [noteInk]);

  /** The batch for the open note, restarting the wait: inking hasn't stopped. */
  const hold = useCallback((): InkBatch => {
    const id = noteIdRef.current;
    if (pending.current && pending.current.noteId !== id) flush();
    pending.current ??= { noteId: id, ensure: ensureRef.current, saves: new Map(), deletes: new Set() };
    if (timer.current) clearTimeout(timer.current);
    // The editor hands over its last strokes as it closes, which can be after this hook has
    // unmounted: nothing is left to wait for then.
    timer.current = setTimeout(flush, mounted.current ? SAVE_DEBOUNCE_MS : 0);
    return pending.current;
  }, [flush]);

  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") flush();
    });
    return () => {
      mounted.current = false;
      sub.remove();
      flush();
    };
  }, [flush]);

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
          if (!alive || seq !== loadSeq.current) return;
          const unwritten = pending.current ? [...writing.current, pending.current] : writing.current;
          const next = withUnwritten(rows.map(toRecord), unwritten, noteId);
          setGroups((prev) => (sameRecords(prev, next) ? prev : next));
        })
        .catch(() => {});
    };
    load();
    reload.current = load;
    const offInk = core.on("noteInk.changed", (p) => {
      if ((p as { noteId?: string } | null)?.noteId === noteId) load();
    });
    const offData = core.on("data.changed", (p) => {
      if (!(p as { entityType?: string } | null)?.entityType) load();
    });
    return () => {
      alive = false;
      reload.current = () => {};
      offInk();
      offData();
      // Ink still held belongs to the note being left.
      flush();
    };
  }, [core, noteInk, noteId, flush]);

  const save = useCallback(
    (records: InkGroupRecord[]) => {
      if (records.length === 0) return;
      const batch = hold();
      for (const r of records) {
        batch.saves.set(r.id, r.data);
        batch.deletes.delete(r.id);
      }
    },
    [hold],
  );

  const remove = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || (!noteIdRef.current && !pending.current)) return;
      const batch = hold();
      for (const id of ids) {
        batch.saves.delete(id);
        batch.deletes.add(id);
      }
    },
    [hold],
  );

  return { groups, save, remove };
}
