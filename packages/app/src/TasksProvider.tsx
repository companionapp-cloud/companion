import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreateTaskInput, RepeatingTask, Task, TaskStatus, UpdateTaskInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";
import type { MembershipFilter } from "./NotesProvider";
import { filterBySchedule, isSomeday, withoutSomeday, type ScheduleFilter } from "./taskSchedule";

/** The task browse-list filter: the two membership scopes (PLAN §6.6) plus the schedule views
 *  — Anytime, Upcoming, Overdue, Someday (PLAN-scheduling.md §5, see taskSchedule.ts). */
export type TaskFilter = MembershipFilter | ScheduleFilter;

export interface TasksStore {
  tasks: Task[];
  /** The list the global browse view shows: `tasks` narrowed by `filter` (PLAN §6.6). */
  visible: Task[];
  /** Open (not done) tasks in no project, regardless of `filter` — what the sidebar badge counts.
   *  Someday tasks are filed away, so they don't count. */
  openUnsorted: Task[];
  /** Ids of the tasks filed in a Someday project: filed away with it, so every list outside
   *  that project shows them only under Someday (PLAN-scheduling.md §1). */
  somedayIds: ReadonlySet<string>;
  filter: TaskFilter;
  setFilter: (f: TaskFilter) => void;
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
  /** Bulk-trash several tasks in one core call (multiselect delete). */
  removeMany: (ids: string[]) => Promise<void>;
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
  const [somedayIds, setSomedayIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<TaskFilter>("unsorted");
  const [loading, setLoading] = useState(true);
  const mutating = useRef(0); // suppress refresh clobber while an optimistic write is in flight

  const refresh = useCallback(async () => {
    const [list, seedList, sorted, filedAway] = await Promise.all([
      api.list(),
      api.listSeeds(),
      projectsApi.memberEntityIds("task"),
      projectsApi.somedayTaskIds(),
    ]);
    setTasks(list);
    setSeeds(seedList);
    setMemberIds(new Set(sorted));
    setSomedayIds(new Set(filedAway ?? []));
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
    // A project going to (or coming back from) Someday files its tasks away with it.
    const offNav = core.on("nav.changed", scheduleRefresh);
    return () => {
      offTasks();
      offData();
      offNav();
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

  const removeMany = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      await api.removeMany(ids);
      const drop = new Set(ids);
      setTasks((prev) => prev.filter((t) => !drop.has(t.id)));
      syncTrigger();
    },
    [api, syncTrigger],
  );

  const openUnsorted = useMemo(
    () => tasks.filter((t) => t.status !== "done" && !memberIds.has(t.id) && !isSomeday(t, somedayIds)),
    [tasks, memberIds, somedayIds],
  );
  const visible = useMemo(() => {
    switch (filter) {
      case "all":
        return withoutSomeday(tasks, somedayIds);
      case "unsorted":
        return withoutSomeday(tasks, somedayIds).filter((t) => !memberIds.has(t.id));
      default:
        return filterBySchedule(tasks, filter, somedayIds);
    }
  }, [tasks, memberIds, somedayIds, filter]);

  const value = useMemo<TasksStore>(
    () => ({
      tasks,
      visible,
      openUnsorted,
      somedayIds,
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
      removeMany,
    }),
    [tasks, visible, openUnsorted, somedayIds, filter, seeds, loading, create, update, setStatus, remove, removeMany],
  );

  return <TasksCtx.Provider value={value}>{children}</TasksCtx.Provider>;
}

export function useTasks(): TasksStore {
  const v = useContext(TasksCtx);
  if (!v) throw new Error("useTasks must be used within a TasksProvider");
  return v;
}
