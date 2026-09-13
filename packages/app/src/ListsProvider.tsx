import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { List, ListItem, Task } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface ListsStore {
  /** A project's lists in their user-defined order (empty until loaded — see useProjectLists). */
  listsFor: (projectId: string) => List[];
  /** A list's rows (tasks + headings) in display order (empty until loaded — see useListItems). */
  itemsFor: (listId: string) => ListItem[];
  /** Start tracking a project's lists / a list's items; idempotent. The hooks below call these. */
  ensureProject: (projectId: string) => void;
  ensureList: (listId: string) => void;

  createList: (projectId: string, name: string) => Promise<List>;
  renameList: (id: string, name: string) => Promise<void>;
  /** Persist a new order for a project's lists (optimistic). */
  reorderLists: (projectId: string, ids: string[]) => Promise<void>;
  deleteList: (id: string) => Promise<void>;

  /** Append an existing task (it joins the list's project if it isn't a member yet). */
  addTask: (listId: string, taskId: string) => Promise<void>;
  addTasks: (listId: string, taskIds: string[]) => Promise<void>;
  /** Create a new task inside the list (project membership + list row in one call). */
  createTask: (listId: string, title: string) => Promise<Task>;
  addHeading: (listId: string, title: string) => Promise<ListItem>;
  renameHeading: (id: string, title: string) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  /** Persist a new order for a list's rows — the drag-and-drop write path (optimistic). */
  reorderItems: (listId: string, ids: string[]) => Promise<void>;
}

const ListsCtx = createContext<ListsStore | null>(null);

/** Owns project lists and their rows. Caches per project (lists) and per list (items), refreshing
 *  every loaded key on `lists.changed` (local edits) and `data.changed` (a sync pull applied rows
 *  from another device), and triggers a sync after every local mutation — mirrors TasksProvider.
 *  Reorders apply locally before the core call so a drop never flashes back. */
export function ListsProvider({ children }: { children: ReactNode }) {
  const { core, lists: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [lists, setLists] = useState<Map<string, List[]>>(new Map());
  const [items, setItems] = useState<Map<string, ListItem[]>>(new Map());
  // Keys that have been requested at least once; refresh reloads exactly these.
  const projectKeys = useRef<Set<string>>(new Set());
  const listKeys = useRef<Set<string>>(new Set());
  const mutating = useRef(0); // suppress refresh clobber while an optimistic write is in flight

  const loadProject = useCallback(
    async (projectId: string) => {
      const rows = await api.listForProject(projectId);
      setLists((prev) => new Map(prev).set(projectId, rows));
    },
    [api],
  );
  const loadList = useCallback(
    async (listId: string) => {
      const rows = await api.items(listId);
      setItems((prev) => new Map(prev).set(listId, rows));
    },
    [api],
  );
  const refresh = useCallback(async () => {
    await Promise.all([
      ...[...projectKeys.current].map((id) => loadProject(id)),
      ...[...listKeys.current].map((id) => loadList(id)),
    ]);
  }, [loadProject, loadList]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (mutating.current > 0) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 100);
  }, [refresh]);

  useEffect(() => {
    const offLists = core.on("lists.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    // Membership changes can drop a task from a project's lists (projects.removeMember).
    const offNav = core.on("nav.changed", scheduleRefresh);
    return () => {
      offLists();
      offData();
      offNav();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, scheduleRefresh]);

  const ensureProject = useCallback(
    (projectId: string) => {
      if (!projectId || projectKeys.current.has(projectId)) return;
      projectKeys.current.add(projectId);
      void loadProject(projectId);
    },
    [loadProject],
  );
  const ensureList = useCallback(
    (listId: string) => {
      if (!listId || listKeys.current.has(listId)) return;
      listKeys.current.add(listId);
      void loadList(listId);
    },
    [loadList],
  );

  // Wrap a mutation so an in-flight optimistic write isn't clobbered by an event-driven
  // refresh, then reconcile from the store and kick a sync.
  const mutate = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      mutating.current += 1;
      try {
        return await fn();
      } finally {
        mutating.current = Math.max(0, mutating.current - 1);
        void refresh();
        syncTrigger();
      }
    },
    [refresh, syncTrigger],
  );

  const createList = useCallback(
    (projectId: string, name: string) =>
      mutate(async () => {
        const list = await api.create({ projectId, name });
        setLists((prev) => new Map(prev).set(projectId, [...(prev.get(projectId) ?? []), list]));
        return list;
      }),
    [api, mutate],
  );
  const renameList = useCallback(
    (id: string, name: string) =>
      mutate(async () => {
        const updated = await api.update(id, { name });
        setLists((prev) => {
          const next = new Map(prev);
          const rows = next.get(updated.projectId);
          if (rows) next.set(updated.projectId, rows.map((l) => (l.id === id ? updated : l)));
          return next;
        });
      }),
    [api, mutate],
  );
  const reorderLists = useCallback(
    (projectId: string, ids: string[]) =>
      mutate(async () => {
        setLists((prev) => new Map(prev).set(projectId, reorderBy(prev.get(projectId) ?? [], ids, (l) => l.id)));
        await api.reorder(projectId, ids);
      }),
    [api, mutate],
  );
  const deleteList = useCallback(
    (id: string) =>
      mutate(async () => {
        await api.remove(id);
        listKeys.current.delete(id);
        setItems((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        setLists((prev) => {
          const next = new Map(prev);
          for (const [pid, rows] of next) next.set(pid, rows.filter((l) => l.id !== id));
          return next;
        });
      }),
    [api, mutate],
  );

  const appendItems = (listId: string, rows: ListItem[]) =>
    setItems((prev) => {
      const existing = prev.get(listId) ?? [];
      const seen = new Set(existing.map((i) => i.id));
      return new Map(prev).set(listId, [...existing, ...rows.filter((r) => !seen.has(r.id))]);
    });

  const addTask = useCallback(
    (listId: string, taskId: string) =>
      mutate(async () => {
        const item = await api.addTask(listId, taskId);
        appendItems(listId, [item]);
      }),
    [api, mutate],
  );
  const addTasks = useCallback(
    (listId: string, taskIds: string[]) =>
      mutate(async () => {
        if (taskIds.length === 0) return;
        const rows = await api.addTasks(listId, taskIds);
        appendItems(listId, rows);
      }),
    [api, mutate],
  );
  const createTask = useCallback(
    (listId: string, title: string) =>
      mutate(async () => {
        const { task, item } = await api.createTask(listId, { title });
        appendItems(listId, [item]);
        return task;
      }),
    [api, mutate],
  );
  const addHeading = useCallback(
    (listId: string, title: string) =>
      mutate(async () => {
        const item = await api.addHeading(listId, title);
        appendItems(listId, [item]);
        return item;
      }),
    [api, mutate],
  );
  const renameHeading = useCallback(
    (id: string, title: string) =>
      mutate(async () => {
        const updated = await api.updateItem(id, { title });
        setItems((prev) => {
          const next = new Map(prev);
          const rows = next.get(updated.listId);
          if (rows) next.set(updated.listId, rows.map((i) => (i.id === id ? updated : i)));
          return next;
        });
      }),
    [api, mutate],
  );
  const removeItem = useCallback(
    (id: string) =>
      mutate(async () => {
        await api.removeItem(id);
        setItems((prev) => {
          const next = new Map(prev);
          for (const [lid, rows] of next) next.set(lid, rows.filter((i) => i.id !== id));
          return next;
        });
      }),
    [api, mutate],
  );
  const reorderItems = useCallback(
    (listId: string, ids: string[]) =>
      mutate(async () => {
        setItems((prev) => new Map(prev).set(listId, reorderBy(prev.get(listId) ?? [], ids, (i) => i.id)));
        await api.reorderItems(listId, ids);
      }),
    [api, mutate],
  );

  const value = useMemo<ListsStore>(
    () => ({
      listsFor: (projectId) => lists.get(projectId) ?? EMPTY_LISTS,
      itemsFor: (listId) => items.get(listId) ?? EMPTY_ITEMS,
      ensureProject,
      ensureList,
      createList,
      renameList,
      reorderLists,
      deleteList,
      addTask,
      addTasks,
      createTask,
      addHeading,
      renameHeading,
      removeItem,
      reorderItems,
    }),
    [lists, items, ensureProject, ensureList, createList, renameList, reorderLists, deleteList, addTask, addTasks, createTask, addHeading, renameHeading, removeItem, reorderItems],
  );

  return <ListsCtx.Provider value={value}>{children}</ListsCtx.Provider>;
}

const EMPTY_LISTS: List[] = [];
const EMPTY_ITEMS: ListItem[] = [];

export function useLists(): ListsStore {
  const v = useContext(ListsCtx);
  if (!v) throw new Error("useLists must be used within a ListsProvider");
  return v;
}

/** A project's lists, loaded on first use and kept fresh. */
export function useProjectLists(projectId: string): List[] {
  const store = useLists();
  useEffect(() => store.ensureProject(projectId), [store, projectId]);
  return store.listsFor(projectId);
}

/** A list's rows, loaded on first use and kept fresh. */
export function useListItems(listId: string): ListItem[] {
  const store = useLists();
  useEffect(() => store.ensureList(listId), [store, listId]);
  return store.itemsFor(listId);
}

/** Reorders `items` to match the id sequence in `ids`; any items not named in `ids` keep
 *  their relative position at the end (defensive against a stale drag order). */
function reorderBy<T>(items: T[], ids: string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((it) => [idOf(it), it]));
  const ordered: T[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (it) {
      ordered.push(it);
      byId.delete(id);
    }
  }
  for (const it of items) if (byId.has(idOf(it))) ordered.push(it);
  return ordered;
}
