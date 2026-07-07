import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  chatsApi,
  datesApi,
  graphApi,
  llmApi,
  notesApi,
  notifyApi,
  objectTypesApi,
  projectsApi,
  tasksApi,
  trashApi,
  type ChatsApi,
  type CoreBridge,
  type DatesApi,
  type GraphApi,
  type LlmApi,
  type NotesApi,
  type NotifyApi,
  type ObjectTypesApi,
  type ProjectsApi,
  type TasksApi,
  type TrashApi,
} from "@companion/core-bridge";

interface CoreValue {
  core: CoreBridge;
  notes: NotesApi;
  tasks: TasksApi;
  graph: GraphApi;
  projects: ProjectsApi;
  objectTypes: ObjectTypesApi;
  trash: TrashApi;
  notify: NotifyApi;
  dates: DatesApi;
  llm: LlmApi;
  chats: ChatsApi;
}

const CoreCtx = createContext<CoreValue | null>(null);

/** CoreProvider makes a platform-supplied CoreBridge available to the UI tree. */
export function CoreProvider({ core, children }: { core: CoreBridge; children: ReactNode }) {
  const value = useMemo<CoreValue>(
    () => ({
      core,
      notes: notesApi(core),
      tasks: tasksApi(core),
      graph: graphApi(core),
      projects: projectsApi(core),
      objectTypes: objectTypesApi(core),
      trash: trashApi(core),
      notify: notifyApi(core),
      dates: datesApi(core),
      llm: llmApi(core),
      chats: chatsApi(core),
    }),
    [core],
  );
  return <CoreCtx.Provider value={value}>{children}</CoreCtx.Provider>;
}

export function useCore(): CoreValue {
  const v = useContext(CoreCtx);
  if (!v) throw new Error("useCore must be used within a CoreProvider");
  return v;
}
