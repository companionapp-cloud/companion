import type { CoreBridge, ObjectProps, RepeatPreview, RepeatingTask, Task, TaskReminder, TaskStatus } from "./types";
import { localNowWithOffset } from "./dates";

export interface CreateTaskInput {
  title?: string;
  notesMd?: string;
  status?: TaskStatus;
  /** ISO timestamps: when the task starts, and its deadline. */
  startAt?: string | null;
  /** File it under Someday instead of starting it (wins over a `startAt`). */
  someday?: boolean;
  dueAt?: string | null;
  reminders?: TaskReminder[];
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
  /** ISO timestamps to set, or set clearStartAt / clearDueAt to remove them. */
  startAt?: string | null;
  clearStartAt?: boolean;
  /** Someday and a start exclude each other: core clears one when the other is set. */
  someday?: boolean;
  dueAt?: string | null;
  clearDueAt?: boolean;
  /** Replaces the whole reminder list; [] removes every reminder. */
  reminders?: TaskReminder[];
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
    /** Parse a typed reminder: a lead before the deadline ("the day before", "a few weeks
     *  before", "an hour before") or an absolute time ("tomorrow at 9am"), read in core so
     *  every platform agrees. {reminder:null} when neither reads. */
    parseReminder: (text: string, ref?: string) =>
      core.invoke<{ reminder: TaskReminder | null }>("tasks.parseReminder", { text, ref: ref ?? localNowWithOffset() }),
    get: (id: string) => core.invoke<Task>("tasks.get", { id }),
    create: (input: CreateTaskInput) => core.invoke<Task>("tasks.create", input),
    update: (id: string, fields: UpdateTaskInput) => core.invoke<Task>("tasks.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("tasks.delete", { id }),
    /** Bulk-trash several tasks in one call (multiselect delete). */
    removeMany: (ids: string[]) => core.invoke<{ count: number }>("tasks.deleteMany", { ids }),
  };
}

export type TasksApi = ReturnType<typeof tasksApi>;
