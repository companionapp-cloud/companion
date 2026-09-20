import { useEffect, useMemo, useState } from "react";
import type { Canvas, Note, ProjectMember, RepeatingTask, Task } from "@companion/core-bridge";
import type { ContainerRef } from "./nav-context";
import { useCore } from "./CoreContext";
import { useProjects } from "./ProjectsProvider";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useCanvases } from "./canvas/CanvasesProvider";

export interface ContainerContent {
  members: ProjectMember[];
  notes: Note[];
  /** Actionable member tasks. Repeating-task seeds are members too but live in `seeds`, shown
   *  in their own "Repeating" section — matching the root task list (§6.4). */
  tasks: Task[];
  seeds: RepeatingTask[];
  canvases: Canvas[];
  /** In an area: the name of the project each rolled-up item lives in, by entity id. Items
   *  filed directly in the area — and everything in a project's own page — have none. */
  projectOf: Map<string, string>;
}

/** What a project or an area holds, kept fresh as memberships change locally or via sync. An
 *  area's content is its whole tree — what is filed directly in it plus what its projects hold
 *  (PLAN-areas.md §3) — which is what its overview and its sections both show. */
export function useContainerContent(container: ContainerRef | null): ContainerContent {
  const { core } = useCore();
  const { projects, membershipsForProject, membershipsForArea } = useProjects();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const canvasesStore = useCanvases();
  const kind = container?.kind;
  const id = container?.id ?? "";

  const [members, setMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const fetch = () => (kind === "area" ? membershipsForArea(id, true) : membershipsForProject(id));
    const load = () => fetch().then((rows) => !cancelled && setMembers(rows ?? []));
    void load();
    const offNav = core.on("nav.changed", () => void load());
    const offData = core.on("data.changed", () => void load());
    return () => {
      cancelled = true;
      offNav();
      offData();
    };
  }, [kind, id, membershipsForProject, membershipsForArea, core]);

  const projectOf = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const out = new Map<string, string>();
    if (kind !== "area") return out;
    for (const m of members) {
      if (m.containerType !== "area") out.set(m.entityId, names.get(m.projectId) ?? "Project");
    }
    return out;
  }, [members, projects, kind]);

  const notes = useMemo(
    () => members.filter((m) => m.entityType === "note").map((m) => notesStore.byId(m.entityId)).filter((n): n is Note => !!n),
    [members, notesStore],
  );
  const taskMembers = useMemo(() => members.filter((m) => m.entityType === "task"), [members]);
  const tasks = useMemo(
    () => taskMembers.map((m) => tasksStore.byId(m.entityId)).filter((t): t is Task => !!t),
    [taskMembers, tasksStore],
  );
  const seeds = useMemo(
    () => taskMembers.map((m) => tasksStore.seedById(m.entityId)).filter((s): s is RepeatingTask => !!s),
    [taskMembers, tasksStore],
  );
  const canvases = useMemo(
    () => members.filter((m) => m.entityType === "canvas").map((m) => canvasesStore.byId(m.entityId)).filter((c): c is Canvas => !!c),
    [members, canvasesStore],
  );

  return { members, notes, tasks, seeds, canvases, projectOf };
}
