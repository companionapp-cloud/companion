import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note, UpdateNoteInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface NotesStore {
  notes: Note[];
  loading: boolean;
  byId: (id: string) => Note | undefined;
  create: (input?: { title?: string; contentMd?: string }) => Promise<Note>;
  remove: (id: string) => Promise<void>;
  /** Debounced, optimistic field save (per note). */
  save: (id: string, fields: { title?: string; contentMd?: string }) => void;
  /** Immediate update for non-text fields (archetype, props — PLAN §6.3). */
  update: (id: string, fields: UpdateNoteInput) => Promise<Note>;
}

const NotesCtx = createContext<NotesStore | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const { core, notes: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const saving = useRef(0); // count of in-flight saves; suppress refresh while > 0

  const refresh = useCallback(async () => {
    setNotes(await api.list());
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void refresh();
    return core.on("notes.changed", () => {
      if (saving.current === 0) void refresh();
    });
  }, [core, refresh]);

  // Per-note debounce timers + accumulated pending fields.
  const savers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout> | null; fields: { title?: string; contentMd?: string } }>());

  const save = useCallback(
    (id: string, fields: { title?: string; contentMd?: string }) => {
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...fields } : n)));
      const entry = savers.current.get(id) ?? { timer: null, fields: {} };
      entry.fields = { ...entry.fields, ...fields };
      if (entry.timer) clearTimeout(entry.timer);
      saving.current += entry.timer ? 0 : 1;
      entry.timer = setTimeout(async () => {
        const toSave = entry.fields;
        savers.current.delete(id);
        try {
          const updated = await api.update(id, toSave);
          setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
          syncTrigger();
        } finally {
          saving.current = Math.max(0, saving.current - 1);
        }
      }, 400);
      savers.current.set(id, entry);
    },
    [api, syncTrigger],
  );

  const create = useCallback(
    async (input?: { title?: string; contentMd?: string }) => {
      const note = await api.create({ title: input?.title ?? "Untitled", contentMd: input?.contentMd ?? "" });
      setNotes((prev) => [note, ...prev]);
      syncTrigger();
      return note;
    },
    [api, syncTrigger],
  );

  const update = useCallback(
    async (id: string, fields: UpdateNoteInput) => {
      const updated = await api.update(id, fields);
      setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
      syncTrigger();
      return updated;
    },
    [api, syncTrigger],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const value = useMemo<NotesStore>(
    () => ({
      notes,
      loading,
      byId: (id) => notes.find((n) => n.id === id),
      create,
      remove,
      save,
      update,
    }),
    [notes, loading, create, remove, save, update],
  );

  return <NotesCtx.Provider value={value}>{children}</NotesCtx.Provider>;
}

export function useNotes(): NotesStore {
  const v = useContext(NotesCtx);
  if (!v) throw new Error("useNotes must be used within a NotesProvider");
  return v;
}
