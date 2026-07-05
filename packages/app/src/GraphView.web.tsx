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
  useStore,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon, colors, type IconName } from "@companion/design-system";
import type { Graph, GraphNode } from "@companion/core-bridge";

/** How a node open is dispatched. Decoupled from useNav() so the same renderer works in
 * the app (nav.openNote) and inside the mobile graph WebView (postMessage). */
export type OpenNodeHandler = (type: string, id: string, newTab: boolean) => void;
const GraphOpenContext = createContext<OpenNodeHandler>(() => {});

/** True when the canvas is in dense mode (large graph, many nodes on screen). Read by
 * each node so captions can drop/return as the user zooms without rebuilding the node
 * array. Provided by GraphCanvas from the live viewport. */
const GraphDenseContext = createContext<boolean>(false);

// The React Flow renderer shared by the full knowledgebase graph (GraphScreen) and the
// per-note neighborhood (NoteGraph). React Flow is DOM-only, so this whole module is
// web/desktop only; native wrappers show a placeholder. The core hands us
// ids/titles/edges only — layout, sizing, and ghost synthesis happen here. Nodes render
// as circles whose size grows with their connection count; hovering one reveals a popup
// with its title and a chevron that opens the item.

type GhostAware = GraphNode & { ghost?: boolean };

/** Per-node data carried into the custom circle renderer. */
interface CircleData extends Record<string, unknown> {
  entityType: string;
  entityId: string;
  label: string;
  ghost: boolean;
  focus: boolean;
  size: number;
  /** Undirected connection count — ranks nodes when the render budget forces a choice. */
  degree: number;
}
type CircleNode = Node<CircleData, "circle">;

const MIN_SIZE = 32;
const MAX_SIZE = 72;
const FOCUS_MIN_SIZE = 52;
const RING_GAP = 190;

// Above this total node count the canvas is treated as "large": edges render in their
// cheap form (straight, no animation, no invisible interaction path) and node culling
// (onlyRenderVisibleElements) is enabled, so a big knowledgebase never mounts all its DOM
// at once. A 1000-node graph otherwise crashes the mobile WebView.
const LARGE_GRAPH_THRESHOLD = 250;

// On a large graph, "dense" mode (captions off, interaction off) is toggled by how many
// nodes are actually rendered — not the total. Once the user zooms in far enough that
// fewer than this many nodes are on screen, captions and selection come back.
const DENSE_VISIBLE_LIMIT = 100;

// Hard cap on nodes handed to React Flow at once (level-of-detail budget). React Flow is
// DOM-based and bogs down / crashes the tab past a few hundred simultaneous nodes, so when
// more than this many fall within the viewport we render only the highest-degree ones (the
// hubs). Zooming into a region shrinks the viewport until every node there fits under the
// budget, so detail is never permanently lost — it's revealed by zoom.
const RENDER_BUDGET = 300;

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

/** Undirected connection count per node — drives both circle size and layout order. */
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

// Local packing radius for a cluster of a given member count, and the gap between the
// centers of separate clusters. CLUSTER_GAP is kept comfortably larger than the biggest
// local radius so distinct clusters read as visually separate blobs.
const clusterRadius = (count: number) => (count <= 1 ? 0 : Math.max(120, count * 34));
const CLUSTER_GAP = 520;

/** Deterministic clustered layout — connected nodes are packed together into visually
 * distinct blobs instead of being spread evenly around one ring. Used for the
 * whole-knowledgebase view.
 *
 * Nodes are split into connected components (BFS over the undirected edges); each component
 * becomes a cluster. Cluster centers are placed around a big ring, and within each cluster
 * the highest-degree node sits at the center with the rest packed in a small local ring —
 * so the busiest hub anchors its neighborhood and links stay short. */
function radialLayout(nodes: GhostAware[], degree: Map<string, number>, edges: Graph["edges"]) {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    const s = nodeKey(e.sourceType, e.sourceId);
    const t = nodeKey(e.targetType, e.targetId);
    link(s, t);
    link(t, s);
  }

  // Group node keys into connected components. Isolated nodes (no edges) each form their
  // own single-member cluster.
  const byKey = new Map<string, GhostAware>();
  for (const n of nodes) byKey.set(nodeKey(n.type, n.id), n);
  const seen = new Set<string>();
  const clusters: string[][] = [];
  for (const n of nodes) {
    const start = nodeKey(n.type, n.id);
    if (seen.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb) && byKey.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    clusters.push(component);
  }

  // Biggest, busiest clusters first so they get the roomier outer slots and small
  // fragments tuck in between them.
  const deg = (k: string) => degree.get(k) ?? 0;
  clusters.sort((a, b) => b.length - a.length);
  for (const c of clusters) c.sort((a, b) => deg(b) - deg(a));

  // Ring the cluster centers around the canvas; a lone cluster sits at the origin.
  const ringRadius =
    clusters.length <= 1 ? 0 : Math.max(CLUSTER_GAP, (clusters.length * CLUSTER_GAP) / (Math.PI * 2));
  const positions = new Map<string, { x: number; y: number }>();
  clusters.forEach((component, ci) => {
    const angle = (ci / Math.max(1, clusters.length)) * Math.PI * 2;
    const cx = Math.cos(angle) * ringRadius;
    const cy = Math.sin(angle) * ringRadius;
    const local = clusterRadius(component.length);
    // Highest-degree member anchors the cluster center; the rest fan out around it.
    component.forEach((key, i) => {
      if (i === 0 || local === 0) {
        positions.set(key, { x: cx, y: cy });
        return;
      }
      const a = ((i - 1) / (component.length - 1)) * Math.PI * 2;
      positions.set(key, { x: cx + Math.cos(a) * local, y: cy + Math.sin(a) * local });
    });
  });
  return positions;
}

/** Focus layout — the focus node sits at the center and everything else fans out in
 * concentric rings by hop-distance (BFS over the undirected edges). Used for the
 * per-note neighborhood so the note's links paint around it. */
function focusLayout(nodes: GhostAware[], edges: Graph["edges"], focusKey: string) {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    const s = nodeKey(e.sourceType, e.sourceId);
    const t = nodeKey(e.targetType, e.targetId);
    link(s, t);
    link(t, s);
  }

  // BFS hop-distance from the focus.
  const depth = new Map<string, number>([[focusKey, 0]]);
  const queue = [focusKey];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const nb of adj.get(cur) ?? []) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }

  // Group node keys by ring; anything unreachable (shouldn't happen for a neighborhood
  // result) lands one ring past the deepest known.
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const rings = new Map<number, string[]>();
  for (const n of nodes) {
    const key = nodeKey(n.type, n.id);
    const d = depth.get(key) ?? maxDepth + 1;
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d)!.push(key);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, keys] of rings) {
    if (d === 0) {
      positions.set(keys[0], { x: 0, y: 0 });
      continue;
    }
    const radius = d * RING_GAP;
    // Offset each ring's start angle a little so nodes don't line up radially.
    const offset = d * 0.6;
    keys.forEach((key, i) => {
      const angle = (i / keys.length) * Math.PI * 2 + offset;
      positions.set(key, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  return positions;
}

function toFlowNodes(
  nodes: GhostAware[],
  positions: Map<string, { x: number; y: number }>,
  degree: Map<string, number>,
  focusKey: string | null,
): CircleNode[] {
  return nodes.map((n) => {
    const key = nodeKey(n.type, n.id);
    const focus = key === focusKey;
    const deg = degree.get(key) ?? 0;
    const size = focus ? Math.max(FOCUS_MIN_SIZE, sizeForDegree(deg)) : sizeForDegree(deg);
    return {
      id: key,
      type: "circle",
      position: positions.get(key) ?? { x: 0, y: 0 },
      // Explicit dimensions so React Flow treats nodes as already-measured and shows
      // them immediately (its ResizeObserver measurement is unreliable in the RNW host).
      width: size,
      height: size,
      data: {
        entityType: n.type,
        entityId: n.id,
        label: n.title || "Untitled",
        ghost: !!n.ghost,
        focus,
        size,
        degree: deg,
      },
    };
  });
}

function toFlowEdges(edges: Graph["edges"], large: boolean): Edge[] {
  return edges.map((e, i) => {
    const embed = e.kind === "embed";
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
      style: {
        stroke: colors.borderStrong,
        strokeDasharray: embed ? undefined : "4 4",
      },
    };
  });
}

/** A circular graph node with a centered type icon and a hover popup (title + chevron)
 * that opens the item. Size comes from data.size; the focus node gets a persistent halo
 * and is not itself navigable (you're already on it). */
function CircleNode({ data }: NodeProps<CircleNode>) {
  const onOpenNode = useContext(GraphOpenContext);
  const dense = useContext(GraphDenseContext);
  const [hover, setHover] = useState(false);
  const accent = data.ghost ? colors.textTertiary : typeColor(data.entityType);
  const iconName = TYPE_ICON[data.entityType] ?? "dot";
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

  // In dense mode (zoomed-out overview) draw the node as a solid dot that matches the
  // canvas base layer, so the interactive DOM nodes blend into the full-graph picture and
  // the per-node icon SVG is skipped. Zoomed in (not dense), the full circle + icon return.
  const dot = dense && !data.focus;

  return (
    <div
      style={{ position: "relative", width: data.size, height: data.size }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
          background: dot
            ? data.ghost
              ? "transparent"
              : accent
            : data.ghost
              ? "transparent"
              : colors.surfaceCard,
          border: dot
            ? data.ghost
              ? `1px dashed ${accent}`
              : "none"
            : `${data.focus ? 3 : 2}px ${data.ghost ? "dashed" : "solid"} ${accent}`,
          opacity: data.ghost ? (dot ? 0.4 : 0.65) : dot ? 0.9 : 1,
          boxShadow: halo,
          transition: "box-shadow 120ms ease",
          cursor: navigable ? "pointer" : "default",
        }}
        onClick={open}
      >
        {dot ? null : <Icon name={iconName} size={iconSize} color={accent} />}
      </div>

      {dense ? null : (
        <div style={data.ghost ? { ...nodeLabelStyle, color: colors.textTertiary } : nodeLabelStyle}>
          {truncateLabel(data.label)}
        </div>
      )}

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
  /** When set (e.g. "note:<id>"), that node is centered and the rest fan out in rings. */
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

/** Choose which nodes get a real (interactive) DOM node. Everything inside `bounds` (or
 * all nodes when bounds is null, i.e. before the first move) is a candidate; if that
 * exceeds RENDER_BUDGET we keep the highest-degree candidates so the busiest hubs survive
 * a zoomed-out overview. Edges and the non-chosen nodes are still drawn — on the canvas
 * base layer — so nothing visually disappears; only interactivity is budgeted. */
function selectRender(
  allNodes: CircleNode[],
  bounds: { x0: number; y0: number; x1: number; y1: number } | null,
): CircleNode[] {
  const inView = bounds
    ? allNodes.filter(
        (n) => n.position.x >= bounds.x0 && n.position.x <= bounds.x1 && n.position.y >= bounds.y0 && n.position.y <= bounds.y1,
      )
    : allNodes;
  if (inView.length <= RENDER_BUDGET) return inView;
  return [...inView]
    .sort((a, b) => b.data.degree - a.data.degree || (a.id < b.id ? -1 : 1))
    .slice(0, RENDER_BUDGET);
}

/** Draws the entire graph — every node as a dot and every edge as a line — onto a single
 * <canvas> kept in sync with the React Flow viewport. This is the "show everything" layer:
 * one DOM element regardless of node count, so connections are never hidden. React Flow's
 * budgeted DOM nodes render on top of it for interaction; their edges are left to this
 * canvas so nothing is drawn twice. */
function GraphBaseLayer({ nodes, edges }: { nodes: CircleNode[]; edges: Edge[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // Rebuilt only when the graph changes, not per pan/zoom frame.
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

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

    const cx = (n: CircleNode) => n.position.x + n.data.size / 2;
    const cy = (n: CircleNode) => n.position.y + n.data.size / 2;

    // Edges first, batched into one stroke (all share a color).
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = colors.borderStrong;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (const e of edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      ctx.moveTo(cx(s), cy(s));
      ctx.lineTo(cx(t), cy(t));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Nodes as filled dots, colored by type (ghosts muted).
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(cx(n), cy(n), n.data.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = n.data.ghost ? colors.textTertiary : typeColor(n.data.entityType);
      ctx.globalAlpha = n.data.ghost ? 0.4 : 0.9;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [transform, width, height, nodes, edges, byId]);

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
  const { flowNodes, flowEdges, large } = useMemo(() => {
    const nodes = withGhosts(graph);
    const degree = degreesOf(graph.edges);
    const large = nodes.length > LARGE_GRAPH_THRESHOLD;
    const positions =
      focusKey && nodes.some((n) => nodeKey(n.type, n.id) === focusKey)
        ? focusLayout(nodes, graph.edges, focusKey)
        : radialLayout(nodes, degree, graph.edges);
    return {
      flowNodes: toFlowNodes(nodes, positions, degree, focusKey),
      flowEdges: toFlowEdges(graph.edges, large),
      large,
    };
  }, [graph, focusKey]);

  return (
    <GraphOpenContext.Provider value={onOpenNode ?? noop}>
      <ReactFlowProvider>
        <GraphCanvas flowNodes={flowNodes} flowEdges={flowEdges} large={large} />
      </ReactFlowProvider>
    </GraphOpenContext.Provider>
  );
}

function GraphCanvas({
  flowNodes,
  flowEdges,
  large,
}: {
  flowNodes: CircleNode[];
  flowEdges: Edge[];
  large: boolean;
}) {
  // React Flow is controlled here, so it needs the change handlers from these hooks to
  // write back internal updates. On a large graph `nodes` holds only the budgeted subset;
  // it's re-selected on move-end and whenever the derived graph changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<CircleNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [width, height] = useStore((s): [number, number] => [s.width, s.height], (a, b) => a[0] === b[0] && a[1] === b[1]);
  // Last viewport seen from onMoveEnd; null until the user first pans/zooms, when the whole
  // graph is a candidate (budgeted to the top hubs for the overview).
  const viewportRef = useRef<Viewport | null>(null);

  const reselect = useCallback(() => {
    if (!large) {
      setNodes(flowNodes);
      setEdges(flowEdges);
      return;
    }
    const bounds = viewportRef.current ? viewportBounds(viewportRef.current, width, height) : null;
    setNodes(selectRender(flowNodes, bounds));
    // Edges (and every non-budgeted node) are painted by GraphBaseLayer instead, so React
    // Flow only carries the interactive subset.
    setEdges([]);
  }, [flowNodes, flowEdges, large, width, height, setNodes, setEdges]);

  useEffect(() => {
    reselect();
  }, [reselect]);

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      viewportRef.current = vp;
      reselect();
    },
    [reselect],
  );

  // Dense (captions/interaction off) whenever the rendered set is still crowded. Because
  // the budget caps the count, zooming into a sparse region drops it below the limit and
  // brings captions + selection back.
  const dense = large && nodes.length > DENSE_VISIBLE_LIMIT;

  return (
    <GraphDenseContext.Provider value={dense}>
      {/* Fill the RNW parent View (which is position:relative) with an absolutely-sized
          box so React Flow measures a real height — a plain height:100% collapses to 0 in
          the flex layout and leaves nodes hidden. */}
      <div style={fillStyle}>
        {/* The full graph (every node + edge) as one canvas behind React Flow. React Flow
            is stacked above it (zIndex 1) and kept transparent so the canvas shows through
            everywhere except under the interactive DOM nodes. */}
        {large ? <GraphBaseLayer nodes={flowNodes} edges={flowEdges} /> : null}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onMoveEnd={large ? onMoveEnd : undefined}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.05}
          nodesConnectable={false}
          nodesDraggable={!dense}
          // Cull anything off-screen among the already-budgeted set as you pan/zoom.
          onlyRenderVisibleElements={large}
          // Trim per-element event wiring and selection re-renders while the view is dense;
          // they come back once zoomed in (nodes still open via their own click handler).
          elementsSelectable={!dense}
          nodesFocusable={!dense}
          edgesFocusable={false}
          disableKeyboardA11y={dense}
          style={large ? { background: "transparent", position: "relative", zIndex: 1 } : undefined}
        >
          <Background color={colors.borderSubtle} gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </GraphDenseContext.Provider>
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
