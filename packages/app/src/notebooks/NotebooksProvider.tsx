import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Notebook, NotebookSummary, UpdateNotebookInput } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";

export interface NotebooksStore {
  notebooks: NotebookSummary[];
  loading: boolean;
  byId: (id: string) => NotebookSummary | undefined;
  create: (input?: { title?: string; coverColor?: string }) => Promise<Notebook>;
  update: (id: string, input: UpdateNotebookInput) => Promise<void>;
  /** Move a notebook to the Trash; its pages and ink ride along. */
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
}

const NotebooksCtx = createContext<NotebooksStore | null>(null);

/** Owns the shelf (PLAN-notebooks.md): the notebook rows and their page counts. Page contents
 *  and ink are loaded per open notebook by the editor. Refreshes on `notebooks.changed` and
 *  `data.changed` (a sync pull), never on ink writes, and kicks a sync after each write. */
export function NotebooksProvider({ children }: { children: ReactNode }) {
  const { core, notebooks: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setNotebooks((await api.list()) ?? []);
    setLoading(false);
  }, [api]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offBooks = core.on("notebooks.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    return () => {
      offBooks();
      offData();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const create = useCallback(
    async (input?: { title?: string; coverColor?: string }) => {
      const nb = await api.create({ title: input?.title ?? "", coverColor: input?.coverColor ?? "ink" });
      await refresh();
      syncTrigger();
      return nb;
    },
    [api, refresh, syncTrigger],
  );
  const update = useCallback(
    async (id: string, input: UpdateNotebookInput) => {
      const nb = await api.update(id, input);
      setNotebooks((prev) => prev.map((n) => (n.id === id ? { ...n, ...nb } : n)));
      syncTrigger();
    },
    [api, syncTrigger],
  );
  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      setNotebooks((prev) => prev.filter((n) => n.id !== id));
      syncTrigger();
    },
    [api, syncTrigger],
  );
  const reorder = useCallback(
    async (ids: string[]) => {
      const order = new Map(ids.map((id, i) => [id, i]));
      setNotebooks((prev) => [...prev].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
      await api.reorder(ids);
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const value = useMemo<NotebooksStore>(
    () => ({ notebooks, loading, byId: (id) => notebooks.find((n) => n.id === id), create, update, remove, reorder }),
    [notebooks, loading, create, update, remove, reorder],
  );
  return <NotebooksCtx.Provider value={value}>{children}</NotebooksCtx.Provider>;
}

export function useNotebooks(): NotebooksStore {
  const ctx = useContext(NotebooksCtx);
  if (!ctx) throw new Error("useNotebooks must be used within NotebooksProvider");
  return ctx;
}
