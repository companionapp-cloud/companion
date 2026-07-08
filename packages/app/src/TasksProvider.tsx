import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreateTaskInput, RepeatingTask, Task, TaskStatus, UpdateTaskInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";
import type { MembershipFilter } from "./NotesProvider";

export interface TasksStore {
  tasks: Task[];
  /** The list the global browse view shows: `tasks` narrowed by `filter` (PLAN §6.6). */
  visible: Task[];
  filter: MembershipFilter;
  setFilter: (f: MembershipFilter) => void;
  /** Repeating-task definitions (seeds), each with its next occurrence. Seeds are excluded
   *  from `tasks` — they're not actionable; their materialized occurrences are (PLAN §6.4). */
  seeds: RepeatingTask[];
  loading: boolean;
  byId: (id: string) => Task | undefined;
  /** A seed by id, for opening a repeating definition (which is not in `tasks`). */
  seedById: (id: string) => RepeatingTask | undefined;
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
  const { core, tasks: api, projects: projectsApi } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seeds, setSeeds] = useState<RepeatingTask[]>([]);
  // Ids of tasks that belong to ≥1 project, so `filter: "unsorted"` can subtract them.
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<MembershipFilter>("unsorted");
  const [loading, setLoading] = useState(true);
  const mutating = useRef(0); // suppress refresh clobber while an optimistic write is in flight

  const refresh = useCallback(async () => {
    const [list, seedList, sorted] = await Promise.all([api.list(), api.listSeeds(), projectsApi.memberEntityIds("task")]);
    setTasks(list);
    setSeeds(seedList);
    setMemberIds(new Set(sorted));
    setLoading(false);
  }, [api, projectsApi]);

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
        // Adding/removing a repeat rule moves the row between the actionable list and the
        // Repeating section (seeds are excluded from `tasks`), so reconcile both.
        if (fields.repeatRule !== undefined || fields.clearRepeatRule) void refresh();
        return updated;
      } finally {
        mutating.current = Math.max(0, mutating.current - 1);
      }
    },
    [api, syncTrigger, refresh],
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

  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((t) => !memberIds.has(t.id))),
    [tasks, memberIds, filter],
  );

  const value = useMemo<TasksStore>(
    () => ({
      tasks,
      visible,
      filter,
      setFilter,
      seeds,
      loading,
      byId: (id) => tasks.find((t) => t.id === id),
      seedById: (id) => seeds.find((t) => t.id === id),
      create,
      update,
      setStatus,
      remove,
    }),
    [tasks, visible, filter, seeds, loading, create, update, setStatus, remove],
  );

  return <TasksCtx.Provider value={value}>{children}</TasksCtx.Provider>;
}

export function useTasks(): TasksStore {
  const v = useContext(TasksCtx);
  if (!v) throw new Error("useTasks must be used within a TasksProvider");
  return v;
}
