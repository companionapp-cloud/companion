import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon, colors, type IconName } from "@companion/design-system";
import type { Graph, GraphNode } from "@companion/core-bridge";

/** How a node open is dispatched. Decoupled from useNav() so the same renderer works in
 * the app (nav.openNote) and inside the mobile graph WebView (postMessage). */
export type OpenNodeHandler = (type: string, id: string, newTab: boolean) => void;
const GraphOpenContext = createContext<OpenNodeHandler>(() => {});

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
}
type CircleNode = Node<CircleData, "circle">;

const MIN_SIZE = 32;
const MAX_SIZE = 72;
const FOCUS_MIN_SIZE = 52;
const RING_GAP = 190;

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

/** Deterministic radial layout — hubs (highest degree) placed first around the ring so
 * the busiest nodes spread out. Used for the whole-knowledgebase view. */
function radialLayout(nodes: GhostAware[], degree: Map<string, number>) {
  const ordered = [...nodes].sort(
    (a, b) => (degree.get(nodeKey(b.type, b.id)) ?? 0) - (degree.get(nodeKey(a.type, a.id)) ?? 0),
  );
  const radius = Math.max(180, ordered.length * 46);
  const positions = new Map<string, { x: number; y: number }>();
  ordered.forEach((n, i) => {
    const angle = (i / Math.max(1, ordered.length)) * Math.PI * 2;
    positions.set(nodeKey(n.type, n.id), { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
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
    const size = focus ? Math.max(FOCUS_MIN_SIZE, sizeForDegree(degree.get(key) ?? 0)) : sizeForDegree(degree.get(key) ?? 0);
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
      },
    };
  });
}

function toFlowEdges(edges: Graph["edges"]): Edge[] {
  return edges.map((e, i) => {
    const embed = e.kind === "embed";
    return {
      id: `e${i}`,
      source: nodeKey(e.sourceType, e.sourceId),
      target: nodeKey(e.targetType, e.targetId),
      animated: embed,
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
  const [hover, setHover] = useState(false);
  const accent = data.ghost ? colors.textTertiary : typeColor(data.entityType);
  const iconName = TYPE_ICON[data.entityType] ?? "dot";
  const iconSize = Math.round(data.size * 0.5);
  const navigable = data.entityType === "note" && !data.focus;

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
  /** When set (e.g. "note:<id>"), that node is centered and the rest fan out in rings. */
  focusKey?: string | null;
  /** Invoked when a node is opened (only notes are navigable today). */
  onOpenNode?: OpenNodeHandler;
}

/** The pure canvas: takes a resolved graph and renders it. Data fetching and empty-state
 * messaging live in the wrapper screens (GraphScreen, NoteGraph). */
export function GraphView({ graph, focusKey = null, onOpenNode }: GraphViewProps) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const nodes = withGhosts(graph);
    const degree = degreesOf(graph.edges);
    const positions =
      focusKey && nodes.some((n) => nodeKey(n.type, n.id) === focusKey)
        ? focusLayout(nodes, graph.edges, focusKey)
        : radialLayout(nodes, degree);
    return { flowNodes: toFlowNodes(nodes, positions, degree, focusKey), flowEdges: toFlowEdges(graph.edges) };
  }, [graph, focusKey]);

  // React Flow is controlled here, so it needs the change handlers from these hooks to
  // write back internal updates. We re-seed the state whenever the derived graph changes;
  // drags in between persist because flowNodes only changes on real data changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<CircleNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [flowNodes, flowEdges, setNodes, setEdges]);

  return (
    // Fill the RNW parent View (which is position:relative) with an absolutely-sized box
    // so React Flow measures a real height — a plain height:100% collapses to 0 in the
    // flex layout and leaves nodes hidden.
    <GraphOpenContext.Provider value={onOpenNode ?? noop}>
      <div style={fillStyle}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          nodesConnectable={false}
          nodesDraggable
        >
          <Background color={colors.borderSubtle} gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </GraphOpenContext.Provider>
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
