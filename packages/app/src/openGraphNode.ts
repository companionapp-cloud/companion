import { useCallback, useContext } from "react";
import type { MemberEntityType, Note, Project, ProjectMember } from "@companion/core-bridge";
import { NavContext, type AreaSection, type TabRef } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useProjects } from "./ProjectsProvider";

// Where following a node out of the graph lands. An item opens where it lives, not as a
// loose document: a daily note in the daily-notes view on its day, and a note, task or
// canvas that belongs to a project (or is filed in an area) inside that project's or
// area's view with the item selected.
// Anything else opens as a plain document. The answer is a TabRef (what a tab holds), so
// each shell maps it onto its own navigation: the active tab on desktop, a pushed route on
// mobile.

/** The project section each member kind is listed in. */
const PROJECT_SECTION: Record<"note" | "task" | "canvas", AreaSection> = { note: "notes", task: "tasks", canvas: "canvases" };

export interface GraphNodeLookups {
  /** A loaded note, for its `date` (a dated note is a daily note). */
  note: (id: string) => Note | undefined;
  /** An entity's project memberships. */
  memberships: (entityType: MemberEntityType, entityId: string) => Promise<ProjectMember[]>;
  /** Every project; archived ones are skipped (the graph hides them too). */
  projects: Project[];
  /** The project already on screen, preferred when the item belongs to several. */
  currentProjectId?: string;
}

/** The surface a graph node opens on, or null for nodes with no surface of their own
 *  (files, habits). */
export async function graphNodeRef(type: string, id: string, lookups: GraphNodeLookups): Promise<TabRef | null> {
  if (type === "project") return { kind: "project", projectId: id };
  if (type !== "note" && type !== "task" && type !== "canvas") return null;
  // A daily note's home is its day, even when it is also filed in a project.
  const date = type === "note" ? lookups.note(id)?.date : null;
  if (date) return { kind: "view", view: "today", date };
  const members = await lookups.memberships(type, id).catch(() => [] as ProjectMember[]);
  const open = new Set(lookups.projects.filter((p) => !p.archivedAt).map((p) => p.id));
  const projectIds = members.map((m) => m.projectId).filter((pid) => open.has(pid));
  const projectId = projectIds.find((pid) => pid === lookups.currentProjectId) ?? projectIds[0];
  if (projectId) return { kind: "project", projectId, section: PROJECT_SECTION[type], itemId: id };
  // Filed directly in an area (PLAN-areas.md §2): it opens in the area's page.
  const inArea = members.find((m) => m.containerType === "area");
  if (inArea) return { kind: "area", areaId: inArea.projectId, section: PROJECT_SECTION[type], itemId: id };
  return { kind: type, id };
}

/** graphNodeRef bound to the live notes and projects. Prefers the project the caller's tab
 *  is showing, when it renders inside the app navigator. */
export function useGraphNodeRef(): (type: string, id: string) => Promise<TabRef | null> {
  const { byId } = useNotes();
  const { projects, membershipsFor } = useProjects();
  const loc = useContext(NavContext)?.current;
  const currentProjectId = loc?.kind === "project" ? loc.projectId : undefined;
  return useCallback(
    (type: string, id: string) => graphNodeRef(type, id, { note: byId, memberships: membershipsFor, projects, currentProjectId }),
    [byId, membershipsFor, projects, currentProjectId],
  );
}

/** A graph's node-open handler: resolves where the node lives, then points the tab there.
 *  Undefined outside the app navigator (the focus window), where nodes can be inspected
 *  but not opened. */
export function useOpenGraphNode(): ((type: string, id: string) => void) | undefined {
  const nav = useContext(NavContext);
  const resolve = useGraphNodeRef();
  const open = useCallback(
    (type: string, id: string) => {
      void resolve(type, id).then((ref) => {
        if (ref) nav?.openRef(ref);
      });
    },
    [nav, resolve],
  );
  return nav ? open : undefined;
}
