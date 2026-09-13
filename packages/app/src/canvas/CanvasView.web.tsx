import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnNodeDrag,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CanvasDocument, CanvasEdge, CanvasEdgeInput, CanvasEdgeStyle, CanvasEnd, CanvasNode, CanvasNodeInput, CanvasRefs, CanvasSide } from "@companion/core-bridge";
import { Icon, colors, swatches, type IconName } from "@companion/design-system";
import { NODE_DEFAULTS, type CanvasHost, type CanvasRefKind } from "./host";
import { bounds, containedIds, nearestSides, type Rect } from "./geometry";

// The canvas renderer (PLAN-canvases.md §3.3): React Flow with one custom node type that
// switches on the node kind, one custom edge type with per-end arrowheads and an inline
// label, a floating toolbar, and a selection toolbar. DOM-only — web/desktop render it
// straight in the page; mobile hosts the same component inside a WebView. Everything it
// reads or writes goes through CanvasHost, so this file imports nothing from the app's
// provider tree.
//
// Data flow: the host's CanvasDocument is the source of truth; it is mirrored into React
// Flow's node/edge state, edited there, and every settled interaction (drag stop, resize
// end, text blur, connect, delete) is committed back through the host as a batch. Change
// events from the host reload the document and merge it in, skipping any node the user is
// currently dragging, resizing, or typing into ("held" nodes).

// ---- model -----------------------------------------------------------------------------

interface NodeData extends Record<string, unknown> {
  node: CanvasNode;
  refs: CanvasRefs;
}
type FlowNode = Node<NodeData, "canvas">;
interface EdgeData extends Record<string, unknown> {
  edge: CanvasEdge;
}
type FlowEdge = Edge<EdgeData, "canvas">;

const SIDE_POSITION: Record<CanvasSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

const GRID = 8;
const HISTORY_LIMIT = 100;
const nodeRect = (n: FlowNode): Rect & { id: string } => ({
  id: n.id,
  x: n.position.x,
  y: n.position.y,
  width: n.width ?? n.data.node.width,
  height: n.height ?? n.data.node.height,
});

// Cards stack this far above groups, so "send to back" on a card never drops it beneath a
// group and a card dragged into a group is always on top of it.
const CARD_Z_OFFSET = 1000;
function nodeZ(n: CanvasNode): number {
  return n.kind === "group" ? n.z : n.z + CARD_Z_OFFSET;
}

function toFlowNode(n: CanvasNode, refs: CanvasRefs, prev?: FlowNode): FlowNode {
  return {
    id: n.id,
    type: "canvas",
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    zIndex: nodeZ(n),
    selected: prev?.selected ?? false,
    // Keep React Flow's measurement: rebuilding a node without `measured` makes it forget
    // the handle bounds, and every edge touching it disappears until a re-measure.
    ...(prev?.measured ? { measured: prev.measured } : {}),
    data: { node: n, refs },
  };
}

function toFlowEdge(e: CanvasEdge, nodes: Map<string, FlowNode>, prev?: FlowEdge): FlowEdge {
  let fromSide = e.fromSide ?? null;
  let toSide = e.toSide ?? null;
  if (!fromSide || !toSide) {
    const a = nodes.get(e.fromNodeId);
    const b = nodes.get(e.toNodeId);
    if (a && b) {
      const auto = nearestSides(nodeRect(a), nodeRect(b));
      fromSide = fromSide ?? auto.fromSide;
      toSide = toSide ?? auto.toSide;
    }
  }
  return {
    id: e.id,
    type: "canvas",
    source: e.fromNodeId,
    target: e.toNodeId,
    sourceHandle: fromSide ?? "right",
    targetHandle: toSide ?? "left",
    selected: prev?.selected ?? false,
    // Endings are drawn by CanvasEdgeView itself (React Flow's markers are tiny and only
    // know arrows), so no markerStart/markerEnd here.
    data: { edge: e },
  };
}

function nodeInput(n: FlowNode): CanvasNodeInput {
  const c = n.data.node;
  return {
    id: c.id,
    kind: c.kind,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? c.width,
    height: n.height ?? c.height,
    z: c.z,
    color: c.color ?? null,
    refType: c.refType ?? null,
    refId: c.refId ?? null,
    data: c.data ?? {},
  };
}

function edgeInput(e: CanvasEdge): CanvasEdgeInput {
  return {
    id: e.id,
    fromNodeId: e.fromNodeId,
    toNodeId: e.toNodeId,
    fromSide: e.fromSide ?? null,
    toSide: e.toSide ?? null,
    fromEnd: e.fromEnd,
    toEnd: e.toEnd,
    style: e.style ?? "curved",
    label: e.label,
    color: e.color ?? null,
  };
}

/** A point-in-time copy of the board (as write inputs) for undo/redo. */
interface Snapshot {
  nodes: CanvasNodeInput[];
  edges: CanvasEdgeInput[];
}

// ---- actions context (node components → view) ------------------------------------------

interface CanvasActions {
  /** Merge a patch into a node's kind-specific data and persist it. */
  updateData: (id: string, patch: Record<string, unknown>) => void;
  /** Persist a resize (React Flow already applied the new box to the node). */
  commitResize: (id: string) => void;
  hold: (id: string) => void;
  release: (id: string) => void;
  openRef: CanvasHost["openRef"];
  openUrl: CanvasHost["openUrl"];
  setTaskStatus: CanvasHost["setTaskStatus"];
  resolveDocument: CanvasHost["resolveDocument"];
  /** Set a node's box (an image adopting its natural aspect on first load). */
  resizeTo: (id: string, width: number, height: number) => void;
  /** Re-fetch a link node's preview. */
  refreshPreview: (id: string) => void;
  /** Persist an edge's label / ends / color. */
  updateEdge: (id: string, patch: Partial<Pick<CanvasEdge, "label" | "fromEnd" | "toEnd" | "color">>) => void;
}
const ActionsCtx = createContext<CanvasActions | null>(null);

/** A keyboard request to start editing a card's text / a group's label / an edge's label
 *  (Enter on the selection). Cards subscribe and flip into edit mode when it names them. */
interface EditRequest {
  kind: "node" | "edge";
  id: string;
  seq: number;
}
const EditRequestCtx = createContext<EditRequest | null>(null);

// Cards copied with ⌘C travel on the system clipboard as text under this marker, so they
// paste across boards and windows; the in-memory copy is the fallback when the clipboard
// API is unavailable.
const CLIP_MARKER = "companion-canvas/v1:";
interface ClipPayload {
  nodes: CanvasNodeInput[];
  edges: { from: number; to: number; fromSide: CanvasSide | null; toSide: CanvasSide | null; fromEnd: CanvasEdge["fromEnd"]; toEnd: CanvasEdge["toEnd"]; label: string; color: string | null }[];
}
let internalClipboard: ClipPayload | null = null;

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
/** The shortcut reference shown by `?`. Kept as data so the overlay and the handler agree. */
const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  { group: "Add", items: [["T", "Sticky note"], ["G", "Group (around the selection)"], ["N", "Note"], ["K", "Task"], ["E", "Event"], ["I", "Image"], ["L", "Link"], ["Double-click", "Sticky note here"], [`${MOD} V`, "Paste a URL, image, text, or copied cards"]] },
  { group: "Select", items: [[`${MOD} A`, "Select all"], ["Esc", "Clear selection / stop editing"], ["Shift drag", "Box select"], [`${MOD} click`, "Add to selection"], ["Tab / Shift Tab", "Cycle through cards"]] },
  { group: "Edit", items: [["Enter", "Edit text or label, or open the card"], ["Delete", "Delete selection"], [`${MOD} D`, "Duplicate"], [`${MOD} C / X`, "Copy / cut cards"], ["1–9, 0", "Color swatch / clear color"], [`${MOD} ] / [`, "Bring to front / send to back"], [`${MOD} Shift G / U`, "Group selection / remove group"]] },
  { group: "Arrange", items: [["Arrows", "Nudge"], ["Shift arrows", "Nudge ×4"], [`${MOD} Shift H / V`, "Align centers on a row / column"], [`${MOD} Shift D`, "Distribute evenly"], ["Alt drag", "Drag a copy"]] },
  { group: "Connect", items: [["Drag from a card edge", "Connect"], ["Drag an arrow's end", "Move it to another card"], ["C", "Connect the two selected cards"], [`${MOD} Shift A`, "Cycle arrowheads"], [`${MOD} Shift L`, "Cycle line style"], ["R", "Reverse arrow"], ["Enter (edge)", "Edit label"]] },
  { group: "View", items: [[`${MOD} 0`, "Fit board"], [`${MOD} 1`, "Zoom 100%"], [`${MOD} 2`, "Zoom to selection"], [`${MOD} + / −`, "Zoom in / out"], ["Space drag", "Pan"], ["H", "Toggle snap to grid"], ["F", "Toggle minimap"]] },
  { group: "Board", items: [[`${MOD} Z / Shift Z`, "Undo / redo"], [`${MOD} K`, "Find a card"], [`${MOD} Shift N`, "New canvas"], ["?", "This list"]] },
];
const useActions = () => {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error("canvas actions missing");
  return v;
};

// ---- styles ----------------------------------------------------------------------------

const fillStyle: CSSProperties = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, background: colors.surfaceApp };
const cardFont = "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif";

/** Tints a hex color to a soft wash for card/group backgrounds. */
function wash(hex: string | null | undefined, alpha: number): string {
  if (!hex || !/^#([0-9a-f]{6})$/i.test(hex)) return colors.surfaceCard;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const handleStyle: CSSProperties = {
  width: 10,
  height: 10,
  background: colors.surfaceCard,
  border: `2px solid ${colors.accent}`,
  borderRadius: 999,
  opacity: 0,
  transition: "opacity 120ms",
};

/** The four connection handles every non-group node carries. Hidden until the node is
 *  hovered or selected (via the `.react-flow__node:hover .canvas-handle` rule below). */
function Handles() {
  return (
    <>
      {(["top", "right", "bottom", "left"] as CanvasSide[]).map((side) => (
        <Handle key={side} id={side} type="source" position={SIDE_POSITION[side]} className="canvas-handle" style={handleStyle} />
      ))}
    </>
  );
}

const CANVAS_CSS = `
.react-flow__node:hover .canvas-handle, .react-flow__node.selected .canvas-handle, .react-flow__connection ~ * .canvas-handle, .react-flow.connecting .canvas-handle { opacity: 1 !important; }
.react-flow__node.selected > .canvas-card { box-shadow: 0 0 0 2px ${colors.accent}, 0 6px 20px rgba(0,0,0,0.10) !important; }
.react-flow__node.selected > .canvas-group { box-shadow: 0 0 0 2px ${colors.accent} !important; }
.react-flow__edge.selected .react-flow__edge-path { stroke-width: 3 !important; }
.react-flow__edge.selected .canvas-edge-end { stroke-width: 3; }
.react-flow__edgeupdater { fill: ${colors.surfaceCard}; stroke: ${colors.accent}; stroke-width: 2; r: 5px; cursor: grab; opacity: 0; transition: opacity 120ms; }
.react-flow__edge.selected .react-flow__edgeupdater, .react-flow__edge:hover .react-flow__edgeupdater { opacity: 1; }
.canvas-textarea { font: inherit; color: inherit; background: transparent; border: 0; outline: 0; resize: none; width: 100%; height: 100%; padding: 0; margin: 0; line-height: 1.4; }
.canvas-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid ${colors.borderSubtle}; background: ${colors.surfaceCard}; color: ${colors.textSecondary}; font: 500 12px ${cardFont}; cursor: pointer; }
.canvas-btn:hover { background: ${colors.surfaceHover}; color: ${colors.textPrimary}; }
.canvas-btn:disabled { opacity: 0.45; cursor: default; }
.canvas-btn.icon { width: 30px; padding: 0; }
.canvas-btn.on { background: ${colors.accentSoft}; border-color: ${colors.accentSoftBorder}; color: ${colors.accentHover}; }
.canvas-swatch { width: 18px; height: 18px; border-radius: 999px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.canvas-swatch.on { border-color: ${colors.textPrimary}; }
`;

// ---- node renderers --------------------------------------------------------------------

const cardBase: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  borderRadius: 12,
  border: `1px solid ${colors.borderSubtle}`,
  background: colors.surfaceCard,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  fontFamily: cardFont,
  fontSize: 13,
  color: colors.textPrimary,
  overflow: "hidden",
};

const CanvasNodeView = memo(function CanvasNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { node, refs } = data;
  const actions = useActions();
  const onResizeEnd = useCallback(() => actions.commitResize(id), [actions, id]);
  const resizer = (
    <NodeResizer
      isVisible={selected}
      keepAspectRatio={node.kind === "image"}
      minWidth={node.kind === "group" ? 120 : 80}
      minHeight={node.kind === "group" ? 80 : 40}
      color={colors.accent}
      lineStyle={{ borderWidth: 1 }}
      handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      onResizeStart={() => actions.hold(id)}
      onResizeEnd={() => {
        actions.release(id);
        onResizeEnd();
      }}
    />
  );
  switch (node.kind) {
    case "group":
      return (
        <>
          {resizer}
          <GroupCard node={node} />
        </>
      );
    case "text":
      return (
        <>
          {resizer}
          <StickyCard node={node} selected={selected} />
          <Handles />
        </>
      );
    case "note":
      return (
        <>
          {resizer}
          <NoteCard node={node} refs={refs} />
          <Handles />
        </>
      );
    case "task":
      return (
        <>
          {resizer}
          <TaskCard node={node} refs={refs} />
          <Handles />
        </>
      );
    case "event":
      return (
        <>
          {resizer}
          <EventCard node={node} refs={refs} />
          <Handles />
        </>
      );
    case "image":
      return (
        <>
          {resizer}
          <ImageCard node={node} refs={refs} />
          <Handles />
        </>
      );
    case "link":
      return (
        <>
          {resizer}
          <LinkCard node={node} />
          <Handles />
        </>
      );
    default:
      return (
        <>
          {resizer}
          <div className="canvas-card" style={cardBase}>
            <div style={{ padding: 12, color: colors.textTertiary }}>{node.kind} nodes arrive in a later phase.</div>
          </div>
          <Handles />
        </>
      );
  }
});

/** A sticky note: a tinted card whose text edits inline on double-click. */
function StickyCard({ node, selected }: { node: CanvasNode; selected: boolean }) {
  const actions = useActions();
  const text = typeof node.data?.text === "string" ? node.data.text : "";
  const [editing, setEditing] = useState(text === "");
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const editReq = useContext(EditRequestCtx);
  useEffect(() => {
    if (editReq?.kind === "node" && editReq.id === node.id) setEditing(true);
  }, [editReq, node.id]);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  useEffect(() => {
    if (editing) {
      actions.hold(node.id);
      ref.current?.focus();
    }
    return () => {
      if (editing) actions.release(node.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);
  const commit = () => {
    setEditing(false);
    if (draft !== text) actions.updateData(node.id, { text: draft });
  };
  const color = node.color ?? "#eab308";
  return (
    <div
      className="canvas-card"
      style={{ ...cardBase, background: wash(color, 0.22), border: `1px solid ${wash(color, 0.6)}`, padding: 12, cursor: editing ? "text" : undefined }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {editing ? (
        <textarea
          ref={ref}
          className="canvas-textarea nodrag nowheel nopan"
          value={draft}
          placeholder="Type something…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              commit();
            }
            e.stopPropagation();
          }}
        />
      ) : (
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4, height: "100%", overflow: "hidden", color: text ? colors.textPrimary : colors.textTertiary }}>
          {text || "Double-click to edit"}
        </div>
      )}
    </div>
  );
}

/** A group: a tinted rectangle behind other nodes with an inline-editable label. */
function GroupCard({ node }: { node: CanvasNode }) {
  const actions = useActions();
  const label = typeof node.data?.label === "string" ? node.data.label : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const editReq = useContext(EditRequestCtx);
  useEffect(() => {
    if (editReq?.kind === "node" && editReq.id === node.id) {
      actions.hold(node.id);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editReq, node.id]);
  useEffect(() => {
    if (!editing) setDraft(label);
  }, [label, editing]);
  const commit = () => {
    setEditing(false);
    actions.release(node.id);
    if (draft !== label) actions.updateData(node.id, { label: draft });
  };
  const color = node.color ?? "#64748b";
  return (
    <div
      className="canvas-group"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 14,
        border: `1.5px dashed ${wash(color, 0.7)}`,
        background: wash(color, 0.08),
        fontFamily: cardFont,
      }}
    >
      <div
        style={{ position: "absolute", top: -1, left: 12, transform: "translateY(-50%)", padding: "2px 10px", borderRadius: 999, background: wash(color, 0.9), color: "#fff", fontSize: 12, fontWeight: 600, maxWidth: "calc(100% - 24px)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          actions.hold(node.id);
          setEditing(true);
        }}
      >
        {editing ? (
          <input
            autoFocus
            className="nodrag nopan"
            value={draft}
            placeholder="Group"
            style={{ font: "inherit", color: "inherit", background: "transparent", border: 0, outline: 0, width: 160 }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") commit();
              e.stopPropagation();
            }}
          />
        ) : (
          label || "Group"
        )}
      </div>
    </div>
  );
}

/** An embedded note: title + excerpt; double-click opens it. */
function NoteCard({ node, refs }: { node: CanvasNode; refs: CanvasRefs }) {
  const actions = useActions();
  const ref = node.refId ? refs.notes[node.refId] : undefined;
  const missing = !ref || ref.missing;
  return (
    <div
      className="canvas-card"
      style={{ ...cardBase, borderLeft: `4px solid ${node.color ?? colors.success}`, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6, cursor: "default" }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.refId && !missing) actions.openRef({ type: "note", id: node.refId });
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: colors.textTertiary, fontSize: 11 }}>
        <Icon name="file" size={13} color={colors.textTertiary} />
        <span>Note</span>
      </div>
      {missing ? (
        <div style={{ color: colors.textTertiary }}>This note is gone.</div>
      ) : (
        <>
          <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ref.title || "Untitled"}</div>
          <div style={{ color: colors.textSecondary, lineHeight: 1.4, overflow: "hidden", flex: 1 }}>{ref.excerpt || "No additional text"}</div>
        </>
      )}
    </div>
  );
}

/** An embedded task: a checkbox that flips its status, the title, and its due date. */
function TaskCard({ node, refs }: { node: CanvasNode; refs: CanvasRefs }) {
  const actions = useActions();
  const ref = node.refId ? refs.tasks[node.refId] : undefined;
  const missing = !ref || ref.missing;
  const done = ref?.status === "done";
  return (
    <div
      className="canvas-card"
      style={{ ...cardBase, borderLeft: `4px solid ${node.color ?? colors.info}`, padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 10 }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.refId && !missing) actions.openRef({ type: "task", id: node.refId });
      }}
    >
      {missing ? (
        <div style={{ color: colors.textTertiary }}>This task is gone.</div>
      ) : (
        <>
          <button
            type="button"
            className="nodrag nopan"
            aria-label={done ? "Mark open" : "Mark done"}
            onClick={(e) => {
              e.stopPropagation();
              if (node.refId) void actions.setTaskStatus(node.refId, done ? "open" : "done");
            }}
            style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${done ? colors.accent : colors.borderStrong}`, background: done ? colors.accent : colors.surfaceCard, cursor: "pointer", padding: 0, flexShrink: 0, marginTop: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            {done ? <Icon name="check" size={12} color="#fff" /> : null}
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, textDecoration: done ? "line-through" : undefined, color: done ? colors.textTertiary : colors.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ref.title || "Untitled task"}
            </div>
            {ref.dueAt ? (
              <div style={{ color: colors.textTertiary, fontSize: 11, marginTop: 4 }}>Due {new Date(ref.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** "Fri, Jul 10 · 9:00 AM – 10:00 AM" for an event card, from the hydrated ref or the
 *  node's cached copy. */
function eventWhen(startsAt: string, endsAt: string | null | undefined, allDay: boolean): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "";
  const date = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (allDay) return `${date} · All day`;
  const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const end = endsAt ? new Date(endsAt) : null;
  return `${date} · ${end && !Number.isNaN(end.getTime()) ? `${clock(start)} – ${clock(end)}` : clock(start)}`;
}

/** An embedded calendar event: title, when, location. Falls back to the copy cached on the
 *  node when the feed no longer carries the event; double-click opens the calendar. */
function EventCard({ node, refs }: { node: CanvasNode; refs: CanvasRefs }) {
  const actions = useActions();
  const ref = node.refId ? refs.events[node.refId] : undefined;
  const cached = (node.data ?? {}) as { title?: string; startsAt?: string; endsAt?: string | null; allDay?: boolean };
  const live = ref && !ref.missing ? ref : null;
  const title = live?.title ?? cached.title ?? "Event";
  const startsAt = live?.startsAt ?? cached.startsAt;
  const stale = !live;
  return (
    <div
      className="canvas-card"
      style={{ ...cardBase, borderLeft: `4px solid ${node.color ?? colors.gray500}`, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.refId) actions.openRef({ type: "event", id: node.refId });
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: colors.textTertiary, fontSize: 11 }}>
        <Icon name="calendar" size={13} color={colors.textTertiary} />
        <span>Event</span>
        {stale ? <span style={{ marginLeft: "auto", color: colors.warning }}>not on the calendar anymore</span> : null}
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      {startsAt ? <div style={{ color: colors.textSecondary }}>{eventWhen(startsAt, live?.endsAt ?? cached.endsAt, live?.allDay ?? !!cached.allDay)}</div> : null}
      {live?.location ? <div style={{ color: colors.textTertiary, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{live.location}</div> : null}
    </div>
  );
}

/** An image document. The URL is resolved through the host (an object URL on web, a data
 *  URL on native); on first load the node adopts the image's natural aspect ratio. */
function ImageCard({ node, refs }: { node: CanvasNode; refs: CanvasRefs }) {
  const actions = useActions();
  const doc = node.refId ? refs.documents[node.refId] : undefined;
  const missing = !doc || doc.missing;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const hasAspect = typeof node.data?.aspect === "number";
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    if (!node.refId || missing) return;
    void actions
      .resolveDocument(node.refId)
      .then((r) => {
        if (cancelled) return;
        if (r) setUrl(r.url);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // resolveDocument is stable; re-resolve when the document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.refId, missing]);
  return (
    <div className="canvas-card" style={{ ...cardBase, padding: 0, background: colors.surfaceSunken, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {missing ? (
        <div style={{ color: colors.textTertiary, padding: 12 }}>This image is gone.</div>
      ) : url ? (
        <img
          src={url}
          alt={typeof node.data?.alt === "string" ? node.data.alt : doc?.filename ?? ""}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: hasAspect ? "fill" : "contain", display: "block", pointerEvents: "none" }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (hasAspect || !img.naturalWidth || !img.naturalHeight) return;
            const aspect = img.naturalWidth / img.naturalHeight;
            actions.updateData(node.id, { aspect });
            actions.resizeTo(node.id, node.width, Math.round(node.width / aspect));
          }}
        />
      ) : failed ? (
        <div style={{ color: colors.textTertiary, padding: 12, textAlign: "center" }}>
          <Icon name="image" size={20} color={colors.textTertiary} />
          <div style={{ marginTop: 6 }}>{doc?.filename ?? "Image"} isn't downloaded yet.</div>
        </div>
      ) : (
        <div style={{ color: colors.textTertiary }}>Loading…</div>
      )}
    </div>
  );
}

/** A link card: the page's preview image, title, description, and site. Click opens the
 *  URL; the card fetches its preview once and keeps it on the node. */
function LinkCard({ node }: { node: CanvasNode }) {
  const actions = useActions();
  const d = (node.data ?? {}) as { url?: string; title?: string; description?: string; imageUrl?: string; siteName?: string; faviconUrl?: string; fetchedAt?: string; error?: string };
  const [imgFailed, setImgFailed] = useState(false);
  const [favFailed, setFavFailed] = useState(false);
  const loading = !d.fetchedAt && !d.error;
  // Web can't read other sites without the sync server's proxy; say so instead of showing
  // a silently bare card.
  const unavailable = !loading && d.error ? (/sync/i.test(d.error) ? "Preview unavailable until sync is connected" : "Preview unavailable") : "";
  const host = (() => {
    try {
      return d.url ? new URL(d.url).hostname.replace(/^www\./, "") : "";
    } catch {
      return d.url ?? "";
    }
  })();
  return (
    <div
      className="canvas-card"
      style={{ ...cardBase, padding: 0, display: "flex", flexDirection: "column", cursor: "pointer" }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (d.url) actions.openUrl(d.url);
      }}
    >
      {d.imageUrl && !imgFailed ? (
        <img src={d.imageUrl} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setImgFailed(true)} style={{ width: "100%", flex: "1 1 0", minHeight: 0, objectFit: "cover", display: "block", pointerEvents: "none", background: colors.surfaceSunken }} />
      ) : (
        <div style={{ flex: "1 1 0", minHeight: 0, background: colors.surfaceSunken, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="link" size={22} color={colors.textTertiary} />
        </div>
      )}
      <div style={{ padding: "8px 12px 10px", display: "flex", flexDirection: "column", gap: 3, flexShrink: 0, maxHeight: "60%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: colors.textTertiary, fontSize: 11, minWidth: 0 }}>
          {d.faviconUrl && !favFailed ? <img src={d.faviconUrl} alt="" width={12} height={12} referrerPolicy="no-referrer" onError={() => setFavFailed(true)} style={{ borderRadius: 2, flexShrink: 0 }} /> : null}
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.siteName || host}</span>
          <button
            type="button"
            className="nodrag nopan"
            title="Refresh preview"
            aria-label="Refresh preview"
            onClick={(e) => {
              e.stopPropagation();
              actions.refreshPreview(node.id);
            }}
            style={{ marginLeft: "auto", border: 0, background: "transparent", color: colors.textTertiary, cursor: "pointer", padding: 2, display: "inline-flex" }}
          >
            <Icon name="refresh" size={12} color="currentColor" />
          </button>
        </div>
        <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          {loading ? "Fetching preview…" : d.title || d.url}
        </div>
        {d.description ? (
          <div style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{d.description}</div>
        ) : unavailable ? (
          <div style={{ color: colors.textTertiary, fontSize: 11 }}>{unavailable}</div>
        ) : null}
      </div>
    </div>
  );
}

const nodeTypes = { canvas: CanvasNodeView };

// ---- edge renderer ---------------------------------------------------------------------

// ---- edge geometry ----------------------------------------------------------------------

/** Unit vector pointing out of a node through the given side. */
function outward(p: Position): { x: number; y: number } {
  switch (p) {
    case Position.Top: return { x: 0, y: -1 };
    case Position.Bottom: return { x: 0, y: 1 };
    case Position.Left: return { x: -1, y: 0 };
    default: return { x: 1, y: 0 };
  }
}

/** How far the line stops short of the endpoint so it doesn't poke through the ending. */
const END_INSET: Record<CanvasEnd, number> = { none: 0, arrow: 0, arrowFilled: 11, dot: 5, dotFilled: 0 };
const END_SIZE = 12;
const DOT_R = 5;

/** One ending, drawn with its tip at (x, y) pointing along `dir` (a unit vector). */
function EdgeEnding({ end, x, y, dir, color, edgeId }: { end: CanvasEnd; x: number; y: number; dir: { x: number; y: number }; color: string; edgeId: string }) {
  if (end === "none") return null;
  const angle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  const t = `translate(${x} ${y}) rotate(${angle})`;
  const s = END_SIZE;
  switch (end) {
    case "arrow":
      return <path className="canvas-edge-end" d={`M ${-s} ${-s / 2} L 0 0 L ${-s} ${s / 2}`} transform={t} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />;
    case "arrowFilled":
      return <path className="canvas-edge-end" d={`M 0 0 L ${-s} ${-s / 2} L ${-s + 3} 0 L ${-s} ${s / 2} Z`} transform={t} fill={color} stroke={color} strokeWidth={1.5} strokeLinejoin="round" pointerEvents="none" />;
    case "dot":
      return <circle className="canvas-edge-end" cx={x} cy={y} r={DOT_R} fill={colors.surfaceApp} stroke={color} strokeWidth={2} pointerEvents="none" data-edge={edgeId} />;
    case "dotFilled":
      return <circle className="canvas-edge-end" cx={x} cy={y} r={DOT_R} fill={color} stroke={color} strokeWidth={1} pointerEvents="none" />;
  }
}

/** The edge path for a style between two (already inset) endpoints. */
function edgePath(style: CanvasEdgeStyle, p: { sourceX: number; sourceY: number; targetX: number; targetY: number; sourcePosition: Position; targetPosition: Position }): [string, number, number] {
  switch (style) {
    case "straight": {
      const [d, lx, ly] = getStraightPath(p);
      return [d, lx, ly];
    }
    case "step": {
      const [d, lx, ly] = getSmoothStepPath({ ...p, borderRadius: 10, offset: 24 });
      return [d, lx, ly];
    }
    default: {
      const [d, lx, ly] = getBezierPath({ ...p, curvature: 0.3 });
      return [d, lx, ly];
    }
  }
}

function CanvasEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<FlowEdge>) {
  const actions = useActions();
  const edge = data?.edge;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edge?.label ?? "");
  const editReq = useContext(EditRequestCtx);
  useEffect(() => {
    if (editReq?.kind === "edge" && editReq.id === id) setEditing(true);
  }, [editReq, id]);
  useEffect(() => {
    if (!editing) setDraft(edge?.label ?? "");
  }, [edge?.label, editing]);

  const style: CanvasEdgeStyle = edge?.style ?? "curved";
  const fromEnd: CanvasEnd = edge?.fromEnd ?? "none";
  const toEnd: CanvasEnd = edge?.toEnd ?? "arrowFilled";
  const color = edge?.color ?? colors.borderStrong;

  // Tangents at each end. Curved and step paths leave/enter perpendicular to the node
  // side; a straight line runs directly between the handles.
  let leave = outward(sourcePosition); // direction the line travels as it leaves the source
  let arrive = { x: -outward(targetPosition).x, y: -outward(targetPosition).y }; // direction as it arrives at the target
  if (style === "straight") {
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const len = Math.hypot(dx, dy) || 1;
    leave = { x: dx / len, y: dy / len };
    arrive = leave;
  }
  const si = END_INSET[fromEnd];
  const ti = END_INSET[toEnd];
  const [path, labelX, labelY] = edgePath(style, {
    sourceX: sourceX + leave.x * si,
    sourceY: sourceY + leave.y * si,
    targetX: targetX - arrive.x * ti,
    targetY: targetY - arrive.y * ti,
    sourcePosition,
    targetPosition,
  });

  const commit = () => {
    setEditing(false);
    if (edge && draft !== edge.label) actions.updateEdge(id, { label: draft });
  };
  const showLabel = editing || (edge?.label ?? "") !== "";
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: 2, strokeLinecap: "round" }} interactionWidth={18} />
      {/* Endings: the source tip points back into the source node, the target tip into the target. */}
      <EdgeEnding end={fromEnd} x={sourceX} y={sourceY} dir={{ x: -leave.x, y: -leave.y }} color={color} edgeId={id} />
      <EdgeEnding end={toEnd} x={targetX} y={targetY} dir={arrive} color={color} edgeId={id} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            fontFamily: cardFont,
            fontSize: 12,
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              placeholder="Label"
              style={{ font: "inherit", padding: "2px 8px", borderRadius: 6, border: `1px solid ${colors.borderDefault}`, background: colors.surfaceCard, outline: 0, width: 140 }}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") commit();
                e.stopPropagation();
              }}
            />
          ) : showLabel ? (
            <span style={{ padding: "2px 8px", borderRadius: 6, background: colors.surfaceCard, border: `1px solid ${selected ? colors.accent : colors.borderSubtle}`, color: colors.textSecondary }}>{edge?.label}</span>
          ) : selected ? (
            <span style={{ padding: "2px 8px", borderRadius: 6, background: colors.surfaceCard, border: `1px dashed ${colors.borderDefault}`, color: colors.textTertiary, cursor: "text" }}>Add label</span>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** A tiny preview of an ending (or line style) for the selection toolbar. */
function EndGlyph({ end, atStart }: { end: CanvasEnd; atStart?: boolean }) {
  const c = "currentColor";
  // Draw in a 26×14 box with the line running left→right; the ending sits at the right
  // for "end" glyphs and is mirrored for "start" glyphs.
  const shape = (() => {
    switch (end) {
      case "arrow": return <path d="M17 3 L23 7 L17 11" fill="none" stroke={c} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />;
      case "arrowFilled": return <path d="M16 2.5 L24 7 L16 11.5 L18 7 Z" fill={c} />;
      case "dot": return <circle cx={20} cy={7} r={3.2} fill="none" stroke={c} strokeWidth={1.75} />;
      case "dotFilled": return <circle cx={20} cy={7} r={3.5} fill={c} />;
      default: return null;
    }
  })();
  const lineEnd = end === "none" ? 24 : end === "dot" ? 16.5 : end === "arrowFilled" ? 18 : 22;
  return (
    <svg width={26} height={14} viewBox="0 0 26 14" style={{ transform: atStart ? "scaleX(-1)" : undefined }} aria-hidden>
      <path d={`M2 7 H${lineEnd}`} stroke={c} strokeWidth={1.75} strokeLinecap="round" />
      {shape}
    </svg>
  );
}
function StyleGlyph({ style }: { style: CanvasEdgeStyle }) {
  const c = "currentColor";
  const d = style === "straight" ? "M2 12 L24 2" : style === "step" ? "M2 12 H13 V2 H24" : "M2 12 C 13 12, 13 2, 24 2";
  return (
    <svg width={26} height={14} viewBox="0 0 26 14" aria-hidden>
      <path d={d} fill="none" stroke={c} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ENDINGS: CanvasEnd[] = ["none", "arrow", "arrowFilled", "dot", "dotFilled"];
const END_LABEL: Record<CanvasEnd, string> = { none: "None", arrow: "Arrow", arrowFilled: "Filled arrow", dot: "Dot", dotFilled: "Filled dot" };
const STYLES: CanvasEdgeStyle[] = ["curved", "step", "straight"];
const STYLE_LABEL: Record<CanvasEdgeStyle, string> = { curved: "Curved", step: "Steps", straight: "Straight" };

const edgeTypes = { canvas: CanvasEdgeView };

// ---- the view --------------------------------------------------------------------------

export interface CanvasViewProps {
  host: CanvasHost;
  canvasId: string;
}

/** Imperative entry points for the surrounding editor (drops from the app's drag layer). */
export interface CanvasViewHandle {
  /** Add a note/task/event card at a screen position (client coordinates). */
  addRefAt: (ref: { type: CanvasRefKind; id: string }, clientX: number, clientY: number) => void;
  /** Add image cards for dropped files at a screen position. */
  addFiles: (files: File[], clientX: number, clientY: number) => void;
}

export const CanvasView = forwardRef<CanvasViewHandle, CanvasViewProps>(function CanvasView(props, ref) {
  return (
    <ReactFlowProvider>
      <CanvasSurface {...props} handleRef={ref} />
    </ReactFlowProvider>
  );
});

function CanvasSurface({ host, canvasId, handleRef }: CanvasViewProps & { handleRef: Ref<CanvasViewHandle> }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const refsRef = useRef<CanvasRefs>({ notes: {}, tasks: {}, events: {}, documents: {} });
  // Nodes the user is interacting with; a reload must not overwrite them.
  const held = useRef<Set<string>>(new Set());
  const mutating = useRef(0);
  const viewApplied = useRef(false);

  // ---- load / merge ----
  const applyDoc = useCallback(
    (d: CanvasDocument) => {
      refsRef.current = d.refs;
      setDoc(d);
      setNodes((prev) => {
        const byId = new Map(prev.map((n) => [n.id, n]));
        const next: FlowNode[] = [];
        for (const n of d.nodes) {
          const old = byId.get(n.id);
          if (old && held.current.has(n.id)) {
            next.push({ ...old, data: { node: { ...n, x: old.position.x, y: old.position.y }, refs: d.refs } });
          } else {
            next.push(toFlowNode(n, d.refs, old));
          }
        }
        return next;
      });
      setEdges((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));
        for (const n of d.nodes) if (!nodeMap.has(n.id)) nodeMap.set(n.id, toFlowNode(n, d.refs));
        return d.edges.map((e) => toFlowEdge(e, nodeMap, byId.get(e.id)));
      });
    },
    [setNodes, setEdges],
  );
  const reload = useCallback(async () => {
    try {
      const d = await host.load(canvasId);
      applyDoc(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [host, canvasId, applyDoc]);

  useEffect(() => {
    viewApplied.current = false;
    setNodes([]);
    setEdges([]);
    setDoc(null);
    void reload();
  }, [canvasId, reload, setNodes, setEdges]);

  // Change events that arrive while one of our own writes is in flight are deferred to
  // its completion (below) rather than dropped: an added note/task node needs the reload
  // to hydrate its summary, and a sync pull can land mid-write too.
  const pendingReload = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = host.onChanged((id) => {
      if (id && id !== canvasId) return;
      if (mutating.current > 0) {
        pendingReload.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 150);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [host, canvasId, reload]);

  // Restore the saved viewport once, else fit the content.
  useEffect(() => {
    if (!doc || viewApplied.current) return;
    viewApplied.current = true;
    if (doc.view) rf.setViewport({ x: doc.view.x, y: doc.view.y, zoom: doc.view.zoom });
    else if (doc.nodes.length) setTimeout(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }), 0);
  }, [doc, rf]);

  // ---- writes (all through the host) ----
  const write = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      mutating.current += 1;
      try {
        return await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        mutating.current = Math.max(0, mutating.current - 1);
        if (mutating.current === 0 && pendingReload.current) {
          pendingReload.current = false;
          void reload();
        }
      }
    },
    [reload],
  );

  // Undo/redo: snapshots of the whole board as write inputs (React Flow has no history).
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const snapshot = useCallback((): Snapshot => ({ nodes: nodesRef.current.map(nodeInput), edges: edgesRef.current.map((e) => edgeInput(e.data!.edge)) }), []);
  const pushHistory = useCallback(() => {
    past.current.push(snapshot());
    if (past.current.length > HISTORY_LIMIT) past.current.shift();
    future.current = [];
    setHistoryVersion((v) => v + 1);
  }, [snapshot]);

  const upsertNodes = useCallback(
    async (inputs: CanvasNodeInput[]) => {
      if (!inputs.length) return;
      const saved = await write(() => host.upsertNodes(canvasId, inputs));
      if (!saved) return;
      setNodes((prev) => {
        const byId = new Map(saved.map((n) => [n.id, n]));
        const seen = new Set<string>();
        const next = prev.map((fn) => {
          const s = byId.get(fn.id);
          if (!s) return fn;
          seen.add(fn.id);
          return { ...fn, position: { x: s.x, y: s.y }, width: s.width, height: s.height, zIndex: nodeZ(s), data: { node: s, refs: refsRef.current } };
        });
        for (const s of saved) if (!seen.has(s.id)) next.push(toFlowNode(s, refsRef.current));
        return next;
      });
      return saved;
    },
    [host, canvasId, write, setNodes],
  );
  const upsertEdges = useCallback(
    async (inputs: CanvasEdgeInput[]) => {
      if (!inputs.length) return;
      const saved = await write(() => host.upsertEdges(canvasId, inputs));
      if (!saved) return;
      setEdges((prev) => {
        const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));
        const byId = new Map(saved.map((e) => [e.id, e]));
        const seen = new Set<string>();
        const next = prev.map((fe) => {
          const s = byId.get(fe.id);
          if (!s) return fe;
          seen.add(fe.id);
          return toFlowEdge(s, nodeMap, fe);
        });
        for (const s of saved) if (!seen.has(s.id)) next.push(toFlowEdge(s, nodeMap));
        return next;
      });
      return saved;
    },
    [host, canvasId, write, setEdges],
  );
  const deleteNodes = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      const res = await write(() => host.deleteNodes(canvasId, ids));
      const gone = new Set(ids);
      const goneEdges = new Set(res?.edgeIds ?? []);
      setNodes((prev) => prev.filter((n) => !gone.has(n.id)));
      setEdges((prev) => prev.filter((e) => !goneEdges.has(e.id) && !gone.has(e.source) && !gone.has(e.target)));
    },
    [host, canvasId, write, setNodes, setEdges],
  );
  const deleteEdges = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      await write(() => host.deleteEdges(canvasId, ids));
      const gone = new Set(ids);
      setEdges((prev) => prev.filter((e) => !gone.has(e.id)));
    },
    [host, canvasId, write, setEdges],
  );

  /** Bring the board to a snapshot: upsert what differs, delete what the snapshot lacks. */
  const applySnapshot = useCallback(
    async (snap: Snapshot) => {
      const curNodes = new Map(nodesRef.current.map((n) => [n.id, JSON.stringify(nodeInput(n))]));
      const curEdges = new Map(edgesRef.current.map((e) => [e.id, JSON.stringify(edgeInput(e.data!.edge))]));
      const wantNodes = new Set(snap.nodes.map((n) => n.id!));
      const wantEdges = new Set(snap.edges.map((e) => e.id!));
      await deleteEdges([...curEdges.keys()].filter((id) => !wantEdges.has(id)));
      await deleteNodes([...curNodes.keys()].filter((id) => !wantNodes.has(id)));
      await upsertNodes(snap.nodes.filter((n) => curNodes.get(n.id!) !== JSON.stringify(n)));
      await upsertEdges(snap.edges.filter((e) => curEdges.get(e.id!) !== JSON.stringify(e)));
    },
    [deleteEdges, deleteNodes, upsertNodes, upsertEdges],
  );
  const undo = useCallback(async () => {
    const snap = past.current.pop();
    if (!snap) return;
    future.current.push(snapshot());
    setHistoryVersion((v) => v + 1);
    await applySnapshot(snap);
  }, [snapshot, applySnapshot]);
  const redo = useCallback(async () => {
    const snap = future.current.pop();
    if (!snap) return;
    past.current.push(snapshot());
    setHistoryVersion((v) => v + 1);
    await applySnapshot(snap);
  }, [snapshot, applySnapshot]);

  // ---- adding nodes ----
  const centerOfView = useCallback((): { x: number; y: number } => {
    const el = wrapperRef.current;
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 600;
    return rf.screenToFlowPosition({ x: (el?.getBoundingClientRect().left ?? 0) + w / 2, y: (el?.getBoundingClientRect().top ?? 0) + h / 2 });
  }, [rf]);
  const addNode = useCallback(
    async (input: Omit<CanvasNodeInput, "x" | "y" | "width" | "height"> & Partial<Pick<CanvasNodeInput, "x" | "y" | "width" | "height">>) => {
      const size = NODE_DEFAULTS[input.kind];
      const at = input.x == null || input.y == null ? centerOfView() : { x: input.x, y: input.y };
      const width = input.width ?? size.width;
      const height = input.height ?? size.height;
      // Scatter stacked adds slightly so ten quick stickies don't land in one pile.
      const n = nodesRef.current.length;
      pushHistory();
      // Explicit placements land exactly there; toolbar adds scatter slightly so ten quick
      // stickies don't pile up.
      const scatter = input.x == null ? (n % 5) * 12 : 0;
      const saved = await upsertNodes([{ ...input, x: at.x - width / 2 + scatter, y: at.y - height / 2 + scatter, width, height, z: input.z ?? (input.kind === "group" ? -1 : 0) }]);
      if (saved?.[0]) {
        const id = saved[0].id;
        setNodes((prev) => prev.map((fn) => ({ ...fn, selected: fn.id === id })));
      }
      return saved?.[0];
    },
    [centerOfView, pushHistory, upsertNodes, setNodes],
  );
  const addSticky = useCallback((at?: { x: number; y: number }) => void addNode({ kind: "text", data: { text: "" }, ...(at ? { x: at.x, y: at.y } : {}) }), [addNode]);
  const addGroup = useCallback(() => void addNode({ kind: "group", data: { label: "Group" } }), [addNode]);
  const addRefNode = useCallback(
    (ref: { type: CanvasRefKind; id: string; data?: Record<string, unknown> }, at?: { x: number; y: number }) =>
      addNode({ kind: ref.type, refType: ref.type, refId: ref.id, data: ref.data ?? {}, ...(at ? { x: at.x, y: at.y } : {}) }),
    [addNode],
  );
  const addRef = useCallback(
    async (type: CanvasRefKind) => {
      const picked = await host.pickRef(type);
      if (!picked) return;
      await addRefNode({ type, id: picked.id, data: picked.data });
    },
    [host, addRefNode],
  );
  const addImage = useCallback(
    (documentId: string, at?: { x: number; y: number }) => addNode({ kind: "image", refType: "document", refId: documentId, data: {}, ...(at ? { x: at.x, y: at.y } : {}) }),
    [addNode],
  );
  const pickImage = useCallback(async () => {
    const picked = await host.pickImage();
    if (picked) await addImage(picked.documentId);
  }, [host, addImage]);
  /** Fetch a link node's preview and store it on the node. Errors leave a bare-URL card.
   *  `fallback` is the node as just saved: the preview can resolve before React has
   *  committed the new node into state, so the current node is looked up first and the
   *  saved copy used when it isn't there yet. */
  const fetchPreview = useCallback(
    async (id: string, url: string, fallback?: CanvasNode) => {
      let patch: Record<string, unknown>;
      try {
        const p = await host.linkPreview(url);
        patch = { url: p.url || url, title: p.title, description: p.description, imageUrl: p.imageUrl, siteName: p.siteName, faviconUrl: p.faviconUrl, fetchedAt: new Date().toISOString(), error: p.error ?? "" };
      } catch (e) {
        patch = { fetchedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
      }
      const current = nodesRef.current.find((n) => n.id === id);
      const base = current?.data.node ?? fallback;
      if (!base) return;
      const next: CanvasNode = { ...base, data: { ...(base.data ?? {}), ...patch } };
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { node: next, refs: refsRef.current } } : n)));
      const flow: FlowNode = current ? { ...current, data: { node: next, refs: refsRef.current } } : toFlowNode(next, refsRef.current);
      void upsertNodes([nodeInput(flow)]);
    },
    [host, setNodes, upsertNodes],
  );
  const addLink = useCallback(
    async (url: string, at?: { x: number; y: number }) => {
      const saved = await addNode({ kind: "link", data: { url }, ...(at ? { x: at.x, y: at.y } : {}) });
      if (saved) void fetchPreview(saved.id, url, saved);
    },
    [addNode, fetchPreview],
  );
  const pickLink = useCallback(async () => {
    const url = await host.pickLink();
    if (url) await addLink(url);
  }, [host, addLink]);
  const addFilesAt = useCallback(
    async (files: File[], at?: { x: number; y: number }) => {
      if (!host.ingestImage) return;
      let i = 0;
      for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        try {
          const { documentId } = await host.ingestImage(f);
          await addImage(documentId, at ? { x: at.x + i * 24, y: at.y + i * 24 } : undefined);
          i++;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [host, addImage],
  );
  const flowPoint = useCallback((clientX: number, clientY: number) => rf.screenToFlowPosition({ x: clientX, y: clientY }), [rf]);
  useImperativeHandle(
    handleRef,
    () => ({
      addRefAt: (ref, clientX, clientY) => void addRefNode(ref, flowPoint(clientX, clientY)),
      addFiles: (files, clientX, clientY) => void addFilesAt(files, flowPoint(clientX, clientY)),
    }),
    [addRefNode, addFilesAt, flowPoint],
  );

  // ---- drag: groups carry their contents ----
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());
  const carried = useRef<Map<string, string[]>>(new Map());
  const onNodeDragStart = useCallback<OnNodeDrag<FlowNode>>(
    (event, __, dragged) => {
      pushHistory();
      // Alt-drag leaves a copy behind and drags the original.
      if ((event as unknown as { altKey?: boolean }).altKey) {
        void upsertNodes(dragged.map((d) => ({ ...nodeInput(d), id: undefined })));
      }
      const all = nodesRef.current;
      const rects = all.map(nodeRect);
      const draggedIds = new Set(dragged.map((d) => d.id));
      const starts = new Map<string, { x: number; y: number }>();
      const carry = new Map<string, string[]>();
      for (const d of dragged) {
        starts.set(d.id, { x: d.position.x, y: d.position.y });
        held.current.add(d.id);
        const node = all.find((n) => n.id === d.id);
        if (node?.data.node.kind === "group") {
          const inside = containedIds(nodeRect(node), rects).filter((id) => !draggedIds.has(id));
          carry.set(d.id, inside);
          for (const id of inside) {
            const c = all.find((n) => n.id === id);
            if (c) {
              starts.set(id, { x: c.position.x, y: c.position.y });
              held.current.add(id);
            }
          }
        }
      }
      dragStart.current = starts;
      carried.current = carry;
    },
    [pushHistory, upsertNodes],
  );
  const onNodeDrag = useCallback<OnNodeDrag<FlowNode>>(
    (_, __, dragged) => {
      if (carried.current.size === 0) return;
      setNodes((prev) => {
        const moves = new Map<string, { x: number; y: number }>();
        for (const d of dragged) {
          const inside = carried.current.get(d.id);
          const s0 = dragStart.current.get(d.id);
          if (!inside || !s0) continue;
          const dx = d.position.x - s0.x;
          const dy = d.position.y - s0.y;
          for (const id of inside) {
            const c0 = dragStart.current.get(id);
            if (c0) moves.set(id, { x: c0.x + dx, y: c0.y + dy });
          }
        }
        if (!moves.size) return prev;
        return prev.map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n));
      });
    },
    [setNodes],
  );
  const onNodeDragStop = useCallback<OnNodeDrag<FlowNode>>(
    (_, __, dragged) => {
      const moved = new Set<string>(dragged.map((d) => d.id));
      for (const ids of carried.current.values()) for (const id of ids) moved.add(id);
      const inputs = nodesRef.current
        .filter((n) => moved.has(n.id))
        .map((n) => ({ ...nodeInput(n), x: Math.round(n.position.x), y: Math.round(n.position.y) }));
      for (const id of moved) held.current.delete(id);
      dragStart.current = new Map();
      carried.current = new Map();
      void upsertNodes(inputs);
    },
    [upsertNodes],
  );

  // ---- connect / delete ----
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      pushHistory();
      void upsertEdges([
        {
          fromNodeId: c.source,
          toNodeId: c.target,
          fromSide: (c.sourceHandle as CanvasSide | null) ?? null,
          toSide: (c.targetHandle as CanvasSide | null) ?? null,
          fromEnd: "none",
          toEnd: "arrowFilled",
          style: "curved",
          label: "",
        },
      ]);
    },
    [pushHistory, upsertEdges],
  );
  /** Replant an edge end: React Flow shows a grab handle at each end of a selected edge;
   *  dropping it on another card's handle re-targets the edge in place (same id, label,
   *  style, endings). */
  const onReconnect = useCallback(
    (oldEdge: FlowEdge, c: Connection) => {
      if (!oldEdge.data || !c.source || !c.target || c.source === c.target) return;
      pushHistory();
      void upsertEdges([
        edgeInput({
          ...oldEdge.data.edge,
          fromNodeId: c.source,
          toNodeId: c.target,
          fromSide: (c.sourceHandle as CanvasSide | null) ?? null,
          toSide: (c.targetHandle as CanvasSide | null) ?? null,
        }),
      ]);
    },
    [pushHistory, upsertEdges],
  );
  const onNodesDelete = useCallback(
    (deleted: FlowNode[]) => {
      pushHistory();
      void deleteNodes(deleted.map((n) => n.id));
    },
    [pushHistory, deleteNodes],
  );
  const onEdgesDelete = useCallback(
    (deleted: FlowEdge[]) => {
      // Edges attached to deleted nodes are dropped by deleteNodes; only standalone
      // edge deletes reach the host here.
      const nodeIds = new Set(nodesRef.current.map((n) => n.id));
      const standalone = deleted.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)).map((e) => e.id);
      if (standalone.length) {
        pushHistory();
        void deleteEdges(standalone);
      }
    },
    [pushHistory, deleteEdges],
  );

  // ---- node/edge field edits ----
  const updateNode = useCallback(
    (id: string, mutate: (n: CanvasNode) => CanvasNode) => {
      const fn = nodesRef.current.find((n) => n.id === id);
      if (!fn) return;
      pushHistory();
      const next = mutate(fn.data.node);
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { node: next, refs: refsRef.current } } : n)));
      void upsertNodes([{ ...nodeInput({ ...fn, data: { node: next, refs: refsRef.current } }) }]);
    },
    [pushHistory, setNodes, upsertNodes],
  );
  const actions = useMemo<CanvasActions>(
    () => ({
      updateData: (id, patch) => updateNode(id, (n) => ({ ...n, data: { ...(n.data ?? {}), ...patch } })),
      commitResize: (id) => {
        const fn = nodesRef.current.find((n) => n.id === id);
        if (!fn) return;
        pushHistory();
        void upsertNodes([{ ...nodeInput(fn), x: Math.round(fn.position.x), y: Math.round(fn.position.y), width: Math.round(fn.width ?? fn.data.node.width), height: Math.round(fn.height ?? fn.data.node.height) }]);
      },
      hold: (id) => held.current.add(id),
      release: (id) => held.current.delete(id),
      openRef: (ref) => host.openRef(ref),
      openUrl: (url) => host.openUrl(url),
      resolveDocument: (id) => host.resolveDocument(id),
      resizeTo: (id, width, height) => {
        const fn = nodesRef.current.find((n) => n.id === id);
        if (!fn) return;
        setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, width, height, data: { node: { ...n.data.node, width, height }, refs: refsRef.current } } : n)));
        void upsertNodes([{ ...nodeInput(fn), width, height }]);
      },
      refreshPreview: (id) => {
        const fn = nodesRef.current.find((n) => n.id === id);
        const url = typeof fn?.data.node.data?.url === "string" ? fn.data.node.data.url : "";
        if (url) void fetchPreview(id, url);
      },
      setTaskStatus: async (id, status) => {
        await host.setTaskStatus(id, status);
        void reload();
      },
      updateEdge: (id, patch) => {
        const fe = edgesRef.current.find((e) => e.id === id);
        if (!fe?.data) return;
        pushHistory();
        void upsertEdges([edgeInput({ ...fe.data.edge, ...patch })]);
      },
    }),
    [updateNode, pushHistory, upsertNodes, upsertEdges, host, reload, setNodes, fetchPreview],
  );

  // ---- selection toolbar ----
  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);
  const setColor = useCallback(
    (color: string | null) => {
      const ids = selectedNodes.map((n) => n.id);
      const edgeIds = selectedEdges.map((e) => e.id);
      if (!ids.length && !edgeIds.length) return;
      pushHistory();
      if (ids.length) {
        setNodes((prev) => prev.map((n) => (n.selected ? { ...n, data: { node: { ...n.data.node, color }, refs: refsRef.current } } : n)));
        void upsertNodes(nodesRef.current.filter((n) => n.selected).map((n) => ({ ...nodeInput(n), color })));
      }
      if (edgeIds.length) void upsertEdges(edgesRef.current.filter((e) => e.selected && e.data).map((e) => edgeInput({ ...e.data!.edge, color })));
    },
    [selectedNodes, selectedEdges, pushHistory, setNodes, upsertNodes, upsertEdges],
  );
  const setZ = useCallback(
    (dir: 1 | -1) => {
      const sel = nodesRef.current.filter((n) => n.selected && n.data.node.kind !== "group");
      if (!sel.length) return;
      pushHistory();
      const zs = nodesRef.current.filter((n) => n.data.node.kind !== "group").map((n) => n.data.node.z);
      // Cards live in their own band above groups (see nodeZ), so "send to back" only
      // reorders among cards and never hides one behind a group.
      const target = dir === 1 ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
      void upsertNodes(sel.map((n) => ({ ...nodeInput(n), z: target })));
    },
    [pushHistory, upsertNodes],
  );
  /** Apply an ending / style change to every selected edge. */
  const patchEdges = useCallback(
    (patch: Partial<Pick<CanvasEdge, "fromEnd" | "toEnd" | "style">>) => {
      const sel = edgesRef.current.filter((e) => e.selected && e.data);
      if (!sel.length) return;
      pushHistory();
      void upsertEdges(sel.map((e) => edgeInput({ ...e.data!.edge, ...patch })));
    },
    [pushHistory, upsertEdges],
  );
  // The "current" values for the selection toolbar: what the first selected edge has.
  const firstEdge = selectedEdges[0]?.data?.edge;
  const deleteSelection = useCallback(() => {
    void rf.deleteElements({ nodes: selectedNodes.map((n) => ({ id: n.id })), edges: selectedEdges.map((e) => ({ id: e.id })) });
  }, [rf, selectedNodes, selectedEdges]);

  // ---- keyboard ----
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [search, setSearch] = useState<string | null>(null); // null = closed
  const [snap, setSnap] = useState(true);
  const [showMinimap, setShowMinimap] = useState(false);
  // Last pointer position over the board (client coords) so keyboard adds land under the
  // cursor when it's on the board, else at the viewport center.
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const placeAt = useCallback((): { x: number; y: number } => (cursor.current ? flowPoint(cursor.current.x, cursor.current.y) : centerOfView()), [flowPoint, centerOfView]);
  // Selection order (first selected first), for "connect the two selected cards".
  const selectionOrder = useRef<string[]>([]);
  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: FlowNode[] }) => {
    const ids = sel.map((n) => n.id);
    selectionOrder.current = [...selectionOrder.current.filter((id) => ids.includes(id)), ...ids.filter((id) => !selectionOrder.current.includes(id))];
  }, []);
  const requestEdit = useCallback((kind: EditRequest["kind"], id: string) => setEditRequest((r) => ({ kind, id, seq: (r?.seq ?? 0) + 1 })), []);

  const selectOnly = useCallback(
    (nodeIds: string[], edgeIds: string[] = []) => {
      const ns = new Set(nodeIds);
      const es = new Set(edgeIds);
      setNodes((prev) => prev.map((n) => (n.selected === ns.has(n.id) ? n : { ...n, selected: ns.has(n.id) })));
      setEdges((prev) => prev.map((e) => (e.selected === es.has(e.id) ? e : { ...e, selected: es.has(e.id) })));
    },
    [setNodes, setEdges],
  );
  const selectedIds = useCallback(() => nodesRef.current.filter((n) => n.selected).map((n) => n.id), []);

  /** Wrap the selection in a new group with some padding (or add an empty group). */
  const groupSelection = useCallback(async () => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (!sel.length) return addGroup();
    const b = bounds(sel.map(nodeRect));
    if (!b) return;
    const pad = 24;
    const saved = await addNode({ kind: "group", data: { label: "Group" }, x: b.x - pad + (b.width + 2 * pad) / 2, y: b.y - pad - 12 + (b.height + 2 * pad + 12) / 2, width: b.width + 2 * pad, height: b.height + 2 * pad + 12 });
    if (saved) selectOnly([saved.id]);
  }, [addGroup, addNode, selectOnly]);
  const ungroupSelection = useCallback(() => {
    const groups = nodesRef.current.filter((n) => n.selected && n.data.node.kind === "group").map((n) => n.id);
    if (!groups.length) return;
    pushHistory();
    void deleteNodes(groups);
  }, [pushHistory, deleteNodes]);

  /** Align the selection's centers on one row (axis "y") or one column (axis "x"). */
  const alignSelection = useCallback(
    (axis: "x" | "y") => {
      const sel = nodesRef.current.filter((n) => n.selected);
      if (sel.length < 2) return;
      const rects = sel.map(nodeRect);
      const avg = rects.reduce((acc, r) => acc + (axis === "x" ? r.x + r.width / 2 : r.y + r.height / 2), 0) / rects.length;
      pushHistory();
      const moved = sel.map((n) => {
        const r = nodeRect(n);
        return axis === "x" ? { ...nodeInput(n), x: Math.round(avg - r.width / 2) } : { ...nodeInput(n), y: Math.round(avg - r.height / 2) };
      });
      setNodes((prev) => prev.map((n) => (moved.find((m) => m.id === n.id) ? { ...n, position: { x: moved.find((m) => m.id === n.id)!.x, y: moved.find((m) => m.id === n.id)!.y } } : n)));
      void upsertNodes(moved);
    },
    [pushHistory, setNodes, upsertNodes],
  );
  /** Space the selection evenly along its longer axis, keeping the two outermost put. */
  const distributeSelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (sel.length < 3) return;
    const rects = sel.map(nodeRect);
    const b = bounds(rects)!;
    const axis: "x" | "y" = b.width >= b.height ? "x" : "y";
    const sorted = [...sel].sort((a, c) => (axis === "x" ? a.position.x - c.position.x : a.position.y - c.position.y));
    const sizes = sorted.map((n) => (axis === "x" ? nodeRect(n).width : nodeRect(n).height));
    const span = axis === "x" ? b.width : b.height;
    const gap = (span - sizes.reduce((a, v) => a + v, 0)) / (sorted.length - 1);
    pushHistory();
    let pos = axis === "x" ? b.x : b.y;
    const moved = sorted.map((n, i) => {
      const input = axis === "x" ? { ...nodeInput(n), x: Math.round(pos) } : { ...nodeInput(n), y: Math.round(pos) };
      pos += sizes[i] + gap;
      return input;
    });
    setNodes((prev) => prev.map((n) => (moved.find((m) => m.id === n.id) ? { ...n, position: { x: moved.find((m) => m.id === n.id)!.x, y: moved.find((m) => m.id === n.id)!.y } } : n)));
    void upsertNodes(moved);
  }, [pushHistory, setNodes, upsertNodes]);

  /** Connect the two selected cards, first selected → second. */
  const connectSelected = useCallback(() => {
    const ids = selectionOrder.current.filter((id) => nodesRef.current.some((n) => n.id === id && n.selected));
    if (ids.length !== 2) return;
    pushHistory();
    void upsertEdges([{ fromNodeId: ids[0], toNodeId: ids[1], fromEnd: "none", toEnd: "arrowFilled", style: "curved", label: "" }]);
  }, [pushHistory, upsertEdges]);
  const ENDS: [CanvasEnd, CanvasEnd][] = useMemo(() => [["none", "arrowFilled"], ["arrowFilled", "none"], ["arrowFilled", "arrowFilled"], ["none", "none"]], []);
  const cycleEdgeEnds = useCallback(() => {
    const sel = edgesRef.current.filter((e) => e.selected && e.data);
    if (!sel.length) return;
    pushHistory();
    void upsertEdges(
      sel.map((e) => {
        const cur = ENDS.findIndex(([f, t]) => f === e.data!.edge.fromEnd && t === e.data!.edge.toEnd);
        const [fromEnd, toEnd] = ENDS[(cur + 1) % ENDS.length];
        return edgeInput({ ...e.data!.edge, fromEnd, toEnd });
      }),
    );
  }, [ENDS, pushHistory, upsertEdges]);
  const cycleEdgeStyle = useCallback(() => {
    const sel = edgesRef.current.filter((e) => e.selected && e.data);
    if (!sel.length) return;
    const cur = STYLES.indexOf(sel[0].data!.edge.style ?? "curved");
    patchEdges({ style: STYLES[(cur + 1) % STYLES.length] });
  }, [patchEdges]);
  const reverseEdges = useCallback(() => {
    const sel = edgesRef.current.filter((e) => e.selected && e.data);
    if (!sel.length) return;
    pushHistory();
    void upsertEdges(sel.map((e) => {
      const d = e.data!.edge;
      return edgeInput({ ...d, fromNodeId: d.toNodeId, toNodeId: d.fromNodeId, fromSide: d.toSide, toSide: d.fromSide, fromEnd: d.toEnd, toEnd: d.fromEnd });
    }));
  }, [pushHistory, upsertEdges]);

  /** Copy the selection (and the edges among it) to the clipboard. */
  const copySelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (!sel.length) return false;
    const b = bounds(sel.map(nodeRect))!;
    const index = new Map(sel.map((n, i) => [n.id, i]));
    const payload: ClipPayload = {
      nodes: sel.map((n) => ({ ...nodeInput(n), id: undefined, x: n.position.x - b.x, y: n.position.y - b.y })),
      edges: edgesRef.current
        .filter((e) => e.data && index.has(e.source) && index.has(e.target))
        .map((e) => ({ from: index.get(e.source)!, to: index.get(e.target)!, fromSide: e.data!.edge.fromSide ?? null, toSide: e.data!.edge.toSide ?? null, fromEnd: e.data!.edge.fromEnd, toEnd: e.data!.edge.toEnd, label: e.data!.edge.label, color: e.data!.edge.color ?? null })),
    };
    internalClipboard = payload;
    try {
      void navigator.clipboard?.writeText(CLIP_MARKER + JSON.stringify(payload)).catch(() => {});
    } catch {
      /* clipboard unavailable */
    }
    return true;
  }, []);
  const pasteCards = useCallback(
    async (payload: ClipPayload, at: { x: number; y: number }) => {
      if (!payload.nodes.length) return;
      pushHistory();
      const saved = await upsertNodes(payload.nodes.map((n) => ({ ...n, id: undefined, x: Math.round(at.x + n.x), y: Math.round(at.y + n.y) })));
      if (!saved) return;
      if (payload.edges.length) {
        await upsertEdges(payload.edges.filter((e) => saved[e.from] && saved[e.to]).map((e) => ({ fromNodeId: saved[e.from].id, toNodeId: saved[e.to].id, fromSide: e.fromSide, toSide: e.toSide, fromEnd: e.fromEnd, toEnd: e.toEnd, label: e.label, color: e.color })));
      }
      selectOnly(saved.map((n) => n.id));
    },
    [pushHistory, upsertNodes, upsertEdges, selectOnly],
  );

  /** Enter: edit a sticky/group/edge label, or open what a card embeds. */
  const activateSelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    const selE = edgesRef.current.filter((e) => e.selected);
    if (sel.length === 1 && !selE.length) {
      const n = sel[0].data.node;
      if (n.kind === "text" || n.kind === "group") requestEdit("node", n.id);
      else if ((n.kind === "note" || n.kind === "task" || n.kind === "event") && n.refId) host.openRef({ type: n.kind, id: n.refId });
      else if (n.kind === "link" && typeof n.data?.url === "string") host.openUrl(n.data.url);
    } else if (selE.length === 1 && !sel.length) {
      requestEdit("edge", selE[0].id);
    }
  }, [host, requestEdit]);
  const cycleSelection = useCallback(
    (dir: 1 | -1) => {
      const all = [...nodesRef.current].sort((a, b) => a.data.node.createdAt.localeCompare(b.data.node.createdAt));
      if (!all.length) return;
      const cur = all.findIndex((n) => n.selected);
      const next = all[(cur + dir + all.length) % all.length];
      selectOnly([next.id]);
      void rf.fitView({ nodes: [{ id: next.id }], padding: 1.5, maxZoom: rf.getZoom(), duration: 150 });
    },
    [selectOnly, rf],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const hasSel = selectedNodes.length > 0;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // Overlays.
      if (e.key === "Escape") {
        stop();
        if (showHelp) return setShowHelp(false);
        if (search !== null) return setSearch(null);
        return selectOnly([]);
      }
      if (!mod && e.key === "?") return void (stop(), setShowHelp((v) => !v));
      if (mod && key === "k") return void (stop(), setSearch(""));

      // Undo / redo, view.
      if (mod && key === "z") return void (stop(), e.shiftKey ? redo() : undo());
      if (mod && !e.shiftKey && key === "0") return void (stop(), rf.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }));
      if (mod && !e.shiftKey && key === "1") return void (stop(), rf.zoomTo(1, { duration: 200 }));
      if (mod && !e.shiftKey && key === "2") return void (stop(), hasSel && rf.fitView({ nodes: selectedNodes.map((n) => ({ id: n.id })), padding: 0.3, duration: 200 }));
      if (mod && (key === "=" || key === "+")) return void (stop(), rf.zoomIn({ duration: 150 }));
      if (mod && key === "-") return void (stop(), rf.zoomOut({ duration: 150 }));

      // Selection.
      if (mod && key === "a") return void (stop(), selectOnly(nodesRef.current.map((n) => n.id), edgesRef.current.map((x) => x.id)));
      if (e.key === "Tab") return void (stop(), cycleSelection(e.shiftKey ? -1 : 1));
      if (e.key === "Enter" && !mod) return void (stop(), activateSelection());

      // Clipboard (⌘V is left to the paste event so URLs/images/text keep working).
      if (mod && key === "c") return void (copySelection() && stop());
      if (mod && key === "x") {
        if (copySelection()) {
          stop();
          pushHistory();
          void deleteNodes(selectedIds());
        }
        return;
      }
      if (mod && !e.shiftKey && key === "d" && hasSel) {
        stop();
        pushHistory();
        void upsertNodes(selectedNodes.map((n) => ({ ...nodeInput(n), id: undefined, x: n.position.x + 24, y: n.position.y + 24 })));
        return;
      }

      // Arrange / group / connect (⌘⇧ combos).
      if (mod && e.shiftKey) {
        switch (key) {
          case "g": return void (stop(), groupSelection());
          case "u": return void (stop(), ungroupSelection());
          case "h": return void (stop(), alignSelection("y"));
          case "v": return void (stop(), alignSelection("x"));
          case "d": return void (stop(), distributeSelection());
          case "a": return void (stop(), cycleEdgeEnds());
          case "l": return void (stop(), cycleEdgeStyle());
          case "n": return void (stop(), host.newCanvas?.());
        }
      }
      if (mod && key === "]") return void (stop(), setZ(1));
      if (mod && key === "[") return void (stop(), setZ(-1));
      if (mod) return;

      // Nudge.
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && hasSel) {
        stop();
        const step = e.shiftKey ? GRID * 4 : GRID;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        pushHistory();
        setNodes((prev) => prev.map((n) => (n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)));
        void upsertNodes(nodesRef.current.filter((n) => n.selected).map((n) => ({ ...nodeInput(n), x: n.position.x + dx, y: n.position.y + dy })));
        return;
      }
      if (e.altKey) return;

      // Colors.
      if (/^[0-9]$/.test(key) && (hasSel || selectedEdges.length)) {
        stop();
        return setColor(key === "0" ? null : (swatches[Number(key) - 1] ?? null));
      }

      // Single-letter tools.
      switch (key) {
        case "t": return void (stop(), addSticky(placeAt()));
        case "g": return void (stop(), groupSelection());
        case "n": return void (stop(), addRef("note"));
        case "k": return void (stop(), addRef("task"));
        case "e": return void (stop(), addRef("event"));
        case "i": return void (stop(), pickImage());
        case "l": return void (stop(), pickLink());
        case "c": return void (stop(), connectSelected());
        case "r": return void (stop(), reverseEdges());
        case "h": return void (stop(), setSnap((v) => !v));
        case "f": return void (stop(), setShowMinimap((v) => !v));
      }
    },
    [undo, redo, rf, selectedNodes, selectedEdges, pushHistory, upsertNodes, setNodes, showHelp, search, selectOnly, cycleSelection, activateSelection, copySelection, deleteNodes, selectedIds, groupSelection, ungroupSelection, alignSelection, distributeSelection, cycleEdgeEnds, cycleEdgeStyle, host, setZ, setColor, addSticky, placeAt, addRef, pickImage, pickLink, connectSelected, reverseEdges],
  );

  // Paste onto the board: an image becomes an image card, a URL a link card, other text a
  // sticky. Ignored while typing inside a card.
  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length && host.ingestImage) {
        e.preventDefault();
        void addFilesAt(files, centerOfView());
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (text.startsWith(CLIP_MARKER)) {
        e.preventDefault();
        try {
          void pasteCards(JSON.parse(text.slice(CLIP_MARKER.length)) as ClipPayload, placeAt());
        } catch {
          /* not ours after all */
        }
        return;
      }
      if (!text) {
        if (internalClipboard) {
          e.preventDefault();
          void pasteCards(internalClipboard, placeAt());
        }
        return;
      }
      e.preventDefault();
      if (/^https?:\/\/\S+$/i.test(text)) void addLink(text, placeAt());
      else void addNode({ kind: "text", data: { text }, ...placeAt() });
    },
    [host, addFilesAt, addLink, addNode, centerOfView, pasteCards, placeAt],
  );
  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
      if (!files.length && !/^https?:\/\/\S+$/i.test(uri.trim())) return;
      e.preventDefault();
      const at = flowPoint(e.clientX, e.clientY);
      if (files.length) void addFilesAt(files, at);
      else void addLink(uri.trim(), at);
    },
    [flowPoint, addFilesAt, addLink],
  );
  const onDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes("Files") || e.dataTransfer?.types.includes("text/uri-list")) e.preventDefault();
  }, []);

  // Double-click on empty canvas → a sticky right there.
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains("react-flow__pane")) return;
      const size = NODE_DEFAULTS.text;
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addSticky({ x: p.x + size.width / 2, y: p.y + size.height / 2 });
    },
    [rf, addSticky],
  );

  // Viewport persistence (debounced).
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = setTimeout(() => void host.setView(canvasId, { x: vp.x, y: vp.y, zoom: vp.zoom }), 300);
    },
    [host, canvasId],
  );

  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  void historyVersion;

  return (
    <ActionsCtx.Provider value={actions}>
    <EditRequestCtx.Provider value={editRequest}>
      {/* Fill the RNW parent (position:relative) with an absolute box so React Flow
          measures a real height (a plain 100% collapses in the flex layout). */}
      <div
        ref={wrapperRef}
        style={fillStyle}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onMouseMove={(e) => {
          cursor.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseLeave={() => {
          cursor.current = null;
        }}
      >
        <style>{CANVAS_CSS}</style>
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          edgesReconnectable
          reconnectRadius={10}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onMoveEnd={onMoveEnd}
          onSelectionChange={onSelectionChange}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={["Backspace", "Delete"]}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control"]}
          zoomOnDoubleClick={false}
          // Keep the persisted stacking: a selected group must stay behind its contents,
          // or clicking a card inside it would grab the group instead.
          elevateNodesOnSelect={false}
          snapToGrid={snap}
          snapGrid={[GRID, GRID]}
          minZoom={0.1}
          maxZoom={2.5}
          nodeDragThreshold={2}
          proOptions={{ hideAttribution: true }}
          style={{ background: colors.surfaceApp }}
        >
          <Background color={colors.borderDefault} gap={24} size={1.5} />
          <Controls showInteractive={false} position="bottom-right" />
          {showMinimap ? <MiniMap pannable zoomable position="bottom-left" nodeColor={(n) => (n as FlowNode).data?.node.color ?? colors.borderStrong} /> : null}
          <Panel position="top-left">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <ToolButton icon="sticky" label="Sticky note" onClick={() => addSticky()} />
              <ToolButton icon="group" label="Group" onClick={addGroup} />
              <ToolButton icon="file" label="Note" onClick={() => void addRef("note")} />
              <ToolButton icon="tasks" label="Task" onClick={() => void addRef("task")} />
              <ToolButton icon="calendar" label="Event" onClick={() => void addRef("event")} />
              <ToolButton icon="image" label="Image" onClick={() => void pickImage()} />
              <ToolButton icon="link" label="Link" onClick={() => void pickLink()} />
              <span style={{ width: 8 }} />
              <ToolButton icon="undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => void undo()} />
              <ToolButton icon="redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => void redo()} />
              <ToolButton icon="fit" title="Fit view (⌘0)" onClick={() => void rf.fitView({ padding: 0.2, maxZoom: 1 })} />
              <ToolButton icon="search" title="Find a card (⌘K)" onClick={() => setSearch("")} />
              <ToolButton icon="dot" title="Keyboard shortcuts (?)" label="?" onClick={() => setShowHelp((v) => !v)} />
            </div>
          </Panel>
          {search !== null ? (
            <Panel position="top-center">
              <CardSearch
                query={search}
                onQuery={setSearch}
                nodes={nodes}
                onPick={(id) => {
                  setSearch(null);
                  selectOnly([id]);
                  void rf.fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1.2, duration: 200 });
                  wrapperRef.current?.focus();
                }}
                onClose={() => {
                  setSearch(null);
                  wrapperRef.current?.focus();
                }}
              />
            </Panel>
          ) : null}
          {/* Selection tools sit at the bottom so they never overlap the add toolbar on a
              narrow pane. */}
          {selectedNodes.length || selectedEdges.length ? (
            <Panel position="bottom-center">
              <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", borderRadius: 10, background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}`, boxShadow: "0 6px 20px rgba(0,0,0,0.10)" }}>
                {swatches.map((c) => (
                  <button key={c} type="button" className="canvas-swatch" title={c} style={{ background: c }} onClick={() => setColor(c)} />
                ))}
                <button type="button" className="canvas-swatch" title="Default color" style={{ background: colors.surfaceCard, border: `2px solid ${colors.borderDefault}` }} onClick={() => setColor(null)} />
                <span style={{ width: 1, height: 18, background: colors.borderSubtle, margin: "0 4px" }} />
                {selectedNodes.length ? (
                  <>
                    <ToolButton icon="chevronRight" title="Bring to front" onClick={() => setZ(1)} rotate={-90} />
                    <ToolButton icon="chevronRight" title="Send to back" onClick={() => setZ(-1)} rotate={90} />
                  </>
                ) : null}
                {selectedEdges.length ? (
                  <>
                    <span style={{ display: "inline-flex", gap: 2 }} title="Line style">
                      {STYLES.map((st) => (
                        <button key={st} type="button" className={`canvas-btn icon${firstEdge?.style === st ? " on" : ""}`} title={STYLE_LABEL[st]} aria-label={`Line: ${STYLE_LABEL[st]}`} onClick={() => patchEdges({ style: st })}>
                          <StyleGlyph style={st} />
                        </button>
                      ))}
                    </span>
                    <span style={{ width: 1, height: 18, background: colors.borderSubtle, margin: "0 4px" }} />
                    <span style={{ display: "inline-flex", gap: 2 }} title="Start">
                      {ENDINGS.map((en) => (
                        <button key={en} type="button" className={`canvas-btn icon${firstEdge?.fromEnd === en ? " on" : ""}`} title={`Start: ${END_LABEL[en]}`} aria-label={`Start: ${END_LABEL[en]}`} onClick={() => patchEdges({ fromEnd: en })}>
                          <EndGlyph end={en} atStart />
                        </button>
                      ))}
                    </span>
                    <span style={{ width: 1, height: 18, background: colors.borderSubtle, margin: "0 4px" }} />
                    <span style={{ display: "inline-flex", gap: 2 }} title="End">
                      {ENDINGS.map((en) => (
                        <button key={en} type="button" className={`canvas-btn icon${firstEdge?.toEnd === en ? " on" : ""}`} title={`End: ${END_LABEL[en]}`} aria-label={`End: ${END_LABEL[en]}`} onClick={() => patchEdges({ toEnd: en })}>
                          <EndGlyph end={en} />
                        </button>
                      ))}
                    </span>
                  </>
                ) : null}
                <ToolButton icon="trash" title="Delete (⌫)" onClick={deleteSelection} />
              </div>
            </Panel>
          ) : null}
          {doc && doc.nodes.length === 0 && nodes.length === 0 ? (
            <Panel position="bottom-center">
              <div style={{ padding: "8px 14px", borderRadius: 10, background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}`, color: colors.textTertiary, fontFamily: cardFont, fontSize: 12 }}>
                Empty board. Double-click anywhere for a sticky note, add notes, tasks, events, images, or links from the toolbar, or paste a URL or image. Drag from a card's edge to connect it.
              </div>
            </Panel>
          ) : null}
          {error ? (
            <Panel position="bottom-left">
              <div style={{ padding: "8px 12px", borderRadius: 10, background: colors.dangerSoft, color: colors.danger, fontFamily: cardFont, fontSize: 12 }}>{error}</div>
            </Panel>
          ) : null}
        </ReactFlow>
        {showHelp ? <ShortcutHelp onClose={() => setShowHelp(false)} /> : null}
      </div>
    </EditRequestCtx.Provider>
    </ActionsCtx.Provider>
  );
}

function ToolButton({ icon, label, title, onClick, disabled, rotate }: { icon: IconName; label?: ReactNode; title?: string; onClick: () => void; disabled?: boolean; rotate?: number }) {
  return (
    <button type="button" className={`canvas-btn${label ? "" : " icon"}`} title={title ?? (typeof label === "string" ? label : undefined)} aria-label={title ?? (typeof label === "string" ? label : undefined)} onClick={onClick} disabled={disabled}>
      {icon === "dot" && label ? null : (
        <span style={{ display: "inline-flex", transform: rotate ? `rotate(${rotate}deg)` : undefined }}>
          <Icon name={icon} size={15} color="currentColor" />
        </span>
      )}
      {label ? <span>{label}</span> : null}
    </button>
  );
}


/** The `?` overlay: every shortcut, grouped. Click anywhere or press Escape to close. */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "absolute", inset: 0, zIndex: 20, background: "rgba(17,17,16,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: cardFont }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: "94%", maxHeight: "86%", overflow: "auto", background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}`, borderRadius: 14, boxShadow: "0 18px 50px rgba(0,0,0,0.18)", padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Keyboard shortcuts</div>
          <button type="button" className="canvas-btn icon" aria-label="Close" onClick={onClose} style={{ marginLeft: "auto" }}>
            <Icon name="close" size={14} color="currentColor" />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "10px 28px" }}>
          {SHORTCUTS.map((g) => (
            <div key={g.group}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: colors.textTertiary, margin: "6px 0" }}>{g.group}</div>
              {g.items.map(([keys, what]) => (
                <div key={keys + what} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "3px 0" }}>
                  <kbd style={{ font: `500 11px ${cardFont}`, padding: "1px 6px", borderRadius: 5, border: `1px solid ${colors.borderDefault}`, background: colors.surfaceSunken, color: colors.textSecondary, whiteSpace: "nowrap", minWidth: 60, textAlign: "center" }}>{keys}</kbd>
                  <span style={{ color: colors.textPrimary }}>{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ⌘K: find a card by its text, title, label, or URL and jump to it. */
function CardSearch({ query, onQuery, nodes, onPick, onClose }: { query: string; onQuery: (q: string) => void; nodes: FlowNode[]; onPick: (id: string) => void; onClose: () => void }) {
  const q = query.trim().toLowerCase();
  const labelOf = (n: FlowNode): string => {
    const c = n.data.node;
    const refs = n.data.refs;
    switch (c.kind) {
      case "text": return String(c.data?.text ?? "");
      case "group": return String(c.data?.label ?? "Group");
      case "note": return refs.notes[c.refId ?? ""]?.title ?? "Note";
      case "task": return refs.tasks[c.refId ?? ""]?.title ?? "Task";
      case "event": return refs.events[c.refId ?? ""]?.title ?? String(c.data?.title ?? "Event");
      case "image": return refs.documents[c.refId ?? ""]?.filename ?? "Image";
      case "link": return String(c.data?.title || c.data?.url || "Link");
    }
  };
  const matches = nodes.map((n) => ({ id: n.id, kind: n.data.node.kind, label: labelOf(n) })).filter((m) => !q || m.label.toLowerCase().includes(q)).slice(0, 8);
  return (
    <div style={{ width: 360, background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}`, borderRadius: 10, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", padding: 8, fontFamily: cardFont }}>
      <input
        autoFocus
        value={query}
        placeholder="Find a card…"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && matches[0]) onPick(matches[0].id);
          e.stopPropagation();
        }}
        style={{ width: "100%", boxSizing: "border-box", font: `13px ${cardFont}`, padding: "6px 8px", borderRadius: 6, border: `1px solid ${colors.borderDefault}`, outline: 0 }}
      />
      <div style={{ marginTop: 6 }}>
        {matches.length ? (
          matches.map((m) => (
            <button key={m.id} type="button" onClick={() => onPick(m.id)} style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 8px", border: 0, background: "transparent", borderRadius: 6, cursor: "pointer", font: `12px ${cardFont}`, color: colors.textPrimary, textAlign: "left" }}>
              <span style={{ color: colors.textTertiary, fontSize: 11, minWidth: 40 }}>{m.kind}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label || "(empty)"}</span>
            </button>
          ))
        ) : (
          <div style={{ padding: "6px 8px", color: colors.textTertiary, fontSize: 12 }}>No cards match.</div>
        )}
      </div>
    </div>
  );
}
