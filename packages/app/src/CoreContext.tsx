import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  graphApi,
  notesApi,
  projectsApi,
  trashApi,
  type CoreBridge,
  type GraphApi,
  type NotesApi,
  type ProjectsApi,
  type TrashApi,
} from "@companion/core-bridge";

interface CoreValue {
  core: CoreBridge;
  notes: NotesApi;
  graph: GraphApi;
  projects: ProjectsApi;
  trash: TrashApi;
}

const CoreCtx = createContext<CoreValue | null>(null);

/** CoreProvider makes a platform-supplied CoreBridge available to the UI tree. */
export function CoreProvider({ core, children }: { core: CoreBridge; children: ReactNode }) {
  const value = useMemo<CoreValue>(
    () => ({ core, notes: notesApi(core), graph: graphApi(core), projects: projectsApi(core), trash: trashApi(core) }),
    [core],
  );
  return <CoreCtx.Provider value={value}>{children}</CoreCtx.Provider>;
}

export function useCore(): CoreValue {
  const v = useContext(CoreCtx);
  if (!v) throw new Error("useCore must be used within a CoreProvider");
  return v;
}
