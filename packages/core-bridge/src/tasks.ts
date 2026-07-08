import type { CoreBridge, ObjectProps, RepeatPreview, RepeatingTask, Task, TaskStatus } from "./types";

export interface CreateTaskInput {
  title?: string;
  notesMd?: string;
  status?: TaskStatus;
  /** ISO timestamp. */
  dueAt?: string | null;
  remindAt?: string | null;
  /** RFC5545 RRULE (e.g. "FREQ=WEEKLY;BYDAY=MO") — turns this into a repeating-task seed;
   *  the server materializes its occurrences (PLAN §6.4). */
  repeatRule?: string | null;
  /** Archetype the task (PLAN §6.3): an object type id plus its schema-validated props. */
  objectTypeId?: string | null;
  props?: ObjectProps;
}

export interface UpdateTaskInput {
  title?: string;
  notesMd?: string;
  status?: TaskStatus;
  /** ISO timestamp to set, or set clearDueAt to remove it. */
  dueAt?: string | null;
  clearDueAt?: boolean;
  remindAt?: string | null;
  clearRemindAt?: boolean;
  /** RRULE to set, or set clearRepeatRule to stop repeating. */
  repeatRule?: string | null;
  clearRepeatRule?: boolean;
  objectTypeId?: string | null;
  clearObjectType?: boolean;
  props?: ObjectProps;
}

/** Typed wrappers over the tasks.* core methods (PLAN §6.4). Deleting a task moves it to
 *  the Trash (like notes); restore / delete-forever go through the trash.* API. */
export function tasksApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Task[]>("tasks.list"),
    /** Repeating-task definitions (seeds), each with its next computed occurrence. */
    listSeeds: () => core.invoke<RepeatingTask[]>("tasks.listSeeds"),
    /** Validate a candidate RRULE and preview its upcoming occurrences from `anchor`
     *  (defaults to now) — powers the "repeats every … · next …" hint in the editor. */
    repeatPreview: (rule: string, anchor?: string, count?: number) =>
      core.invoke<RepeatPreview>("tasks.repeatPreview", { rule, anchor, count }),
    /** Parse a typed natural-language cadence ("every monday", "the third wednesday of the
     *  month") into an RRULE, or {rule:null} when it isn't a recognizable recurrence. */
    parseRepeat: (text: string, ref?: string) =>
      core.invoke<{ rule: string | null }>("tasks.parseRepeat", { text, ref }),
    get: (id: string) => core.invoke<Task>("tasks.get", { id }),
    create: (input: CreateTaskInput) => core.invoke<Task>("tasks.create", input),
    update: (id: string, fields: UpdateTaskInput) => core.invoke<Task>("tasks.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("tasks.delete", { id }),
  };
}

export type TasksApi = ReturnType<typeof tasksApi>;
