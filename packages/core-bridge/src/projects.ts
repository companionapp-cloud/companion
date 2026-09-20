import type { Area, CoreBridge, Project, ProjectMember, SidebarData } from "./types";

/** An area's or a project's page (PLAN-areas.md §1). On update, an empty `icon` or
 *  `coverDocumentId` clears it. */
export interface PageFields {
  icon?: string;
  coverDocumentId?: string;
  descriptionMd?: string;
}
export interface CreateAreaInput extends PageFields {
  name: string;
  color?: string | null;
  sortOrder?: number;
}
export interface UpdateAreaInput extends PageFields {
  name?: string;
  color?: string | null;
  sortOrder?: number;
}
export interface CreateProjectInput extends PageFields {
  areaId: string;
  name: string;
  color?: string | null;
  sortOrder?: number;
}
export interface UpdateProjectInput extends PageFields {
  areaId?: string;
  name?: string;
  color?: string | null;
  sortOrder?: number;
  archived?: boolean;
  /** Scheduling (PLAN-scheduling.md §2), with the task conventions: ISO timestamps to set, or
   *  clearStartAt / clearDueAt to remove them; Someday and a start exclude each other. */
  startAt?: string | null;
  clearStartAt?: boolean;
  dueAt?: string | null;
  clearDueAt?: boolean;
  someday?: boolean;
  /** Complete (true) or reopen (false) the project. With `completeTasks`, completing also
   *  finishes every task still open in it. */
  completed?: boolean;
  completeTasks?: boolean;
  /** Set one kind of repeat — an RRULE schedule, or an after-completion interval ("P3D",
   *  "P2W", "P1M", "P1Y") — which replaces the other; clearRepeat stops it repeating. */
  repeatRule?: string | null;
  repeatAfter?: string | null;
  clearRepeat?: boolean;
}

/** What a project can hold (PLAN §6.6): content, and calendars — one calendar (a CalDAV calendar
 *  or an ICS subscription, by feed id) or a whole account (every calendar it has, by account id). */
export type MemberEntityType = "note" | "task" | "habit" | "canvas" | "calendar" | "calendar_account";

/** What an area holds directly (PLAN-areas.md §2): notes, tasks and canvases — never lists or
 *  calendars. */
export type AreaMemberEntityType = "note" | "task" | "canvas";

/** Typed wrappers over the areas.* / projects.* / nav.* core methods (PLAN §6.6). */
export function projectsApi(core: CoreBridge) {
  return {
    // Areas
    listAreas: () => core.invoke<Area[]>("areas.list"),
    createArea: (input: CreateAreaInput) => core.invoke<Area>("areas.create", input),
    updateArea: (id: string, fields: UpdateAreaInput) => core.invoke<Area>("areas.update", { id, ...fields }),
    /** Delete an area (only once it has no projects). When `deleteContent` is true the notes and
     *  tasks filed directly in it are trashed too; otherwise they fall back to "Unsorted". */
    deleteArea: (id: string, deleteContent = false) =>
      core.invoke<{ ok: boolean }>("areas.delete", { id, deleteContent }),
    /** Persist a new top-to-bottom order for the areas (drag-and-drop). */
    reorderAreas: (ids: string[]) => core.invoke<{ ok: boolean }>("areas.reorder", { ids }),

    // Projects
    listProjects: () => core.invoke<Project[]>("projects.list"),
    createProject: (input: CreateProjectInput) => core.invoke<Project>("projects.create", input),
    updateProject: (id: string, fields: UpdateProjectInput) => core.invoke<Project>("projects.update", { id, ...fields }),
    /** Delete a project. When `deleteContent` is true its member notes/tasks are trashed too;
     *  otherwise they fall back to "Unsorted" (PLAN §6.6). */
    deleteProject: (id: string, deleteContent = false) =>
      core.invoke<{ ok: boolean }>("projects.delete", { id, deleteContent }),
    /** Persist a new order for a single area's projects (drag-and-drop). */
    reorderProjects: (areaId: string, ids: string[]) => core.invoke<{ ok: boolean }>("projects.reorder", { areaId, ids }),

    // Membership (editable from either end). Content lives in ONE place — a project or an
    // area — so adding a note/task/habit/canvas MOVES it out of wherever it was filed
    // (PLAN-areas.md §2.1). Calendars can still sit in several projects.
    addMember: (projectId: string, entityType: MemberEntityType, entityId: string) =>
      core.invoke<ProjectMember>("projects.addMember", { projectId, entityType, entityId }),
    /** Assign several entities to one project in a single call (multiselect assign). */
    addMembers: (projectId: string, entityType: MemberEntityType, entityIds: string[]) =>
      core.invoke<ProjectMember[]>("projects.addMembers", { projectId, entityType, entityIds }),
    removeMember: (projectId: string, entityType: MemberEntityType, entityId: string) =>
      core.invoke<{ ok: boolean }>("projects.removeMember", { projectId, entityType, entityId }),
    projectMembers: (projectId: string) => core.invoke<ProjectMember[]>("projects.members", { projectId }),
    membershipsFor: (entityType: MemberEntityType, entityId: string) =>
      core.invoke<ProjectMember[]>("projects.forEntity", { entityType, entityId }),
    // Content filed directly in an area (PLAN-areas.md §2).
    addAreaMember: (areaId: string, entityType: AreaMemberEntityType, entityId: string) =>
      core.invoke<ProjectMember>("areas.addMember", { areaId, entityType, entityId }),
    addAreaMembers: (areaId: string, entityType: AreaMemberEntityType, entityIds: string[]) =>
      core.invoke<ProjectMember[]>("areas.addMembers", { areaId, entityType, entityIds }),
    removeAreaMember: (areaId: string, entityType: AreaMemberEntityType, entityId: string) =>
      core.invoke<{ ok: boolean }>("areas.removeMember", { areaId, entityType, entityId }),
    /** What is filed directly in an area — or, with `tree`, that plus the content of every
     *  project in it (what the area's overview rolls up). */
    areaMembers: (areaId: string, tree = false) =>
      core.invoke<ProjectMember[]>("areas.members", { areaId, tree }),
    /** Ids of entities of a type that are filed somewhere (a project or an area) — the "sorted" set the browse
     *  lists subtract to offer "Unsorted" vs "All" (PLAN §6.6). */
    memberEntityIds: (entityType: MemberEntityType) =>
      core.invoke<string[]>("projects.memberEntityIds", { entityType }),
    /** Ids of the tasks filed in a Someday project: filed away with it, so the task lists show
     *  them only under the Someday filter (PLAN-scheduling.md §1). */
    somedayTaskIds: () => core.invoke<string[]>("projects.somedayTaskIds"),

    // Sidebar (area headings + project indicators, computed in core)
    sidebar: () => core.invoke<SidebarData>("nav.sidebar"),
  };
}

export type ProjectsApi = ReturnType<typeof projectsApi>;
