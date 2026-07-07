import type { CoreBridge, ObjectProps, Task, TaskStatus } from "./types";

export interface CreateTaskInput {
  title?: string;
  notesMd?: string;
  status?: TaskStatus;
  /** ISO timestamp. */
  dueAt?: string | null;
  remindAt?: string | null;
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
  objectTypeId?: string | null;
  clearObjectType?: boolean;
  props?: ObjectProps;
}

/** Typed wrappers over the tasks.* core methods (PLAN §6.4). Deleting a task moves it to
 *  the Trash (like notes); restore / delete-forever go through the trash.* API. */
export function tasksApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Task[]>("tasks.list"),
    get: (id: string) => core.invoke<Task>("tasks.get", { id }),
    create: (input: CreateTaskInput) => core.invoke<Task>("tasks.create", input),
    update: (id: string, fields: UpdateTaskInput) => core.invoke<Task>("tasks.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("tasks.delete", { id }),
  };
}

export type TasksApi = ReturnType<typeof tasksApi>;
