import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note, UpdateNoteInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

/** Browse-list membership filter (PLAN §6.6): "unsorted" = notes in no project (default),
 *  "all" = every note regardless of project. */
export type MembershipFilter = "unsorted" | "all";

export interface NotesStore {
  notes: Note[];
  /** The list the global browse view shows: `notes` narrowed by `filter`. */
  visible: Note[];
  filter: MembershipFilter;
  setFilter: (f: MembershipFilter) => void;
  loading: boolean;
  byId: (id: string) => Note | undefined;
  create: (input?: { title?: string; contentMd?: string; date?: string | null }) => Promise<Note>;
  remove: (id: string) => Promise<void>;
  /** Debounced, optimistic field save (per note). */
  save: (id: string, fields: { title?: string; contentMd?: string }) => void;
  /** Immediate update for non-text fields (archetype, props — PLAN §6.3). */
  update: (id: string, fields: UpdateNoteInput) => Promise<Note>;
}

const NotesCtx = createContext<NotesStore | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const { core, notes: api, projects: projectsApi } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [notes, setNotes] = useState<Note[]>([]);
  // Ids of notes that belong to ≥1 project, so `filter: "unsorted"` can subtract them.
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<MembershipFilter>("unsorted");
  const [loading, setLoading] = useState(true);
  const saving = useRef(0); // count of in-flight saves; suppress refresh while > 0

  const refresh = useCallback(async () => {
    const [list, sorted] = await Promise.all([api.list(), projectsApi.memberEntityIds("note")]);
    setNotes(list);
    setMemberIds(new Set(sorted));
    setLoading(false);
  }, [api, projectsApi]);

  useEffect(() => {
    void refresh();
    const guarded = () => {
      if (saving.current === 0) void refresh();
    };
    // notes.changed: note edits. nav.changed: project membership edits (which move a note
    // between the Unsorted and All views).
    const offNotes = core.on("notes.changed", guarded);
    const offNav = core.on("nav.changed", guarded);
    return () => {
      offNotes();
      offNav();
    };
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
    async (input?: { title?: string; contentMd?: string; date?: string | null }) => {
      const note = await api.create({ title: input?.title ?? "Untitled", contentMd: input?.contentMd ?? "", date: input?.date ?? null });
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

  const visible = useMemo(
    () => (filter === "all" ? notes : notes.filter((n) => !memberIds.has(n.id))),
    [notes, memberIds, filter],
  );

  const value = useMemo<NotesStore>(
    () => ({
      notes,
      visible,
      filter,
      setFilter,
      loading,
      byId: (id) => notes.find((n) => n.id === id),
      create,
      remove,
      save,
      update,
    }),
    [notes, visible, filter, loading, create, remove, save, update],
  );

  return <NotesCtx.Provider value={value}>{children}</NotesCtx.Provider>;
}

export function useNotes(): NotesStore {
  const v = useContext(NotesCtx);
  if (!v) throw new Error("useNotes must be used within a NotesProvider");
  return v;
}
