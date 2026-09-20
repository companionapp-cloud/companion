import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Canvas } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";
import type { MembershipFilter } from "../NotesProvider";

export interface CanvasesStore {
  canvases: Canvas[];
  /** The list the global browse view shows: `canvases` narrowed by `filter`. */
  visible: Canvas[];
  filter: MembershipFilter;
  setFilter: (f: MembershipFilter) => void;
  loading: boolean;
  byId: (id: string) => Canvas | undefined;
  create: (name?: string) => Promise<Canvas>;
  rename: (id: string, name: string) => Promise<void>;
  /** Move a board to the Trash. */
  remove: (id: string) => Promise<void>;
  /** Bulk-trash several boards in one core call (multiselect delete). */
  removeMany: (ids: string[]) => Promise<void>;
}

const CanvasesCtx = createContext<CanvasesStore | null>(null);

/** Owns the list of canvas boards (PLAN-canvases.md). Board *contents* are loaded per
 *  open board by the editor; this only tracks the rows the browse lists show. Mirrors
 *  NotesProvider: refreshes on `canvases.changed`, `nav.changed` (membership edits move a
 *  board between Unsorted and All) and `data.changed`, and kicks a sync after each write. */
export function CanvasesProvider({ children }: { children: ReactNode }) {
  const { core, canvases: api, projects: projectsApi } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<MembershipFilter>("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [list, sorted] = await Promise.all([api.list(), projectsApi.memberEntityIds("canvas")]);
    setCanvases(list ?? []);
    setMemberIds(new Set(sorted ?? []));
    setLoading(false);
  }, [api, projectsApi]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offCanvases = core.on("canvases.changed", scheduleRefresh);
    const offNav = core.on("nav.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    return () => {
      offCanvases();
      offNav();
      offData();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const create = useCallback(
    async (name?: string) => {
      const canvas = await api.create({ name: name ?? "Untitled canvas" });
      setCanvases((prev) => [canvas, ...prev]);
      syncTrigger();
      return canvas;
    },
    [api, syncTrigger],
  );
  const rename = useCallback(
    async (id: string, name: string) => {
      const updated = await api.update(id, { name });
      setCanvases((prev) => prev.map((c) => (c.id === id ? updated : c)));
      syncTrigger();
    },
    [api, syncTrigger],
  );
  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      setCanvases((prev) => prev.filter((c) => c.id !== id));
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const removeMany = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      await api.removeMany(ids);
      const drop = new Set(ids);
      setCanvases((prev) => prev.filter((c) => !drop.has(c.id)));
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const visible = useMemo(() => (filter === "all" ? canvases : canvases.filter((c) => !memberIds.has(c.id))), [canvases, memberIds, filter]);

  const value = useMemo<CanvasesStore>(
    () => ({ canvases, visible, filter, setFilter, loading, byId: (id) => canvases.find((c) => c.id === id), create, rename, remove, removeMany }),
    [canvases, visible, filter, loading, create, rename, remove, removeMany],
  );
  return <CanvasesCtx.Provider value={value}>{children}</CanvasesCtx.Provider>;
}

export function useCanvases(): CanvasesStore {
  const v = useContext(CanvasesCtx);
  if (!v) throw new Error("useCanvases must be used within a CanvasesProvider");
  return v;
}
