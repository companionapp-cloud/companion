import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Icon, colors, control, font, layout, motion, radius, space, useTheme, type IconName } from "@companion/design-system";
import type { Graph, GraphNode } from "@companion/core-bridge";
import { DEFAULT_PHYSICS, applyGraphFilters, nodeKey, typeColor, type GraphPhysics } from "./graphModel";
import { GRAPH_CHROME_CSS, GraphMenu, useGraphSettings } from "./GraphMenu.web";
import { FindPalette, type FindItem } from "./FindPalette";
import { NavContext } from "./nav-context";

export { nodeKey };

/** How a node open is dispatched. Decoupled from useNav() so the same renderer works in
 * the app (useOpenGraphNode) and inside the mobile graph WebView (postMessage). */
export type OpenNodeHandler = (type: string, id: string, newTab: boolean) => void;
const GraphOpenContext = createContext<OpenNodeHandler>(() => {});
/** Node types with a surface to open. Files and habits have none yet. */
const OPENABLE_TYPES = new Set(["note", "task", "canvas", "project"]);

/** Report which node the pointer is over (its key, or null on leave) up to GraphCanvas so
 * the edge layers can highlight that node's connections. */
const GraphHoverContext = createContext<(id: string | null) => void>(() => {});

/** What a tap/click on a node reports to the host — every node kind, ghosts included. */
export interface GraphSelection {
  /** The node's composite key (`nodeKey(type, id)`), the same value `selectedKey` takes. */
  key: string;
  type: string;
  id: string;
  label: string;
  /** Undirected connection count within the graph as currently filtered. */
  degree: number;
  ghost: boolean;
}
export type SelectNodeHandler = (node: GraphSelection | null) => void;

/** Selection plumbing for the node renderer: the host's handler, the key it wants drawn as
 * selected, and whether the pointer is coarse (no hover on phones, so no hover popup). */
const GraphSelectContext = createContext<{ onSelect: SelectNodeHandler | null; selectedKey: string | null; coarse: boolean }>({
  onSelect: null,
  selectedKey: null,
  coarse: false,
});

/** Whether the primary pointer is coarse (a finger). Live, for convertibles. */
function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
    if (!mq) return;
    const on = () => setCoarse(mq.matches);
    on();
    // Safari < 14 only has the deprecated addListener.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, []);
  return coarse;
}

// The React Flow renderer shared by the full knowledgebase graph (GraphScreen) and the
// per-note neighborhood (NoteGraph). React Flow is DOM-only, so this whole module is
// web/desktop only; native wrappers show a placeholder. The core hands us
// ids/titles/edges only — layout, sizing, and ghost synthesis happen here. Nodes render
// as circles whose size grows with their connection count; hovering one reveals a popup
// with its title and a chevron that opens the item.
//
// Layout is a live force-directed simulation (d3-force), the same model as Obsidian's
// graph: every node repels every other (charge), links act as springs pulling connected
// notes together (link force + resting distance), and a gentle pull toward the origin
// keeps orphans from drifting off. Positions are an emergent equilibrium the sim relaxes
// into over a few hundred ticks and then damps to rest; dragging a node or changing the
// graph re-heats it. There are no fixed coordinates — densely linked notes settle into
// tight clusters, hubs land in the middle of their neighborhood, and sparsely linked
// notes get pushed to the edges.

type GhostAware = GraphNode & { ghost?: boolean };

/** Per-node data carried into the custom circle renderer. */
interface CircleData extends Record<string, unknown> {
  entityType: string;
  entityId: string;
  /** Archetype id (PLAN §6.3); when set, the node is colored by type so archetyped nodes
   *  cluster visually by color in the graph (PLAN §5.3). */
  objectTypeId: string | null;
  /** The archetype's chosen color / icon, resolved upstream (useStyledGraph). When present
   *  they override the palette color and the entity-type icon so objects render distinctly. */
  objectColor: string | null;
  objectIcon: string | null;
  label: string;
  ghost: boolean;
  focus: boolean;
  size: number;
  /** Undirected connection count — sizes the node and ranks it when the render budget
   * forces a choice. */
  degree: number;
}
type CircleNode = Node<CircleData, "circle">;

const MIN_SIZE = 32;
const MAX_SIZE = 72;
const FOCUS_MIN_SIZE = 52;

// ── Force-simulation knobs ──────────────────────────────────────────────────────────────
// The user-tunable forces (link distance/strength, charge, centering, collision padding)
// live in GraphPhysics (graphModel.ts) and are driven from the graph menu's sliders; only
// the fixed knobs remain here.
// CHARGE_DISTANCE_MAX — cap the repulsion range so far-apart nodes stop pushing (keeps
//   clusters coherent and the Barnes-Hut sum cheap).
// LARGE_CHARGE_SCALE — the repulsion is halved on big graphs so a thousand-node vault
//   doesn't explode off-screen.
// SEED_SPREAD — radius scale for the deterministic phyllotaxis seed the sim relaxes from.
const CHARGE_DISTANCE_MAX = 2400;
const CHARGE_DISTANCE_MAX_LARGE = 1600;
const LARGE_CHARGE_SCALE = 0.5;
const SEED_SPREAD = 90;
// Golden angle (~137.5°) — used only to seed initial positions in a spiral so the sim
// starts from an evenly-spread, deterministic state rather than a random pile.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Above this total node count the canvas is treated as "large": edges render in their
// cheap form (straight, no animation, no invisible interaction path) and node culling
// (onlyRenderVisibleElements) is enabled, so a big knowledgebase never mounts all its DOM
// at once. A 1000-node graph otherwise crashes the mobile WebView.
const LARGE_GRAPH_THRESHOLD = 250;

// Level-of-detail gate for large graphs. React Flow is DOM-based and bogs down / crashes the
// tab past a few hundred simultaneous interactive nodes, so on a large graph we mount NO
// interactive DOM nodes while the view is zoomed out — the canvas base layer draws the whole
// graph as dots + lines instead. Only once the user has zoomed in far enough that this many
// or fewer nodes fall within the viewport do those visible nodes get mounted as real,
// interactive cards. Zoom in → the viewport shrinks → the visible count drops below the
// limit → interactivity appears; zoom out → it hands back to the canvas overview. Kept
// comfortably under React Flow's DOM ceiling so the mounted set is always safe to render.
const INTERACTIVE_VISIBLE_LIMIT = 200;

// The viewport is padded by this fraction on each side when selecting nodes to render, so a
// little is preloaded beyond the edges and panning doesn't immediately reveal blank space.
const VIEWPORT_MARGIN = 0.15;

// Styles are declared up front (before the components that reference them) so module
// evaluation never hits a not-yet-initialized const — the desktop webview's JS engine
// enforces the temporal dead zone more strictly than the web dev server.
const handleStyle: CSSProperties = {
  opacity: 0,
  top: "50%",
  left: "50%",
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: "none",
};

// The hover popup floats above the canvas, so it is the one piece of node chrome with a
// shadow: overlay surface, hairline, 6px radius, the menu shadow.
const popupStyle: CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  gap: space.xs,
  maxWidth: 240,
  height: control.md,
  padding: `0 ${space.sm}px 0 ${space.md}px`,
  borderRadius: radius.lg,
  background: colors.surfaceOverlay,
  border: `1px solid ${colors.borderSubtle}`,
  boxShadow: "0 4px 12px rgba(17,17,16,0.1)",
  cursor: "pointer",
  fontFamily: font.sans,
};

const popupLabelStyle: CSSProperties = {
  fontSize: font.size.sm,
  fontWeight: font.weight.medium,
  color: colors.textPrimary,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// A persistent caption under each node — mobile has no hover, so the title has to show in
// the view. Capped so long titles don't sprawl across the canvas. pointerEvents:none so it
// never intercepts taps or panning.
const LABEL_MAX = 65;
const truncateLabel = (s: string) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) + "…" : s);

const nodeLabelStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 3px)",
  left: "50%",
  transform: "translateX(-50%)",
  width: 132,
  textAlign: "center",
  fontFamily: font.sans,
  fontSize: font.size.xs,
  lineHeight: "13px",
  color: colors.textSecondary,
  overflowWrap: "break-word",
  pointerEvents: "none",
};

const fillStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  display: "flex",
  flexDirection: "column",
  background: colors.surfaceCard,
  fontFamily: font.sans,
};

// The 28px sub-toolbar above the whole-knowledgebase graph (counts, fit, settings) and the
// 22px mono legend beneath it. Per-note neighborhoods (no menu) get neither.
const toolbarStyle: CSSProperties = {
  position: "relative",
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: space.xxs,
  // A minimum, so the coarse-pointer button size (GRAPH_CHROME_CSS) can grow the strip.
  minHeight: layout.subToolbarH,
  flexShrink: 0,
  boxSizing: "border-box",
  padding: `0 ${space.sm}px 0 ${space.ml}px`,
  borderBottom: `1px solid ${colors.borderSubtle}`,
};

const legendStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space.ml,
  height: layout.statusbarH,
  flexShrink: 0,
  boxSizing: "border-box",
  padding: `0 ${space.ml}px`,
  borderTop: `1px solid ${colors.borderSubtle}`,
  background: colors.surfaceApp,
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const monoStyle: CSSProperties = {
  fontFamily: font.mono,
  fontSize: font.size.xs,
  color: colors.textQuaternary,
  whiteSpace: "nowrap",
};

const canvasFillStyle: CSSProperties = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 };

// The legend strip: one ring per entity type, in its typeColor.
const LEGEND: [string, string][] = [
  ["note", "notes"],
  ["task", "tasks"],
  ["canvas", "canvases"],
  ["project", "projects"],
  ["document", "files"],
];

// React Flow's own chrome (zoom controls, edge labels), re-pointed at the tokens through its
// --xy-* custom properties: flat, hairlined, no shadow.
const GRAPH_FLOW_CSS = `
.graph-flow.react-flow { --xy-background-color: transparent; --xy-edge-stroke: ${colors.borderStrong}; --xy-edge-label-background-color: ${colors.surfaceCard}; --xy-edge-label-color: ${colors.textTertiary}; --xy-controls-box-shadow: none; --xy-controls-button-background-color: ${colors.surfaceCard}; --xy-controls-button-background-color-hover: ${colors.surfaceHover}; --xy-controls-button-color: ${colors.textSecondary}; --xy-controls-button-color-hover: ${colors.textSecondary}; --xy-controls-button-border-color: ${colors.borderSubtle}; }
.graph-flow .react-flow__controls { border: 1px solid ${colors.borderSubtle}; border-radius: ${radius.md}px; overflow: hidden; }
.graph-flow .react-flow__controls-button { width: ${control.sm}px; height: ${control.sm}px; padding: 0; transition: background-color ${motion.instant}ms ${motion.ease}; }
.graph-flow .react-flow__controls-button:active { background: ${colors.surfaceActive}; }
.graph-flow .react-flow__controls-button svg { max-width: 10px; max-height: 10px; }
.graph-flow .react-flow__edge-text { font-family: ${font.mono}; }
`;

export const graphEmptyStyle: CSSProperties = {
  ...fillStyle,
  display: "flex",
  alignItems: "center",
  flexDirection: "row",
  justifyContent: "center",
  padding: space.xxl,
};

export const graphCodeStyle: CSSProperties = {
  fontFamily: font.mono,
  fontSize: font.size.xs,
  background: colors.surfaceCode,
  border: `1px solid ${colors.borderSubtle}`,
  padding: "0 4px",
  borderRadius: radius.xs,
};

// Icon per node type (the accent color per type is typeColor in graphModel.ts). Ghosts
// (unresolved targets) render muted.
const TYPE_ICON: Record<string, IconName> = {
  note: "notes",
  task: "tasks",
  habit: "dot",
  project: "folder",
  document: "file",
  canvas: "canvas",
};

// A small categorical palette for archetypes: nodes sharing an object type get the same
// color, so archetyped nodes read as a cluster in the graph (PLAN §5.3). Keyed by a stable
// hash of the type id so the mapping is deterministic without a lookup table.
const OBJECT_TYPE_PALETTE = ["#8b5cf6", "#ec4899", "#f59e0b", "#14b8a6", "#6366f1", "#ef4444", "#10b981", "#eab308"];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The node fill: an archetype's own chosen color wins; otherwise archetyped nodes fall
 *  back to a stable palette color keyed on the type (still clustering by type), and plain
 *  nodes use their entity-type color. */
function nodeColor(entityType: string, objectTypeId: string | null, objectColor?: string | null): string {
  if (objectColor) return objectColor;
  if (objectTypeId) return OBJECT_TYPE_PALETTE[hashString(objectTypeId) % OBJECT_TYPE_PALETTE.length];
  return typeColor(entityType);
}

// On web a colour role is a CSS `var(--c-…)` string. That is fine for DOM styles and SVG
// attributes, but a 2D canvas context can't parse it — so the base layer resolves each role
// to the literal the active theme currently gives it. Literal colours (archetype swatches)
// pass straight through. Read per paint, so a theme switch just needs a repaint.
function resolveCanvasColor(color: string, root: CSSStyleDeclaration): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  if (!m) return color;
  return root.getPropertyValue(m[1]).trim() || "#888";
}

/** Build the render node set: real nodes plus ghosts synthesized from any edge endpoint
 * that has no node (a link to something not yet created or synced — PLAN §5.1). */
function withGhosts(graph: Graph): GhostAware[] {
  const byKey = new Map<string, GhostAware>();
  for (const n of graph.nodes) byKey.set(nodeKey(n.type, n.id), n);
  for (const e of graph.edges) {
    for (const [t, i] of [
      [e.sourceType, e.sourceId],
      [e.targetType, e.targetId],
    ] as const) {
      const key = nodeKey(t, i);
      if (!byKey.has(key)) {
        byKey.set(key, { id: i, type: t as GraphNode["type"], title: `${t}:${i.slice(0, 8)}`, ghost: true });
      }
    }
  }
  return [...byKey.values()];
}

/** Undirected connection count per node — drives circle size and the render budget. */
function degreesOf(edges: Graph["edges"]): Map<string, number> {
  const degree = new Map<string, number>();
  const bump = (k: string) => degree.set(k, (degree.get(k) ?? 0) + 1);
  for (const e of edges) {
    bump(nodeKey(e.sourceType, e.sourceId));
    bump(nodeKey(e.targetType, e.targetId));
  }
  return degree;
}

// A node's diameter scales with its degree, clamped to [MIN_SIZE, MAX_SIZE].
const sizeForDegree = (degree: number) => Math.round(Math.min(MAX_SIZE, MIN_SIZE + degree * 6));

// ── Simulation data types ────────────────────────────────────────────────────────────────
// d3-force mutates these in place: x/y (current position, a node's *center*), vx/vy
// (velocity), and fx/fy (a fixed position while dragging). We never read positions from
// React state — the sim owns them and the render pulls the live values each frame.
interface SimNode extends SimulationNodeDatum {
  id: string;
  size: number;
  data: CircleData;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

/** Turn the core's graph into simulation nodes + links. Nodes are seeded on a deterministic
 * phyllotaxis spiral so the sim relaxes from an even spread (no random pile, no per-open
 * jitter); the focus node, if any, is pinned at the origin so its neighborhood paints
 * around it. Links carry endpoint keys — d3-force resolves them to node objects when the
 * link force initializes. */
function buildSimGraph(
  nodes: GhostAware[],
  degree: Map<string, number>,
  focusKey: string | null,
): { simNodes: SimNode[]; simLinks: SimLink[] } {
  const simNodes = nodes.map((n, i): SimNode => {
    const key = nodeKey(n.type, n.id);
    const focus = key === focusKey;
    const deg = degree.get(key) ?? 0;
    const size = focus ? Math.max(FOCUS_MIN_SIZE, sizeForDegree(deg)) : sizeForDegree(deg);
    // Spiral seed (index 0 at the center); the focus node overrides to a hard pin.
    const r = SEED_SPREAD * Math.sqrt(i);
    const a = i * GOLDEN_ANGLE;
    const node: SimNode = {
      id: key,
      size,
      x: focus ? 0 : Math.cos(a) * r,
      y: focus ? 0 : Math.sin(a) * r,
      data: {
        entityType: n.type,
        entityId: n.id,
        objectTypeId: n.objectTypeId ?? null,
        objectColor: n.objectColor ?? null,
        objectIcon: n.objectIcon ?? null,
        label: n.title || "Untitled",
        ghost: !!n.ghost,
        focus,
        size,
        degree: deg,
      },
    };
    if (focus) {
      node.fx = 0;
      node.fy = 0;
    }
    return node;
  });
  return { simNodes, simLinks: [] };
}

/** React Flow node from a sim node — position is top-left, so offset the sim's center by
 * half the diameter. Called only for the (budgeted) interactive subset each frame. */
function toCircleNode(n: SimNode): CircleNode {
  const size = n.size;
  return {
    id: n.id,
    type: "circle",
    position: { x: (n.x ?? 0) - size / 2, y: (n.y ?? 0) - size / 2 },
    // Explicit dimensions so React Flow treats nodes as already-measured and shows them
    // immediately (its ResizeObserver measurement is unreliable in the RNW host).
    width: size,
    height: size,
    data: n.data,
  };
}

function toFlowEdges(edges: Graph["edges"], large: boolean): Edge[] {
  return edges.map((e, i) => {
    // A board's "embeds this" edge (canvas → note/task/file) reads like a note embed.
    const embed = e.kind === "embed" || e.kind === "canvas";
    // Reference-prop edges are labeled with the field name (PLAN §5.3): kind "prop:author"
    // → "author". Only on small graphs, where labels are legible and cheap.
    const propField = e.kind.startsWith("prop:") ? e.kind.slice("prop:".length) : null;
    return {
      id: `e${i}`,
      source: nodeKey(e.sourceType, e.sourceId),
      target: nodeKey(e.targetType, e.targetId),
      // Embeds are plain solid lines — nothing on the canvas loops or marches. Straight
      // edges + interactionWidth 0 also skip the second, invisible hit-area path React Flow
      // renders per edge — halving edge DOM.
      type: large ? "straight" : undefined,
      interactionWidth: large ? 0 : undefined,
      label: propField && !large ? propField : undefined,
      // The field name is machine-generated, so it is 10px mono on the card surface.
      labelStyle: propField ? { fill: colors.textTertiary, fontSize: font.size["2xs"], fontFamily: font.mono } : undefined,
      labelBgStyle: propField ? { fill: colors.surfaceCard } : undefined,
      labelBgPadding: propField ? [3, 1] : undefined,
      labelBgBorderRadius: propField ? radius.xs : undefined,
      style: {
        stroke: colors.borderStrong,
        strokeWidth: 1,
        // Solid for embeds, dotted for prop edges, dashed for plain refs.
        strokeDasharray: embed ? undefined : propField ? "1 3" : "4 4",
      },
    };
  });
}

// Restyle a small graph's edges so the ones touching the hovered node light up (accent,
// solid, thicker). The lit edges are moved to the end of the array so they paint over the
// other edges — but we deliberately don't raise their zIndex, which would lift them above
// the nodes; edges must stay in React Flow's edge layer, beneath the node circles.
function highlightEdges(edges: Edge[], hoveredId: string | null): Edge[] {
  if (!hoveredId) return edges;
  const normal: Edge[] = [];
  const lit: Edge[] = [];
  for (const e of edges) {
    if (e.source === hoveredId || e.target === hoveredId) {
      lit.push({ ...e, style: { ...e.style, stroke: colors.accent, strokeWidth: 2, strokeDasharray: undefined } });
    } else {
      normal.push(e);
    }
  }
  return [...normal, ...lit];
}

/** Push the tunable physics onto a sim's forces. Used both when a sim is built and, on the
 * live sim, whenever a slider moves — the forces are mutated in place so the layout retunes
 * from where it is instead of restarting from the seed. */
function applyPhysics(sim: Simulation<SimNode, SimLink>, physics: GraphPhysics, large: boolean): void {
  (sim.force("charge") as ForceManyBody<SimNode>)
    .strength(-physics.repelForce * (large ? LARGE_CHARGE_SCALE : 1))
    .distanceMax(large ? CHARGE_DISTANCE_MAX_LARGE : CHARGE_DISTANCE_MAX);
  (sim.force("link") as ForceLink<SimNode, SimLink>).distance(physics.linkDistance).strength(physics.linkForce);
  (sim.force("x") as ForceX<SimNode>).strength(physics.centerForce);
  (sim.force("y") as ForceY<SimNode>).strength(physics.centerForce);
  (sim.force("collide") as ForceCollide<SimNode>).radius((d) => d.size / 2 + physics.nodeSpacing);
}

/** Owns the d3-force simulation for a graph. Rebuilds (and re-heats) whenever the node/link
 * set changes; nodes that survive the change resume from their last position rather than
 * the seed, so filtering or a live data refresh nudges the layout instead of reshuffling
 * it. Physics changes retune the running sim in place. Bumps `frame` once per animation
 * frame while the sim is live so consumers can re-read the mutated positions; flips
 * `running` false when it damps to rest. Returns the sim handle so drag handlers can pin
 * nodes (fx/fy) and re-heat. */
function useForceLayout(simNodes: SimNode[], simLinks: SimLink[], large: boolean, physics: GraphPhysics) {
  const [frame, setFrame] = useState(0);
  const [running, setRunning] = useState(true);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  // Last known center of every node the previous sim laid out, keyed by node id, so a
  // rebuilt sim can pick up where it left off for the nodes it still has.
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  // The physics the current sim was built with — read via a ref so the build effect doesn't
  // re-run (and re-seed) on every slider tick; the retune effect below handles those.
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const appliedRef = useRef<GraphPhysics | null>(null);

  useEffect(() => {
    for (const n of simNodes) {
      const prev = positionsRef.current.get(n.id);
      // Pinned nodes (the focus) keep their fixed spot; everything else resumes in place.
      if (prev && n.fx == null && n.fy == null) {
        n.x = prev.x;
        n.y = prev.y;
      }
    }
    const sim = forceSimulation<SimNode>(simNodes)
      .force("charge", forceManyBody<SimNode>())
      .force("link", forceLink<SimNode, SimLink>(simLinks).id((d) => d.id))
      .force("x", forceX<SimNode>(0))
      .force("y", forceY<SimNode>(0))
      .force("collide", forceCollide<SimNode>())
      .velocityDecay(large ? 0.6 : 0.5)
      .alphaDecay(large ? 0.08 : 0.06);
    applyPhysics(sim, physicsRef.current, large);
    appliedRef.current = physicsRef.current;
    simRef.current = sim;
    setRunning(true);

    // The sim runs its own d3-timer (~60fps) and fires "tick" each frame; coalesce those
    // into a single React re-render per animation frame.
    let raf = 0;
    sim.on("tick", () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setFrame((f) => f + 1); });
    });
    sim.on("end", () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      setFrame((f) => f + 1);
      setRunning(false);
    });

    return () => {
      sim.on("tick", null);
      sim.on("end", null);
      sim.stop();
      if (raf) cancelAnimationFrame(raf);
      simRef.current = null;
      // Remember where everything ended up for the next build (see positionsRef).
      for (const n of simNodes) positionsRef.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    };
  }, [simNodes, simLinks, large]);

  // Retune the live sim when a slider moves: mutate the forces in place and warm the sim
  // back up so the layout visibly relaxes into the new balance. Skipped right after a build,
  // which already applied these values.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim || appliedRef.current === physics) return;
    applyPhysics(sim, physics, large);
    appliedRef.current = physics;
    setRunning(true);
    sim.alpha(Math.max(sim.alpha(), 0.5)).restart();
  }, [physics, large]);

  const reheat = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    setRunning(true);
    sim.alpha(Math.max(sim.alpha(), 0.4)).restart();
  }, []);

  return { frame, running, reheat, simRef };
}

/** A circular graph node with a centered type icon and a hover popup (title + chevron)
 * that opens the item. Size comes from data.size; the focus node gets a persistent halo
 * and is not itself navigable (you're already on it). */
function CircleNode({ id, data }: NodeProps<CircleNode>) {
  const onOpenNode = useContext(GraphOpenContext);
  const onHover = useContext(GraphHoverContext);
  const { onSelect, selectedKey, coarse } = useContext(GraphSelectContext);
  const selected = selectedKey === id;
  const [hover, setHover] = useState(false);
  const enter = useCallback(() => {
    setHover(true);
    onHover(id);
  }, [onHover, id]);
  const leave = useCallback(() => {
    setHover(false);
    onHover(null);
  }, [onHover]);
  const accent = data.ghost ? colors.textTertiary : nodeColor(data.entityType, data.objectTypeId, data.objectColor);
  // An archetype's chosen icon marks its nodes; otherwise fall back to the entity-type icon.
  const iconName = ((data.objectIcon as IconName | null) ?? TYPE_ICON[data.entityType] ?? "dot") as IconName;
  const iconSize = Math.round(data.size * 0.5);
  // Notes, tasks, canvases, and projects open; the focus node (you're already on it) and
  // ghosts (unresolved link targets) don't.
  const navigable = !data.focus && !data.ghost && OPENABLE_TYPES.has(data.entityType);

  const open = useCallback(
    (e: ReactMouseEvent) => {
      if (navigable) onOpenNode(data.entityType, data.entityId, e.metaKey || e.ctrlKey);
    },
    [onOpenNode, navigable, data.entityType, data.entityId],
  );
  // A tap selects, whatever the node is (canvases, files and ghosts included) — then opens,
  // for hosts that navigate on tap. A touch host passes only onSelectNode and offers Open
  // from its own bar.
  const press = useCallback(
    (e: ReactMouseEvent) => {
      if (onSelect) {
        // Keep the pane's click (which clears the selection) from also seeing this one.
        e.stopPropagation();
        onSelect({ key: id, type: data.entityType, id: data.entityId, label: data.label, degree: data.degree, ghost: data.ghost });
      }
      open(e);
    },
    [onSelect, open, id, data.entityType, data.entityId, data.label, data.degree, data.ghost],
  );

  // Selected: the accent 2px ring and a 4px soft-accent halo. Focus keeps its wider halo;
  // hover (pointer only) steps to the active fill.
  const halo = data.focus
    ? `0 0 0 6px ${colors.accentSoft}`
    : selected
      ? `0 0 0 4px ${colors.accentSoft}`
      : hover
        ? `0 0 0 4px ${colors.surfaceActive}`
        : "none";
  const ring = selected ? colors.accent : accent;

  return (
    <div
      style={{ position: "relative", width: data.size, height: data.size }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {/* Hidden, centered handles so edges route to the circle's center. */}
      <Handle type="target" position={Position.Top} isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />

      <div
        style={{
          width: data.size,
          height: data.size,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxSizing: "border-box",
          background: data.ghost ? "transparent" : colors.surfaceCard,
          border: `${data.focus ? 3 : 2}px ${data.ghost && !selected ? "dashed" : "solid"} ${ring}`,
          opacity: data.ghost ? 0.65 : 1,
          boxShadow: halo,
          transition: `box-shadow ${motion.fast}ms ${motion.ease}`,
          cursor: navigable || onSelect ? "pointer" : "default",
        }}
        onClick={press}
      >
        <Icon name={iconName} size={iconSize} color={accent} />
      </div>

      <div style={data.ghost ? { ...nodeLabelStyle, color: colors.textTertiary } : nodeLabelStyle}>
        {truncateLabel(data.label)}
      </div>

      {/* No hover on a phone — a tap would strand the popup, and the host's bar replaces it. */}
      {hover && !coarse ? (
        <button type="button" style={popupStyle} onClick={open} disabled={!navigable}>
          <span style={popupLabelStyle}>{data.label}</span>
          {navigable ? <Icon name="chevronRight" size={12} color={colors.textQuaternary} /> : null}
        </button>
      ) : null}
    </div>
  );
}

// nodeTypes must be a stable reference (defined at module scope) to avoid React Flow
// re-registering renderers on every render.
const nodeTypes: NodeTypes = { circle: CircleNode };

export interface GraphViewProps {
  graph: Graph;
  /** When set (e.g. "note:<id>"), that node is pinned at the center and the rest settle
   * around it. */
  focusKey?: string | null;
  /** Invoked when a note, task, canvas or project node is opened. */
  onOpenNode?: OpenNodeHandler;
  /** Show the settings menu (force sliders + show/hide filters) in the canvas corner. Its
   * settings persist per device and apply only to views that show the menu, so the whole-
   * knowledgebase graph can be tuned without disturbing the per-note neighborhoods. */
  menu?: boolean;
  /** Fires on a tap/click of ANY node (notes, tasks, projects, canvases, files, ghosts), and
   * with null when the empty pane is tapped. Independent of onOpenNode, which still fires for
   * navigable nodes — a touch host passes this alone and opens from its own bar. */
  onSelectNode?: SelectNodeHandler;
  /** Key (`nodeKey(type, id)`) of the node to draw as selected: accent ring + halo. */
  selectedKey?: string | null;
  /** Reports what is actually on screen after the Show filters (ghosts included), whenever
   * it changes — for a host status line. */
  onCounts?: (counts: { nodes: number; links: number }) => void;
  /** The graph sits inside a scrolling page (a chat preview) rather than filling a surface: the
   * wheel scrolls the page instead of zooming, so the graph can't trap the reader. Pinch, the
   * zoom buttons and dragging still work. */
  embedded?: boolean;
}

/** Flow-space rectangle currently visible for a given viewport transform, padded by
 * VIEWPORT_MARGIN on each side. Returns null when dimensions aren't known yet. */
function viewportBounds(
  vp: Viewport,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!vp.zoom || !width || !height) return null;
  const x0 = -vp.x / vp.zoom;
  const y0 = -vp.y / vp.zoom;
  const x1 = (width - vp.x) / vp.zoom;
  const y1 = (height - vp.y) / vp.zoom;
  const mx = (x1 - x0) * VIEWPORT_MARGIN;
  const my = (y1 - y0) * VIEWPORT_MARGIN;
  return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };
}

/** Flow-space bounding box of every node (center ± radius), or null when there are none.
 * Used to frame the whole graph on load without relying on React Flow's mounted node set. */
function simContentBounds(nodes: SimNode[]): { x: number; y: number; width: number; height: number } | null {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = n.size / 2;
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Choose which sim nodes get a real (interactive) DOM node on a large graph — a
 * zoom-driven level of detail. Nothing is mounted until the user has zoomed in far enough
 * that at most INTERACTIVE_VISIBLE_LIMIT nodes fall within the viewport; until then (no
 * viewport yet, or still too many visible) we return none and let the canvas base layer
 * carry the overview. Once under the limit, every visible node is mounted as a full
 * interactive card — the count is already bounded, so no degree culling is needed. Edges and
 * off-screen nodes stay on the canvas, so nothing visually disappears. */
function selectRender(
  allNodes: SimNode[],
  bounds: { x0: number; y0: number; x1: number; y1: number } | null,
): SimNode[] {
  // No viewport measured yet → zoomed-out overview; the canvas has it covered.
  if (!bounds) return [];
  const inView = allNodes.filter((n) => {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
  });
  // Still zoomed out too far to interact with individual nodes — keep the overview.
  if (inView.length > INTERACTIVE_VISIBLE_LIMIT) return [];
  return inView;
}

/** Draws the entire graph — every node as a dot and every edge as a line — onto a single
 * <canvas> kept in sync with the React Flow viewport, re-read from the live sim positions
 * each frame. This is the "show everything" layer: one DOM element regardless of node
 * count, so connections are never hidden. React Flow's budgeted DOM nodes render on top of
 * it for interaction; their edges are left to this canvas so nothing is drawn twice. */
function GraphBaseLayer({
  nodes,
  links,
  frame,
  hoveredId,
  selectedId,
}: {
  nodes: SimNode[];
  links: SimLink[];
  frame: number;
  hoveredId: string | null;
  /** The host's selected node keeps its accent ring in the zoomed-out overview too. */
  selectedId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // The theme is a dependency only so the canvas repaints (and re-resolves its colours)
  // when it flips; the DOM layers follow the CSS variables on their own.
  const theme = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // A canvas can't take `var(--c-…)`; resolve roles against the live theme, once per
    // distinct colour per paint.
    const root = getComputedStyle(document.documentElement);
    const resolved = new Map<string, string>();
    const paint = (c: string) => {
      let v = resolved.get(c);
      if (v === undefined) {
        v = resolveCanvasColor(c, root);
        resolved.set(c, v);
      }
      return v;
    };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    const [tx, ty, zoom] = transform;
    // Clear in device space, then map flow coords → device pixels for drawing.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, tx * dpr, ty * dpr);

    // Edges first, batched into one stroke (all share a color). d3-force resolves each
    // link's source/target to the node object, so read their live centers directly.
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = paint(colors.borderStrong);
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (const e of links) {
      const s = e.source as SimNode;
      const t = e.target as SimNode;
      if (!s || !t || typeof s !== "object" || typeof t !== "object") continue;
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Light up the hovered node's connections: a second, brighter accent pass over just the
    // edges that touch it, drawn on top of the base edges.
    if (hoveredId) {
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = paint(colors.accent);
      ctx.beginPath();
      for (const e of links) {
        const s = e.source as SimNode;
        const t = e.target as SimNode;
        if (!s || !t || typeof s !== "object" || typeof t !== "object") continue;
        if (s.id !== hoveredId && t.id !== hoveredId) continue;
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
      }
      ctx.stroke();
    }

    // Nodes as the DOM circles draw them: card fill, a 2px ring in the type's colour (ghosts
    // muted and unfilled), so the overview and the zoomed-in cards read as one graph.
    const card = paint(colors.surfaceCard);
    ctx.lineWidth = 2;
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, n.size / 2 - 1, 0, Math.PI * 2);
      ctx.globalAlpha = n.data.ghost ? 0.4 : 1;
      if (!n.data.ghost) {
        ctx.fillStyle = card;
        ctx.fill();
      }
      ctx.strokeStyle = paint(n.id === selectedId ? colors.accent : n.data.ghost ? colors.textTertiary : nodeColor(n.data.entityType, n.data.objectTypeId, n.data.objectColor));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // `frame` is a dependency so the canvas repaints as the sim moves nodes.
  }, [transform, width, height, frame, nodes, links, hoveredId, selectedId, theme]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}
    />
  );
}

/** The pure canvas: takes a resolved graph and renders it. Data fetching and empty-state
 * messaging live in the wrapper screens (GraphScreen, NoteGraph). Wrapped in its own
 * ReactFlowProvider so GraphCanvas can read the live viewport at the same level it
 * configures <ReactFlow>. */
export function GraphView({ graph, focusKey = null, onOpenNode, menu = false, onSelectNode, selectedKey = null, onCounts, embedded = false }: GraphViewProps) {
  const coarse = useCoarsePointer();
  const select = useMemo(() => ({ onSelect: onSelectNode ?? null, selectedKey, coarse }), [onSelectNode, selectedKey, coarse]);
  // Menu settings (physics + filters) are loaded regardless, but only take effect on views
  // that show the menu — a view with no menu has no way to explain or undo them.
  const settings = useGraphSettings();
  const physics = menu ? settings.physics : DEFAULT_PHYSICS;
  const shown = useMemo(
    () => (menu ? applyGraphFilters(graph, settings.filters, focusKey) : graph),
    [graph, settings.filters, focusKey, menu],
  );

  const { simNodes, simLinks, flowEdges, large } = useMemo(() => {
    const nodes = withGhosts(shown);
    const degree = degreesOf(shown.edges);
    const large = nodes.length > LARGE_GRAPH_THRESHOLD;
    const focused = focusKey && nodes.some((n) => nodeKey(n.type, n.id) === focusKey) ? focusKey : null;
    const { simNodes } = buildSimGraph(nodes, degree, focused);
    // Links reference endpoint keys; d3-force swaps them for node objects on init.
    const simLinks: SimLink[] = shown.edges.map((e) => ({
      source: nodeKey(e.sourceType, e.sourceId),
      target: nodeKey(e.targetType, e.targetId),
    }));
    return { simNodes, simLinks, flowEdges: toFlowEdges(shown.edges, large), large };
  }, [shown, focusKey]);

  // Filtered counts for the host; the callback is read through a ref so an inline arrow
  // doesn't re-fire it every render.
  const onCountsRef = useRef(onCounts);
  onCountsRef.current = onCounts;
  useEffect(() => {
    onCountsRef.current?.({ nodes: simNodes.length, links: simLinks.length });
  }, [simNodes, simLinks]);

  return (
    <GraphOpenContext.Provider value={onOpenNode ?? noop}>
      <GraphSelectContext.Provider value={select}>
      <ReactFlowProvider>
        <GraphCanvas
          simNodes={simNodes}
          simLinks={simLinks}
          flowEdges={flowEdges}
          large={large}
          physics={physics}
          // The menu lists projects from the unfiltered graph so a hidden one can be re-shown.
          overlay={menu ? <GraphMenu graph={graph} {...settings} /> : null}
          embedded={embedded}
        />
      </ReactFlowProvider>
      </GraphSelectContext.Provider>
    </GraphOpenContext.Provider>
  );
}

function GraphCanvas({
  simNodes,
  simLinks,
  flowEdges,
  large,
  physics,
  overlay,
  embedded,
}: {
  simNodes: SimNode[];
  simLinks: SimLink[];
  flowEdges: Edge[];
  large: boolean;
  physics: GraphPhysics;
  /** The settings menu. When present the graph gets its sub-toolbar (counts, fit, the menu's
   * settings button) and the legend strip; without it the canvas runs edge to edge. */
  overlay?: ReactNode;
  /** See GraphViewProps.embedded. */
  embedded: boolean;
}) {
  const { setViewport } = useReactFlow();
  const selectValue = useContext(GraphSelectContext);
  const { onSelect, selectedKey } = selectValue;
  const { frame, simRef } = useForceLayout(simNodes, simLinks, large, physics);

  // React Flow is controlled here, so it needs the change handlers from these hooks to
  // write back internal updates (selection, drag). On a large graph `nodes` holds only the
  // budgeted subset; positions come from the sim and are refreshed every frame.
  const [nodes, setNodes, onNodesChange] = useNodesState<CircleNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [width, height] = useStore((s): [number, number] => [s.width, s.height], (a, b) => a[0] === b[0] && a[1] === b[1]);
  // Last viewport seen from onMoveEnd; null until the user first pans/zooms, when the whole
  // graph is a candidate (budgeted to the top hubs for the overview). A version counter
  // forces reselection on move-end even when the sim has stopped bumping `frame`.
  const viewportRef = useRef<Viewport | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  // Key of the node the pointer is over (or null) — lifted out of the nodes so both edge
  // layers (React Flow edges here, the canvas base layer for large graphs) can light up the
  // hovered node's connections.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The node the find palette last flew to (see search below): ringed, its links lit.
  const [foundKey, setFoundKey] = useState<string | null>(null);
  const byId = useMemo(() => new Map(simNodes.map((n) => [n.id, n])), [simNodes]);

  // Sync React Flow's node set from the live sim positions. Runs every frame while the sim
  // moves, and on pan/zoom (selectionVersion) once it's at rest.
  useEffect(() => {
    if (!large) {
      setNodes(simNodes.map(toCircleNode));
      return;
    }
    const bounds = viewportRef.current ? viewportBounds(viewportRef.current, width, height) : null;
    setNodes(selectRender(simNodes, bounds).map(toCircleNode));
  }, [frame, selectionVersion, simNodes, large, width, height, setNodes]);

  // Edges: large graphs paint them on the canvas base layer, so React Flow only carries
  // edges for small graphs. Re-styled when the hovered node changes so its links light up.
  useEffect(() => {
    setEdges(large ? [] : highlightEdges(flowEdges, hoveredId ?? foundKey));
  }, [flowEdges, hoveredId, foundKey, large, setEdges]);

  // Keep the whole graph framed while it loads: re-fit every frame as the layout relaxes so
  // the expanding graph stays fully visible, and stop the moment the user pans, zooms, or
  // drags a node (so we never fight their navigation). `frame` only advances while the sim is
  // live, so this naturally settles once the layout is at rest. We compute the box from the
  // sim's own positions rather than React Flow's fitView, since on a large graph the
  // zoomed-out overview has no mounted nodes for fitView to measure.
  const userMovedRef = useRef(false);
  useEffect(() => {
    userMovedRef.current = false;
  }, [simNodes]);
  // Bumped by the toolbar's Fit button, which hands navigation back to the auto-fit.
  const [fitVersion, setFitVersion] = useState(0);
  useEffect(() => {
    if (userMovedRef.current || !width || !height) return;
    const b = simContentBounds(simNodes);
    if (!b) return;
    const pad = 0.12;
    const zoom = Math.max(0.05, Math.min(1.4, Math.min(width / (b.width * (1 + pad)), height / (b.height * (1 + pad)))));
    setViewport({ x: width / 2 - (b.x + b.width / 2) * zoom, y: height / 2 - (b.y + b.height / 2) * zoom, zoom });
  }, [frame, fitVersion, simNodes, width, height, setViewport]);
  const fit = useCallback(() => {
    userMovedRef.current = false;
    setFitVersion((v) => v + 1);
  }, []);

  // Search (the toolbar's magnifier, or ⌘K while the graph is on screen): a find palette over
  // the nodes; picking one flies to it and rings it, its links lit, until the next click.
  const [searching, setSearching] = useState(false);
  const visible = useContext(NavContext)?.visible ?? true;
  const searchable = !!overlay;
  useEffect(() => {
    if (!searchable || !visible || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setSearching(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchable, visible]);
  const searchItems = useMemo(() => {
    const sections = new Map(LEGEND.map(([type, label], i) => [type, { label, i }]));
    return simNodes
      .filter((n) => !n.data.ghost)
      .map((n): FindItem & { order: number } => {
        const d = n.data;
        const section = sections.get(d.entityType);
        return {
          key: n.id,
          section: section?.label ?? d.entityType,
          order: section?.i ?? LEGEND.length,
          icon: ((d.objectIcon as IconName | null) ?? TYPE_ICON[d.entityType] ?? "dot") as IconName,
          iconColor: nodeColor(d.entityType, d.objectTypeId, d.objectColor),
          title: d.label || "Untitled",
          trailing: d.degree ? `${d.degree} link${d.degree === 1 ? "" : "s"}` : undefined,
        };
      })
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }, [simNodes]);
  const goTo = useCallback(
    (key: string) => {
      const s = byId.get(key);
      if (!s || s.x == null || s.y == null || !width || !height) return;
      // Taking the camera: the load-time auto-fit must not pull it back.
      userMovedRef.current = true;
      const zoom = 1.2;
      const vp = { x: width / 2 - s.x * zoom, y: height / 2 - s.y * zoom, zoom };
      setFoundKey(key);
      void setViewport(vp, { duration: 300 }).then(() => {
        // A large graph only mounts the nodes in view: reselect for where we landed.
        viewportRef.current = vp;
        setSelectionVersion((v) => v + 1);
      });
    },
    [byId, width, height, setViewport],
  );
  const onPaneClickClear = useCallback(() => {
    setFoundKey(null);
    onSelect?.(null);
  }, [onSelect]);
  const ringed = useMemo(() => ({ ...selectValue, selectedKey: selectValue.selectedKey ?? foundKey }), [selectValue, foundKey]);
  const litId = hoveredId ?? foundKey;

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    viewportRef.current = vp;
    setSelectionVersion((v) => v + 1);
  }, []);

  // A move started by the user (event is non-null; our own setViewport passes null) turns off
  // the load-time auto-fit so it stops re-centering under them.
  const onMoveStart = useCallback((e: MouseEvent | TouchEvent | null) => {
    if (e) userMovedRef.current = true;
  }, []);

  // Dragging drives the sim: pin the grabbed node to the pointer (fx/fy) and keep the sim
  // warm (alphaTarget) so its neighbors get out of the way, then release on drop. This is
  // the standard d3-force drag, adapted to React Flow's drag events.
  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      const s = byId.get(node.id);
      if (!s) return;
      // Grabbing a node counts as taking over navigation — stop the load-time auto-fit.
      userMovedRef.current = true;
      s.fx = s.x;
      s.fy = s.y;
      // alphaTarget keeps the sim from decaying to rest while dragging; restart() resumes
      // the tick loop (and thus the frame bumps) even if it had already settled.
      simRef.current?.alphaTarget(0.3).restart();
    },
    [byId, simRef],
  );
  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      const s = byId.get(node.id);
      if (!s) return;
      // node.position is top-left; the sim tracks centers.
      s.fx = node.position.x + s.size / 2;
      s.fy = node.position.y + s.size / 2;
    },
    [byId],
  );
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const s = byId.get(node.id);
      simRef.current?.alphaTarget(0);
      if (s && !s.data.focus) {
        s.fx = null;
        s.fy = null;
      }
    },
    [byId, simRef],
  );

  return (
    <GraphSelectContext.Provider value={ringed}>
    <GraphHoverContext.Provider value={setHoveredId}>
      {/* Fill the RNW parent View (which is position:relative) with an absolutely-sized
          box so React Flow measures a real height — a plain height:100% collapses to 0 in
          the flex layout and leaves nodes hidden. */}
      <div style={fillStyle}>
        <style>{GRAPH_FLOW_CSS + GRAPH_CHROME_CSS}</style>
        {overlay ? (
          <div style={toolbarStyle}>
            <span style={{ ...monoStyle, color: colors.textTertiary }}>
              {simNodes.length} nodes · {simLinks.length} links
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ ...monoStyle, minWidth: 0, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", marginRight: space.xs }}>
              repel {Math.round(physics.repelForce)} · link {Math.round(physics.linkDistance)}
            </span>
            <button type="button" className="graph-iconbtn" onClick={() => setSearching(true)} aria-label="Find a node" title="Find a node (⌘K)">
              <Icon name="search" size={13} color="currentColor" />
            </button>
            <button type="button" className="graph-iconbtn" onClick={fit} aria-label="Fit" title="Fit">
              <Icon name="fit" size={13} color="currentColor" />
            </button>
            {overlay}
          </div>
        ) : null}
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          {/* An absolutely-sized box again, so React Flow measures a real height inside the
              flex column rather than a collapsed percentage. */}
          <div style={canvasFillStyle}>
            {/* The full graph (every node + edge) as one canvas behind React Flow. React Flow
                is stacked above it (zIndex 1) and kept transparent so the canvas shows through
                everywhere except under the interactive DOM nodes. On a large graph those DOM
                nodes only exist once zoomed in (selectRender), so the canvas is the sole layer
                in the zoomed-out overview. */}
            {large ? <GraphBaseLayer nodes={simNodes} links={simLinks} frame={frame} hoveredId={litId} selectedId={selectedKey ?? foundKey} /> : null}
            <ReactFlow
              className="graph-flow"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onMoveStart={onMoveStart}
              onMoveEnd={large ? onMoveEnd : undefined}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={onSelect || foundKey ? onPaneClickClear : undefined}
              // The whole-graph framing is done manually on settle (see the fit effect), since
              // React Flow's fitView can't see the sim nodes that aren't mounted on a large graph.
              proOptions={{ hideAttribution: true }}
              minZoom={0.05}
              zoomOnScroll={!embedded}
              preventScrolling={!embedded}
              nodesConnectable={false}
              // Cull anything off-screen among the mounted set as you pan/zoom.
              onlyRenderVisibleElements={large}
              edgesFocusable={false}
              style={large ? { background: "transparent", position: "relative", zIndex: 1 } : undefined}
            >
              {/* The 16px dotted grid, on the card surface. */}
              <Background color={colors.borderDefault} gap={16} size={1} />
              <Controls showInteractive={false} showFitView={!overlay} />
            </ReactFlow>
          </div>
        </div>
        {overlay ? (
          <div style={legendStyle}>
            {LEGEND.map(([type, label]) => (
              <span key={type} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
                <span style={{ width: 7, height: 7, boxSizing: "border-box", borderRadius: "50%", border: `2px solid ${typeColor(type)}` }} />
                <span style={monoStyle}>{label}</span>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <span style={{ ...monoStyle, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>dashed = link · dotted = reference prop · solid = embed</span>
          </div>
        ) : null}
      </div>
      {searching ? (
        <FindPalette
          items={searchItems}
          placeholder="Find a note, task, canvas or project…"
          emptyText={searchItems.length ? "Nothing in the graph matches." : "The graph is empty."}
          onPick={(item) => goTo(item.key)}
          onClose={() => setSearching(false)}
        />
      ) : null}
    </GraphHoverContext.Provider>
    </GraphSelectContext.Provider>
  );
}

const noop: OpenNodeHandler = () => {};

/** Centered empty/placeholder message, styled to match the canvas surface. */
export function GraphEmpty({ children }: { children: ReactNode }) {
  return (
    <div style={graphEmptyStyle}>
      <p style={{ maxWidth: 340, margin: 0, textAlign: "center", fontSize: font.size.sm, lineHeight: "18px", color: colors.textTertiary }}>{children}</p>
    </div>
  );
}
