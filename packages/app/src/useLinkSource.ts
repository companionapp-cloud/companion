import { useMemo, useRef } from "react";
import type { LinkSource } from "@companion/editor";
import { useCore } from "./CoreContext";
import { useTasks } from "./TasksProvider";

/** The editor's wikilink `[[` autocomplete + pasted-UUID resolution, backed by the object
 * graph. A `[[task:…]]` lookup also carries the task's done state + dates (via the tasks
 * store) so its chip renders like a todo. Shared by the note editor, the task-note editor,
 * and the chat composer. Stable identity (reads tasks through a ref) so it never reloads the
 * editor when task data changes. */
export function useLinkSource(): LinkSource {
  const { graph } = useCore();
  const tasks = useTasks();
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  return useMemo<LinkSource>(
    () => ({
      search: async (q, type) =>
        (await graph.search(q, type)).map((n) => ({ type: n.type, id: n.id, title: n.title })),
      lookup: async (id) => {
        const n = await graph.lookup(id);
        if (!n) return null;
        const base = { type: n.type, id: n.id, title: n.title };
        if (n.type === "task") {
          const t = tasksRef.current.byId(id);
          if (t) return { ...base, status: t.status, dueAt: t.dueAt, remindAt: t.remindAt };
          return { ...base, status: n.status ?? null };
        }
        return base;
      },
    }),
    [graph],
  );
}
