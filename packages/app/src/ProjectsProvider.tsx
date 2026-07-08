import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Area,
  CreateAreaInput,
  CreateProjectInput,
  MemberEntityType,
  Project,
  ProjectMember,
  SidebarData,
  UpdateAreaInput,
  UpdateProjectInput,
} from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface ProjectsStore {
  sidebar: SidebarData;
  areas: Area[];
  projects: Project[];
  loading: boolean;
  createArea: (input: CreateAreaInput) => Promise<Area>;
  updateArea: (id: string, fields: UpdateAreaInput) => Promise<void>;
  deleteArea: (id: string) => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (id: string, fields: UpdateProjectInput) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Persist a new top-to-bottom order for the areas (drag-and-drop, PLAN §6.6). */
  reorderAreas: (ids: string[]) => Promise<void>;
  /** Persist a new order for one area's projects (drag-and-drop, PLAN §6.6). */
  reorderProjects: (areaId: string, ids: string[]) => Promise<void>;
  addMember: (projectId: string, entityType: MemberEntityType, entityId: string) => Promise<void>;
  /** Assign several entities to one project in a single core call (multiselect assign). */
  addMembers: (projectId: string, entityType: MemberEntityType, entityIds: string[]) => Promise<void>;
  removeMember: (projectId: string, entityType: MemberEntityType, entityId: string) => Promise<void>;
  membershipsFor: (entityType: MemberEntityType, entityId: string) => Promise<ProjectMember[]>;
  membershipsForProject: (projectId: string) => Promise<ProjectMember[]>;
}

const EMPTY_SIDEBAR: SidebarData = { areas: [], unsorted: [] };

const ProjectsCtx = createContext<ProjectsStore | null>(null);

/** Owns areas/projects/sidebar state (PLAN §6.6). Refreshes on `nav.changed` (local
 * area/project/membership edits) and on `data.changed` (a sync pull applied rows from
 * another device), and triggers a sync after every local mutation. */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { core, projects: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [sidebar, setSidebar] = useState<SidebarData>(EMPTY_SIDEBAR);
  const [areas, setAreas] = useState<Area[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextSidebar, nextAreas, nextProjects] = await Promise.all([api.sidebar(), api.listAreas(), api.listProjects()]);
    // Guard against nil slices marshalled as null from the core.
    setSidebar({ areas: nextSidebar.areas ?? [], unsorted: nextSidebar.unsorted ?? [] });
    setAreas(nextAreas ?? []);
    setProjects(nextProjects ?? []);
    setLoading(false);
  }, [api]);

  // Coalesce bursts of change events (e.g. a sync applying many rows) into one refresh.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offNav = core.on("nav.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    return () => {
      offNav();
      offData();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const createArea = useCallback(
    async (input: CreateAreaInput) => {
      const area = await api.createArea(input);
      await refresh();
      syncTrigger();
      return area;
    },
    [api, refresh, syncTrigger],
  );
  const updateArea = useCallback(
    async (id: string, fields: UpdateAreaInput) => {
      await api.updateArea(id, fields);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const deleteArea = useCallback(
    async (id: string) => {
      await api.deleteArea(id);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const createProject = useCallback(
    async (input: CreateProjectInput) => {
      const project = await api.createProject(input);
      await refresh();
      syncTrigger();
      return project;
    },
    [api, refresh, syncTrigger],
  );
  const updateProject = useCallback(
    async (id: string, fields: UpdateProjectInput) => {
      await api.updateProject(id, fields);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const deleteProject = useCallback(
    async (id: string) => {
      await api.deleteProject(id);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const reorderAreas = useCallback(
    async (ids: string[]) => {
      // Optimistic: reflect the new order immediately so the drop doesn't flash back.
      setSidebar((prev) => ({ ...prev, areas: reorderBy(prev.areas, ids, (a) => a.id) }));
      await api.reorderAreas(ids);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const reorderProjects = useCallback(
    async (areaId: string, ids: string[]) => {
      setSidebar((prev) => ({
        ...prev,
        areas: prev.areas.map((a) =>
          a.id === areaId ? { ...a, projects: reorderBy(a.projects, ids, (p) => p.id) } : a,
        ),
      }));
      await api.reorderProjects(areaId, ids);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const addMember = useCallback(
    async (projectId: string, entityType: MemberEntityType, entityId: string) => {
      await api.addMember(projectId, entityType, entityId);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const addMembers = useCallback(
    async (projectId: string, entityType: MemberEntityType, entityIds: string[]) => {
      if (entityIds.length === 0) return;
      await api.addMembers(projectId, entityType, entityIds);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const removeMember = useCallback(
    async (projectId: string, entityType: MemberEntityType, entityId: string) => {
      await api.removeMember(projectId, entityType, entityId);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const membershipsFor = useCallback(
    (entityType: MemberEntityType, entityId: string) => api.membershipsFor(entityType, entityId),
    [api],
  );
  const membershipsForProject = useCallback((projectId: string) => api.projectMembers(projectId), [api]);

  const value = useMemo<ProjectsStore>(
    () => ({
      sidebar,
      areas,
      projects,
      loading,
      createArea,
      updateArea,
      deleteArea,
      createProject,
      updateProject,
      deleteProject,
      reorderAreas,
      reorderProjects,
      addMember,
      addMembers,
      removeMember,
      membershipsFor,
      membershipsForProject,
    }),
    [sidebar, areas, projects, loading, createArea, updateArea, deleteArea, createProject, updateProject, deleteProject, reorderAreas, reorderProjects, addMember, addMembers, removeMember, membershipsFor, membershipsForProject],
  );

  return <ProjectsCtx.Provider value={value}>{children}</ProjectsCtx.Provider>;
}

export function useProjects(): ProjectsStore {
  const v = useContext(ProjectsCtx);
  if (!v) throw new Error("useProjects must be used within a ProjectsProvider");
  return v;
}

/** Reorders `items` to match the id sequence in `ids`; any items not named in `ids` keep
 *  their relative position at the end (defensive against a stale drag order). */
function reorderBy<T>(items: T[], ids: string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((it) => [idOf(it), it]));
  const ordered: T[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (it) {
      ordered.push(it);
      byId.delete(id);
    }
  }
  for (const it of items) if (byId.has(idOf(it))) ordered.push(it);
  return ordered;
}
