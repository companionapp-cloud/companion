import type { CoreBridge, List, ListItem, Task } from "./types";
import type { CreateTaskInput } from "./tasks";

export interface CreateListInput {
  projectId: string;
  name: string;
}
export interface UpdateListInput {
  name?: string;
  sortOrder?: number;
}
export interface ListDetail {
  list: List;
  items: ListItem[];
}
export interface CreatedListTask {
  task: Task;
  item: ListItem;
}

/** Typed wrappers over the lists.* core methods: project-scoped, drag-ordered task lists
 *  with headings that group the tasks beneath them. Adding a task to a list also makes it a
 *  member of the list's project (a list only ever holds its project's tasks). */
export function listsApi(core: CoreBridge) {
  return {
    // Lists
    listForProject: (projectId: string) => core.invoke<List[]>("lists.list", { projectId }),
    get: (id: string) => core.invoke<ListDetail>("lists.get", { id }),
    create: (input: CreateListInput) => core.invoke<List>("lists.create", input),
    update: (id: string, fields: UpdateListInput) => core.invoke<List>("lists.update", { id, ...fields }),
    /** Persist a new top-to-bottom order for one project's lists (drag-and-drop). */
    reorder: (projectId: string, ids: string[]) => core.invoke<{ ok: boolean }>("lists.reorder", { projectId, ids }),
    /** Delete a list and its rows; the tasks themselves are untouched. */
    remove: (id: string) => core.invoke<{ ok: boolean }>("lists.delete", { id }),

    // Items (task refs + headings, one flat order)
    items: (listId: string) => core.invoke<ListItem[]>("lists.items", { listId }),
    addTask: (listId: string, taskId: string) => core.invoke<ListItem>("lists.addTask", { listId, taskId }),
    addTasks: (listId: string, taskIds: string[]) => core.invoke<ListItem[]>("lists.addTasks", { listId, taskIds }),
    /** Create a new task, join it to the list's project, and append it to the list. */
    createTask: (listId: string, input: CreateTaskInput) => core.invoke<CreatedListTask>("lists.createTask", { listId, ...input }),
    addHeading: (listId: string, title: string) => core.invoke<ListItem>("lists.addHeading", { listId, title }),
    updateItem: (id: string, fields: { title?: string }) => core.invoke<ListItem>("lists.updateItem", { id, ...fields }),
    removeItem: (id: string) => core.invoke<{ ok: boolean }>("lists.removeItem", { id }),
    /** Persist a new top-to-bottom order for one list's items (drag-and-drop). */
    reorderItems: (listId: string, ids: string[]) => core.invoke<{ ok: boolean }>("lists.reorderItems", { listId, ids }),
    /** Ids of the lists a task appears in. */
    listIdsForTask: (taskId: string) => core.invoke<string[]>("lists.forTask", { taskId }),
  };
}

export type ListsApi = ReturnType<typeof listsApi>;
