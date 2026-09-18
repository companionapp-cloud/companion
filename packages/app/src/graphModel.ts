import { colors } from "@companion/design-system";
import type { Graph } from "@companion/core-bridge";

// Pure, UI-free graph helpers shared by the React Flow renderer (GraphView.web) and its
// settings menu (GraphMenu.web): node keys, per-type colors, the tunable force-simulation
// parameters, and the show/hide filters. Kept free of React and DOM so it's trivially
// testable and safe to import from either side without a circular dependency.

/** React Flow's node id: a composite so a note and a task can never collide. */
export const nodeKey = (type: string, id: string) => `${type}:${id}`;

/** Accent color per entity type. Ghosts (unresolved targets) render muted elsewhere. */
export function typeColor(type: string): string {
  switch (type) {
    case "note":
      return colors.success;
    case "task":
      return colors.info;
    case "habit":
      return colors.success;
    case "project":
      return colors.accent;
    case "document":
      return colors.textTertiary;
    case "canvas":
      return colors.warning;
    default:
      return colors.textSecondary;
  }
}

// ── Physics ──────────────────────────────────────────────────────────────────────────────
// The user-tunable force-simulation knobs (Obsidian's "Forces" sliders). Each maps onto one
// d3-force parameter in GraphView's useForceLayout:
//   centerForce  — the gentle pull toward the origin (forceX/forceY strength) that keeps
//                  disconnected bits in frame.
//   repelForce   — how hard every node shoves every other apart (|forceManyBody strength|);
//                  this is what spreads the graph out instead of collapsing it to a point.
//                  Halved automatically on large graphs so a thousand-node vault doesn't
//                  explode off-screen.
//   linkForce    — spring stiffness of each link (forceLink strength): how firmly linked
//                  nodes stay pulled together against the repulsion.
//   linkDistance — a spring's resting length, the preferred gap between two linked nodes.
//   nodeSpacing  — extra padding added to each node's radius for collision (forceCollide)
//                  so circles don't overlap.
// Defaults are scaled for our 32–72px circles, not d3's unit nodes: short stiff springs plus
// strong long-range charge, so clusters read as tight knots separated by real gaps.
export interface GraphPhysics {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  nodeSpacing: number;
}

export const DEFAULT_PHYSICS: GraphPhysics = {
  centerForce: 0.05,
  repelForce: 2400,
  linkForce: 0.9,
  linkDistance: 30,
  nodeSpacing: 22,
};

export interface PhysicsSlider {
  key: keyof GraphPhysics;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** Slider definitions, in display order. Ranges bracket the defaults generously enough to
 * go from a collapsed blob to a widely scattered field. */
export const PHYSICS_SLIDERS: PhysicsSlider[] = [
  { key: "centerForce", label: "Center force", min: 0, max: 0.5, step: 0.01 },
  { key: "repelForce", label: "Repel force", min: 0, max: 6000, step: 50 },
  { key: "linkForce", label: "Link force", min: 0, max: 1, step: 0.05 },
  { key: "linkDistance", label: "Link distance", min: 0, max: 300, step: 5 },
  { key: "nodeSpacing", label: "Node spacing", min: 0, max: 80, step: 1 },
];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Coerce an untrusted (persisted) value into a valid physics object: unknown or
 * non-numeric fields fall back to the default, numbers are clamped to the slider range. */
export function sanitizePhysics(raw: unknown): GraphPhysics {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PHYSICS };
  for (const s of PHYSICS_SLIDERS) {
    const v = src[s.key];
    if (typeof v === "number" && Number.isFinite(v)) out[s.key] = clamp(v, s.min, s.max);
  }
  return out;
}

export function isDefaultPhysics(p: GraphPhysics): boolean {
  return PHYSICS_SLIDERS.every((s) => p[s.key] === DEFAULT_PHYSICS[s.key]);
}

// ── Filters ──────────────────────────────────────────────────────────────────────────────
// Which nodes the graph shows. Hidden nodes take their edges with them; a node whose only
// connection was to a hidden node simply becomes an orphan.
export interface GraphFilters {
  /** Show notes. */
  notes: boolean;
  /** Show tasks that are still open ("Incomplete"). */
  tasksOpen: boolean;
  /** Show tasks that are done ("Complete"). */
  tasksDone: boolean;
  /** Show files (documents). */
  files: boolean;
  /** Show canvas boards (PLAN-canvases.md). */
  canvases: boolean;
  /** Ids of projects that are hidden — the project node itself and everything that is a
   * member of it (unless that member also belongs to a visible project). Stored as the
   * hidden set, not the visible one, so newly created projects default to visible. */
  hiddenProjects: string[];
  /** Show nodes that belong to no project at all. */
  unassigned: boolean;
}

export const DEFAULT_FILTERS: GraphFilters = {
  notes: true,
  tasksOpen: true,
  tasksDone: true,
  files: true,
  canvases: true,
  hiddenProjects: [],
  unassigned: true,
};

/** Coerce an untrusted (persisted) value into a valid filters object. */
export function sanitizeFilters(raw: unknown): GraphFilters {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof GraphFilters) => (typeof src[k] === "boolean" ? (src[k] as boolean) : DEFAULT_FILTERS[k] as boolean);
  const hidden = Array.isArray(src.hiddenProjects) ? src.hiddenProjects.filter((x): x is string => typeof x === "string") : [];
  return {
    notes: bool("notes"),
    tasksOpen: bool("tasksOpen"),
    tasksDone: bool("tasksDone"),
    files: bool("files"),
    canvases: bool("canvases"),
    hiddenProjects: hidden,
    unassigned: bool("unassigned"),
  };
}

export function isDefaultFilters(f: GraphFilters): boolean {
  return f.notes && f.tasksOpen && f.tasksDone && f.files && f.canvases && f.unassigned && f.hiddenProjects.length === 0;
}

/** A task counts as complete when its status is the core's terminal "done"; anything else
 * (open, or a status we don't know) is treated as still in progress. */
const TASK_DONE = "done";

/** Apply the show/hide filters: drop hidden nodes and any edge touching one. Endpoints with
 * no node (ghosts, synthesized later by the renderer) are filtered by their type alone. The
 * focus node, when set, is always kept — it's the thing the view is about. Returns the
 * input graph untouched when every filter is at its default, for referential stability. */
export function applyGraphFilters(graph: Graph, filters: GraphFilters, focusKey: string | null = null): Graph {
  if (isDefaultFilters(filters)) return graph;

  const hiddenProjects = new Set(filters.hiddenProjects);
  const byKey = new Map(graph.nodes.map((n) => [nodeKey(n.type, n.id), n]));

  // Project membership: node key → the projects it belongs to (mirrored from
  // project_members as "member" edges, project → member).
  const projectsOf = new Map<string, string[]>();
  const addProject = (key: string, projectId: string) => {
    const list = projectsOf.get(key);
    if (list) list.push(projectId);
    else projectsOf.set(key, [projectId]);
  };
  for (const e of graph.edges) {
    if (e.kind === "member" && e.sourceType === "project") addProject(nodeKey(e.targetType, e.targetId), e.sourceId);
  }
  // Files aren't project members themselves; they inherit the projects of whatever embeds
  // or references them, so scoping the graph to one project keeps that project's files.
  for (const e of graph.edges) {
    if (e.targetType !== "document") continue;
    const inherited = projectsOf.get(nodeKey(e.sourceType, e.sourceId));
    if (!inherited) continue;
    for (const p of inherited) addProject(nodeKey(e.targetType, e.targetId), p);
  }

  const inVisibleProject = (key: string): boolean => {
    const projects = projectsOf.get(key);
    if (!projects || projects.length === 0) return filters.unassigned;
    return projects.some((p) => !hiddenProjects.has(p));
  };

  const visible = (type: string, id: string): boolean => {
    const key = nodeKey(type, id);
    if (key === focusKey) return true;
    switch (type) {
      case "note":
        if (!filters.notes) return false;
        break;
      case "task": {
        const done = byKey.get(key)?.status === TASK_DONE;
        if (done ? !filters.tasksDone : !filters.tasksOpen) return false;
        break;
      }
      case "document":
        if (!filters.files) return false;
        break;
      case "canvas":
        if (!filters.canvases) return false;
        break;
      case "project":
        // A project is scoped by its own toggle, never by membership.
        return !hiddenProjects.has(id);
    }
    return inVisibleProject(key);
  };

  return {
    nodes: graph.nodes.filter((n) => visible(n.type, n.id)),
    edges: graph.edges.filter((e) => visible(e.sourceType, e.sourceId) && visible(e.targetType, e.targetId)),
  };
}
