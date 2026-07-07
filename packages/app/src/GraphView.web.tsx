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
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Icon, colors, type IconName } from "@companion/design-system";
import type { Graph, GraphNode } from "@companion/core-bridge";

/** How a node open is dispatched. Decoupled from useNav() so the same renderer works in
 * the app (nav.openNote) and inside the mobile graph WebView (postMessage). */
export type OpenNodeHandler = (type: string, id: string, newTab: boolean) => void;
const GraphOpenContext = createContext<OpenNodeHandler>(() => {});

/** Report which node the pointer is over (its key, or null on leave) up to GraphCanvas so
 * the edge layers can highlight that node's connections. */
const GraphHoverContext = createContext<(id: string | null) => void>(() => {});

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

// ── Force-simulation knobs (Obsidian's "Forces" sliders) ────────────────────────────────
// LINK_DISTANCE — a spring's resting length, the preferred gap between two linked nodes.
// CHARGE_STRENGTH — how hard every node repels every other (negative = repel); this is
//   what spreads the graph out instead of collapsing it to a point. Weaker on big graphs
//   so a thousand-node vault doesn't explode off-screen.
// CHARGE_DISTANCE_MAX — cap the repulsion range so far-apart nodes stop pushing (keeps
//   clusters coherent and the Barnes-Hut sum cheap).
// CENTER_STRENGTH — the gentle pull toward the origin so disconnected bits stay in frame.
// COLLIDE_PAD — extra spacing added to each node's radius so circles don't overlap.
// SEED_SPREAD — radius scale for the deterministic phyllotaxis seed the sim relaxes from.
// These are scaled for our node sizes (32–72px circles), not d3's default unit nodes. The
// balance we want: connected notes sit close (short, stiff link springs) while unconnected
// notes shove hard apart (strong, long-range charge) — so clusters read as tight knots
// separated by real gaps instead of one even hairball. LINK_STRENGTH stiffens the springs so
// linked nodes stay pulled together even against the strong repulsion.
const LINK_DISTANCE = 30;
const LINK_STRENGTH = 0.9;
const CHARGE_STRENGTH = -2400;
const CHARGE_STRENGTH_LARGE = -1200;
const CHARGE_DISTANCE_MAX = 2400;
const CHARGE_DISTANCE_MAX_LARGE = 1600;
const CENTER_STRENGTH = 0.05;
const COLLIDE_PAD = 22;
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

const popupStyle: CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 8px)",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  gap: 6,
  maxWidth: 240,
  padding: "6px 8px 6px 12px",
  borderRadius: 8,
  background: colors.surfaceCard,
  border: `1px solid ${colors.borderSubtle}`,
  boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
  cursor: "pointer",
  font: "inherit",
};

const popupLabelStyle: CSSProperties = {
  fontSize: 12,
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
  top: "calc(100% + 6px)",
  left: "50%",
  transform: "translateX(-50%)",
  width: 132,
  textAlign: "center",
  fontSize: 11,
  lineHeight: 1.25,
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
  background: colors.surfaceApp,
};

export const graphEmptyStyle: CSSProperties = {
  ...fillStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 48,
};

export const graphCodeStyle: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: colors.surfaceCard,
  padding: "1px 5px",
  borderRadius: 5,
};

// nodeKey is React Flow's node id: a composite so a note and a task can never collide.
export const nodeKey = (type: string, id: string) => `${type}:${id}`;

// Icon + accent color per node type. Ghosts (unresolved targets) render muted.
const TYPE_ICON: Record<string, IconName> = {
  note: "notes",
  task: "tasks",
  habit: "dot",
  project: "folder",
};
function typeColor(type: string): string {
  switch (type) {
    case "note":
      return colors.accent;
    case "task":
      return colors.info;
    case "habit":
      return colors.success;
    default:
      return colors.textSecondary;
  }
}

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
    const embed = e.kind === "embed";
    // Reference-prop edges are labeled with the field name (PLAN §5.3): kind "prop:author"
    // → "author". Only on small graphs, where labels are legible and cheap.
    const propField = e.kind.startsWith("prop:") ? e.kind.slice("prop:".length) : null;
    return {
      id: `e${i}`,
      source: nodeKey(e.sourceType, e.sourceId),
      target: nodeKey(e.targetType, e.targetId),
      // Animated (marching-ants) edges run a continuous repaint each; kill them on large
      // graphs. Straight edges + interactionWidth 0 also skip the second, invisible
      // hit-area path React Flow renders per edge — halving edge DOM.
      animated: embed && !large,
      type: large ? "straight" : undefined,
      interactionWidth: large ? 0 : undefined,
      label: propField && !large ? propField : undefined,
      labelStyle: propField ? { fill: colors.textTertiary, fontSize: 10 } : undefined,
      labelBgStyle: propField ? { fill: colors.surfaceApp } : undefined,
      style: {
        stroke: colors.borderStrong,
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

/** Owns the d3-force simulation for a graph. Rebuilds (and re-heats from the seed) whenever
 * the node/link set changes. Bumps `frame` once per animation frame while the sim is live
 * so consumers can re-read the mutated positions; flips `running` false when it damps to
 * rest. Returns the sim handle so drag handlers can pin nodes (fx/fy) and re-heat. */
function useForceLayout(simNodes: SimNode[], simLinks: SimLink[], large: boolean) {
  const [frame, setFrame] = useState(0);
  const [running, setRunning] = useState(true);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  useEffect(() => {
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "charge",
        forceManyBody<SimNode>()
          .strength(large ? CHARGE_STRENGTH_LARGE : CHARGE_STRENGTH)
          .distanceMax(large ? CHARGE_DISTANCE_MAX_LARGE : CHARGE_DISTANCE_MAX),
      )
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(LINK_DISTANCE)
          .strength(LINK_STRENGTH),
      )
      .force("x", forceX<SimNode>(0).strength(CENTER_STRENGTH))
      .force("y", forceY<SimNode>(0).strength(CENTER_STRENGTH))
      .force("collide", forceCollide<SimNode>().radius((d) => d.size / 2 + COLLIDE_PAD))
      .velocityDecay(large ? 0.6 : 0.5)
      .alphaDecay(large ? 0.08 : 0.06);
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
    };
  }, [simNodes, simLinks, large]);

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
  // Notes, tasks, and projects open; the focus node (you're already on it) and ghosts
  // (unresolved link targets) don't.
  const navigable = !data.focus && !data.ghost && (data.entityType === "note" || data.entityType === "task" || data.entityType === "project");

  const open = useCallback(
    (e: ReactMouseEvent) => {
      if (navigable) onOpenNode(data.entityType, data.entityId, e.metaKey || e.ctrlKey);
    },
    [onOpenNode, navigable, data.entityType, data.entityId],
  );

  const halo = data.focus
    ? `0 0 0 6px ${colors.accentSoft}`
    : hover
      ? `0 0 0 4px ${colors.surfaceActive}`
      : "none";

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
          border: `${data.focus ? 3 : 2}px ${data.ghost ? "dashed" : "solid"} ${accent}`,
          opacity: data.ghost ? 0.65 : 1,
          boxShadow: halo,
          transition: "box-shadow 120ms ease",
          cursor: navigable ? "pointer" : "default",
        }}
        onClick={open}
      >
        <Icon name={iconName} size={iconSize} color={accent} />
      </div>

      <div style={data.ghost ? { ...nodeLabelStyle, color: colors.textTertiary } : nodeLabelStyle}>
        {truncateLabel(data.label)}
      </div>

      {hover ? (
        <button type="button" style={popupStyle} onClick={open} disabled={!navigable}>
          <span style={popupLabelStyle}>{data.label}</span>
          {navigable ? <Icon name="chevronRight" size={14} color={colors.textSecondary} /> : null}
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
  /** Invoked when a node is opened (only notes are navigable today). */
  onOpenNode?: OpenNodeHandler;
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
}: {
  nodes: SimNode[];
  links: SimLink[];
  frame: number;
  hoveredId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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
    ctx.strokeStyle = colors.borderStrong;
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
      ctx.strokeStyle = colors.accent;
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

    // Nodes as filled dots, colored by type (ghosts muted).
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, n.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = n.data.ghost ? colors.textTertiary : nodeColor(n.data.entityType, n.data.objectTypeId, n.data.objectColor);
      ctx.globalAlpha = n.data.ghost ? 0.4 : 0.9;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // `frame` is a dependency so the canvas repaints as the sim moves nodes.
  }, [transform, width, height, frame, nodes, links, hoveredId]);

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
export function GraphView({ graph, focusKey = null, onOpenNode }: GraphViewProps) {
  const { simNodes, simLinks, flowEdges, large } = useMemo(() => {
    const nodes = withGhosts(graph);
    const degree = degreesOf(graph.edges);
    const large = nodes.length > LARGE_GRAPH_THRESHOLD;
    const focused = focusKey && nodes.some((n) => nodeKey(n.type, n.id) === focusKey) ? focusKey : null;
    const { simNodes } = buildSimGraph(nodes, degree, focused);
    // Links reference endpoint keys; d3-force swaps them for node objects on init.
    const simLinks: SimLink[] = graph.edges.map((e) => ({
      source: nodeKey(e.sourceType, e.sourceId),
      target: nodeKey(e.targetType, e.targetId),
    }));
    return { simNodes, simLinks, flowEdges: toFlowEdges(graph.edges, large), large };
  }, [graph, focusKey]);

  return (
    <GraphOpenContext.Provider value={onOpenNode ?? noop}>
      <ReactFlowProvider>
        <GraphCanvas simNodes={simNodes} simLinks={simLinks} flowEdges={flowEdges} large={large} />
      </ReactFlowProvider>
    </GraphOpenContext.Provider>
  );
}

function GraphCanvas({
  simNodes,
  simLinks,
  flowEdges,
  large,
}: {
  simNodes: SimNode[];
  simLinks: SimLink[];
  flowEdges: Edge[];
  large: boolean;
}) {
  const { setViewport } = useReactFlow();
  const { frame, simRef } = useForceLayout(simNodes, simLinks, large);

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
    setEdges(large ? [] : highlightEdges(flowEdges, hoveredId));
  }, [flowEdges, hoveredId, large, setEdges]);

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
  useEffect(() => {
    if (userMovedRef.current || !width || !height) return;
    const b = simContentBounds(simNodes);
    if (!b) return;
    const pad = 0.12;
    const zoom = Math.max(0.05, Math.min(1.4, Math.min(width / (b.width * (1 + pad)), height / (b.height * (1 + pad)))));
    setViewport({ x: width / 2 - (b.x + b.width / 2) * zoom, y: height / 2 - (b.y + b.height / 2) * zoom, zoom });
  }, [frame, simNodes, width, height, setViewport]);

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
    <GraphHoverContext.Provider value={setHoveredId}>
      {/* Fill the RNW parent View (which is position:relative) with an absolutely-sized
          box so React Flow measures a real height — a plain height:100% collapses to 0 in
          the flex layout and leaves nodes hidden. */}
      <div style={fillStyle}>
        {/* The full graph (every node + edge) as one canvas behind React Flow. React Flow
            is stacked above it (zIndex 1) and kept transparent so the canvas shows through
            everywhere except under the interactive DOM nodes. On a large graph those DOM
            nodes only exist once zoomed in (selectRender), so the canvas is the sole layer
            in the zoomed-out overview. */}
        {large ? <GraphBaseLayer nodes={simNodes} links={simLinks} frame={frame} hoveredId={hoveredId} /> : null}
        <ReactFlow
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
          // The whole-graph framing is done manually on settle (see the fit effect), since
          // React Flow's fitView can't see the sim nodes that aren't mounted on a large graph.
          proOptions={{ hideAttribution: true }}
          minZoom={0.05}
          nodesConnectable={false}
          // Cull anything off-screen among the mounted set as you pan/zoom.
          onlyRenderVisibleElements={large}
          edgesFocusable={false}
          style={large ? { background: "transparent", position: "relative", zIndex: 1 } : undefined}
        >
          <Background color={colors.borderSubtle} gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </GraphHoverContext.Provider>
  );
}

const noop: OpenNodeHandler = () => {};

/** Centered empty/placeholder message, styled to match the canvas surface. */
export function GraphEmpty({ children }: { children: ReactNode }) {
  return (
    <div style={graphEmptyStyle}>
      <p style={{ maxWidth: 380, textAlign: "center", lineHeight: 1.5, color: colors.textTertiary }}>{children}</p>
    </div>
  );
}
