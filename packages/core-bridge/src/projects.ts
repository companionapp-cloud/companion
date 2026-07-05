import type { Area, CoreBridge, Project, ProjectMember, SidebarData } from "./types";

export interface CreateAreaInput {
  name: string;
  color?: string | null;
  sortOrder?: number;
}
export interface UpdateAreaInput {
  name?: string;
  color?: string | null;
  sortOrder?: number;
}
export interface CreateProjectInput {
  areaId: string;
  name: string;
  color?: string | null;
  sortOrder?: number;
}
export interface UpdateProjectInput {
  areaId?: string;
  name?: string;
  color?: string | null;
  sortOrder?: number;
  archived?: boolean;
}

export type MemberEntityType = "note" | "task" | "habit";

/** Typed wrappers over the areas.* / projects.* / nav.* core methods (PLAN §6.6). */
export function projectsApi(core: CoreBridge) {
  return {
    // Areas
    listAreas: () => core.invoke<Area[]>("areas.list"),
    createArea: (input: CreateAreaInput) => core.invoke<Area>("areas.create", input),
    updateArea: (id: string, fields: UpdateAreaInput) => core.invoke<Area>("areas.update", { id, ...fields }),
    deleteArea: (id: string) => core.invoke<{ ok: boolean }>("areas.delete", { id }),
    /** Persist a new top-to-bottom order for the areas (drag-and-drop). */
    reorderAreas: (ids: string[]) => core.invoke<{ ok: boolean }>("areas.reorder", { ids }),

    // Projects
    listProjects: () => core.invoke<Project[]>("projects.list"),
    createProject: (input: CreateProjectInput) => core.invoke<Project>("projects.create", input),
    updateProject: (id: string, fields: UpdateProjectInput) => core.invoke<Project>("projects.update", { id, ...fields }),
    deleteProject: (id: string) => core.invoke<{ ok: boolean }>("projects.delete", { id }),
    /** Persist a new order for a single area's projects (drag-and-drop). */
    reorderProjects: (areaId: string, ids: string[]) => core.invoke<{ ok: boolean }>("projects.reorder", { areaId, ids }),

    // Membership (editable from either end)
    addMember: (projectId: string, entityType: MemberEntityType, entityId: string) =>
      core.invoke<ProjectMember>("projects.addMember", { projectId, entityType, entityId }),
    removeMember: (projectId: string, entityType: MemberEntityType, entityId: string) =>
      core.invoke<{ ok: boolean }>("projects.removeMember", { projectId, entityType, entityId }),
    projectMembers: (projectId: string) => core.invoke<ProjectMember[]>("projects.members", { projectId }),
    membershipsFor: (entityType: MemberEntityType, entityId: string) =>
      core.invoke<ProjectMember[]>("projects.forEntity", { entityType, entityId }),

    // Sidebar (area headings + project indicators, computed in core)
    sidebar: () => core.invoke<SidebarData>("nav.sidebar"),
  };
}

export type ProjectsApi = ReturnType<typeof projectsApi>;
