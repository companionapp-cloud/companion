import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreateTaskInput, Task, TaskStatus, UpdateTaskInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface TasksStore {
  tasks: Task[];
  loading: boolean;
  byId: (id: string) => Task | undefined;
  create: (input?: CreateTaskInput) => Promise<Task>;
  update: (id: string, fields: UpdateTaskInput) => Promise<Task>;
  /** Toggle/set a task's status (optimistic — the checkbox flips instantly). */
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const TasksCtx = createContext<TasksStore | null>(null);

/** Owns the tasks list (PLAN §6.4). Refreshes on `tasks.changed` (local edits) and
 * `data.changed` (a sync pull applied task rows from another device), and triggers a sync
 * after every local mutation — mirrors NotesProvider. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const { core, tasks: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const mutating = useRef(0); // suppress refresh clobber while an optimistic write is in flight

  const refresh = useCallback(async () => {
    setTasks(await api.list());
    setLoading(false);
  }, [api]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (mutating.current > 0) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 100);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offTasks = core.on("tasks.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    return () => {
      offTasks();
      offData();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const create = useCallback(
    async (input?: CreateTaskInput) => {
      const task = await api.create(input ?? {});
      setTasks((prev) => [task, ...prev]);
      syncTrigger();
      return task;
    },
    [api, syncTrigger],
  );

  const update = useCallback(
    async (id: string, fields: UpdateTaskInput) => {
      mutating.current += 1;
      try {
        const updated = await api.update(id, fields);
        setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
        syncTrigger();
        return updated;
      } finally {
        mutating.current = Math.max(0, mutating.current - 1);
      }
    },
    [api, syncTrigger],
  );

  const setStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      // Optimistic flip so the checkbox is instant; reconcile from the real row after.
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
      await update(id, { status });
    },
    [update],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const value = useMemo<TasksStore>(
    () => ({
      tasks,
      loading,
      byId: (id) => tasks.find((t) => t.id === id),
      create,
      update,
      setStatus,
      remove,
    }),
    [tasks, loading, create, update, setStatus, remove],
  );

  return <TasksCtx.Provider value={value}>{children}</TasksCtx.Provider>;
}

export function useTasks(): TasksStore {
  const v = useContext(TasksCtx);
  if (!v) throw new Error("useTasks must be used within a TasksProvider");
  return v;
}
