import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Platform, View, type GestureResponderHandlers, type PanResponderGestureState } from "react-native";
import { Icon, Text, colors, noSelect, radius, shadow, space, type IconName } from "@companion/design-system";
import type { RefDragStart } from "@companion/editor";
import { DragGrip } from "./DragGrip";

/** What is being dragged, plus a label for the drag ghost: a note, task or canvas (a list row,
 *  a tab, or a reference to one: a link chip, a chat preview, a canvas card), or a reference to
 *  a project, which an area takes in. `source` names the surface a reference was dragged off,
 *  where that surface would otherwise take it right back (a board, its own card). */
export type DragPayload = { kind: "note" | "task" | "canvas" | "project"; id: string; label: string; source?: string };

/** The drag payload for a reference of `type`, or null for a kind nothing takes a drop of (a
 *  habit, a document, an event), which then doesn't drag at all. */
export function refPayload(type: string, id: string, label: string): DragPayload | null {
  return type === "note" || type === "task" || type === "canvas" || type === "project" ? { kind: type, id, label } : null;
}

type Bounds = { x: number; y: number; width: number; height: number };
type Target = {
  measure: () => Promise<Bounds | null>;
  onDrop: (p: DragPayload, x: number, y: number) => void;
  /** Which payloads the target takes; any other passes over it as if it weren't there. */
  accepts: (p: DragPayload) => boolean;
  /** Spring-loading: called once a drag has rested on the target for SPRING_MS. */
  onSpring?: (p: DragPayload) => void;
  bounds: Bounds | null;
};
type TargetOptions = { accepts?: (p: DragPayload) => boolean; onSpring?: (p: DragPayload) => void };

/** How long a drag rests on a spring-loaded target (a tab, the rail's Today) before it opens. */
const SPRING_MS = 600;

interface DndValue {
  dragging: DragPayload | null;
  hoverId: string | null;
  begin: (payload: DragPayload, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: () => void;
  /** Drop nothing: the drag just stops (Escape). */
  cancel: () => void;
  /** Start a drag the DOM began (a link chip in the editor, a canvas card's grip) at the
   *  pointer's window position; the layer follows that pointer until it's released. */
  beginPointerDrag: (payload: DragPayload, x: number, y: number) => void;
  registerTarget: (id: string, target: Omit<Target, "bounds">) => void;
  unregisterTarget: (id: string) => void;
  position: { x: Animated.Value; y: Animated.Value };
  /** Observe the pointer during a drag (window coords) without re-rendering the tree. */
  subscribeMove: (cb: (x: number, y: number) => void) => () => void;
  /** Re-measure every target's bounds (call after layout shifts mid-drag). */
  remeasure: () => Promise<void>;
}

const DndCtx = createContext<DndValue | null>(null);

/** A tiny drag-and-drop layer for "drop a document onto a project" (web/desktop). A source
 *  (`useDraggable`, or `beginPointerDrag` for a drag the DOM began) starts a ghost drag on
 *  pointer move; targets (`useDropTarget`) register their on-screen bounds; on release over a
 *  target its onDrop fires. A spring-loaded target (`useSpringTarget`) instead opens after the
 *  drag rests on it, which is how a drag reaches a surface in another tab. Position rides an
 *  Animated value so the ghost follows the pointer without re-rendering the tree. */
export function DndProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const position = useRef({ x: new Animated.Value(0), y: new Animated.Value(0) }).current;

  const targets = useRef<Map<string, Target>>(new Map());
  const moveListeners = useRef<Set<(x: number, y: number) => void>>(new Set());
  const draggingRef = useRef<DragPayload | null>(null);
  const hoverRef = useRef<string | null>(null);
  // Last pointer position (window coords), handed to onDrop so a target can place the
  // payload where it landed (e.g. a canvas adds the card under the pointer).
  const lastPos = useRef({ x: 0, y: 0 });
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Removes the window listeners of a drag the DOM began (beginPointerDrag).
  const detachPointer = useRef<(() => void) | null>(null);

  // Every function below reads and writes refs (and stable setters) only, so they're made once.
  const api = useMemo(() => {
    // (Re)measure every target's window bounds. Called when a drag begins and shortly after,
    // once the sidebar has finished revealing (it force-expands during a drag), and once a
    // spring has put another tab's surface on screen.
    const remeasure = async () => {
      await Promise.all(
        [...targets.current.values()].map(async (t) => {
          t.bounds = await t.measure();
        }),
      );
    };

    const hitTest = (x: number, y: number): string | null => {
      const payload = draggingRef.current;
      for (const [id, t] of targets.current) {
        const b = t.bounds;
        if (!b || x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) continue;
        if (payload && !t.accepts(payload)) continue;
        return id;
      }
      return null;
    };

    const clearSpring = () => {
      if (springTimer.current) clearTimeout(springTimer.current);
      springTimer.current = null;
    };

    const setHover = (hit: string | null) => {
      if (hit === hoverRef.current) return;
      hoverRef.current = hit;
      setHoverId(hit);
      clearSpring();
      if (!hit || !targets.current.get(hit)?.onSpring) return;
      springTimer.current = setTimeout(() => {
        springTimer.current = null;
        const payload = draggingRef.current;
        const spring = targets.current.get(hit)?.onSpring;
        if (!payload || !spring || hoverRef.current !== hit) return;
        spring(payload);
        // What the spring put on screen lays out over the next frames: measure its targets
        // once it has, then re-read what the (resting) pointer is over.
        setTimeout(() => {
          void remeasure().then(() => {
            if (draggingRef.current) setHover(hitTest(lastPos.current.x, lastPos.current.y));
          });
        }, 60);
      }, SPRING_MS);
    };

    const begin = (payload: DragPayload, x: number, y: number) => {
      draggingRef.current = payload;
      setDragging(payload);
      lastPos.current = { x, y };
      position.x.setValue(x);
      position.y.setValue(y);
      void remeasure();
    };

    const move = (x: number, y: number) => {
      if (!draggingRef.current) return;
      lastPos.current = { x, y };
      position.x.setValue(x);
      position.y.setValue(y);
      for (const cb of moveListeners.current) cb(x, y);
      setHover(hitTest(x, y));
    };

    const finish = (drop: boolean) => {
      const payload = draggingRef.current;
      const hit = hoverRef.current;
      detachPointer.current?.();
      detachPointer.current = null;
      clearSpring();
      draggingRef.current = null;
      hoverRef.current = null;
      setDragging(null);
      setHoverId(null);
      if (!payload) return;
      swallowNextClick();
      if (drop && hit) targets.current.get(hit)?.onDrop(payload, lastPos.current.x, lastPos.current.y);
    };

    const beginPointerDrag = (payload: DragPayload, x: number, y: number) => {
      if (typeof window === "undefined" || !window.addEventListener) return;
      detachPointer.current?.();
      begin(payload, x, y);
      const onMove = (e: PointerEvent) => move(e.clientX, e.clientY);
      const onUp = (e: PointerEvent) => {
        move(e.clientX, e.clientY);
        finish(true);
      };
      const onCancel = () => finish(false);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      detachPointer.current = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
      };
    };

    const registerTarget = (id: string, t: Omit<Target, "bounds">) => {
      const target: Target = { ...t, bounds: null };
      targets.current.set(id, target);
      // A target that mounts mid-drag (the rail's project rows appear when it expands) is
      // measured right away so it can accept the drop.
      if (draggingRef.current) {
        void t.measure().then((b) => {
          if (targets.current.get(id) === target) target.bounds = b;
        });
      }
    };
    const unregisterTarget = (id: string) => {
      targets.current.delete(id);
    };
    const subscribeMove = (cb: (x: number, y: number) => void) => {
      moveListeners.current.add(cb);
      return () => {
        moveListeners.current.delete(cb);
      };
    };

    return {
      begin,
      move,
      end: () => finish(true),
      cancel: () => finish(false),
      beginPointerDrag,
      registerTarget,
      unregisterTarget,
      subscribeMove,
      remeasure,
    };
  }, [position]);

  // While dragging, suppress the browser's native text selection (a mouse drag would
  // otherwise select whatever text it passes over), and let Escape call the drag off.
  // Web-only; no-op on native.
  const { cancel } = api;
  useEffect(() => {
    if (!dragging || typeof document === "undefined" || !document.body) return;
    const style = document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string };
    style.userSelect = "none";
    style.webkitUserSelect = "none";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      style.userSelect = "";
      style.webkitUserSelect = "";
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dragging, cancel]);

  const value = useMemo<DndValue>(() => ({ dragging, hoverId, position, ...api }), [dragging, hoverId, position, api]);

  return (
    <DndCtx.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
        {dragging ? <DragGhost payload={dragging} position={position} /> : null}
      </View>
    </DndCtx.Provider>
  );
}

/** A drag ends with the pointer's release, and the browser follows that with a click on
 *  whatever the press and release had in common: an item the drag started on would open.
 *  Swallow that one click (it arrives in the same task as the release, before any timer). */
function swallowNextClick() {
  if (typeof window === "undefined" || !window.addEventListener) return;
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, true);
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

export function useDnd(): DndValue {
  const v = useContext(DndCtx);
  if (!v) throw new Error("useDnd must be used within a DndProvider");
  return v;
}

/** The drag layer, or null in a shell without one (the mobile shells). */
export function useOptionalDnd(): DndValue | null {
  return useContext(DndCtx);
}

/** Spread the returned handlers onto a source element to make it draggable. A drag starts
 *  only after real movement, so taps still fire the element's onPress. `getPayload` is read
 *  lazily at drag start. `fromStart` claims the gesture on touch-down instead — for a
 *  dedicated handle, where nothing else (a press, a text selection) should get a look in. */
export function useDraggable(getPayload: () => DragPayload, { fromStart = false }: { fromStart?: boolean } = {}): GestureResponderHandlers {
  const dnd = useDnd();
  // Read the payload and the (stable-but-fresh) dnd handlers through refs so the responder
  // is created exactly once. If it depended on `dnd` directly it would be rebuilt whenever
  // the context changes (e.g. hoverId updates on drag-over), tearing down the live gesture.
  const payloadRef = useRef(getPayload);
  payloadRef.current = getPayload;
  const dndRef = useRef(dnd);
  dndRef.current = dnd;
  // The ghost appears on the first movement, not on touch-down: a plain click on a handle
  // that claimed the gesture at the start shouldn't flash a drag.
  const started = useRef(false);
  const responder = useMemo(
    () => {
      const finish = () => {
        if (started.current) dndRef.current.end();
        started.current = false;
      };
      return PanResponder.create({
        onStartShouldSetPanResponder: () => fromStart,
        onMoveShouldSetPanResponder: (_e: unknown, g: PanResponderGestureState) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderMove: (_e: unknown, g: PanResponderGestureState) => {
          if (!started.current) {
            started.current = true;
            dndRef.current.begin(payloadRef.current(), g.moveX, g.moveY);
          }
          dndRef.current.move(g.moveX, g.moveY);
        },
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
        onPanResponderTerminationRequest: () => false,
      });
    },
    [fromStart],
  );
  return responder.panHandlers;
}

/** A convenience wrapper: makes its children a draggable source with the given payload.
 *  Shells without a drag layer (the mobile shells) render the children untouched. */
export function Draggable({ payload, children }: { payload: DragPayload; children: ReactNode }) {
  const dnd = useContext(DndCtx);
  return dnd ? <DragSource payload={payload}>{children}</DragSource> : <>{children}</>;
}

function DragSource({ payload, children }: { payload: DragPayload; children: ReactNode }) {
  const handlers = useDraggable(() => payload);
  return (
    // A drag is only claimed after a few px of movement, by which point a mouse-down on text
    // has already begun a native selection (the body-level suppression above kicks in too
    // late) — so sources opt out of selection up front.
    <View {...handlers} style={noSelect}>
      {children}
    </View>
  );
}

/** A grip for a list row's far right: press and drag it to carry the row's document onto a
 *  project, area or board (a task onto the Today agenda too). The row itself stays a plain
 *  press target. Renders nothing in shells without a drag layer (the mobile shells). */
export function DragHandle({ payload }: { payload: DragPayload }) {
  const dnd = useContext(DndCtx);
  return dnd ? <Grip payload={payload} /> : null;
}

function Grip({ payload }: { payload: DragPayload }) {
  const handlers = useDraggable(() => payload, { fromStart: true });
  return <DragGrip handlers={handlers} label={payload.kind === "task" ? "Drag to a project, an area or the agenda" : "Drag to a project or area"} />;
}

// --- references ------------------------------------------------------------------
// A reference (a link chip in a note, a task or a chat; a chat preview; a canvas card) drags
// what it points at: onto a project or an area to file it, a task onto the Today agenda. The
// DOM follows the press (not the gesture system), so a quick flick off a small chip still
// drags, and nothing the pointer crosses on the way (an agenda block, a sortable row) takes the
// gesture for its own.

// Only a mouse or pen drags a reference. On a touch screen a swipe that starts on a chip or a
// preview card is a scroll.
const FINE_POINTER = Platform.OS === "web" && typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

/** How far (px) a press on a reference travels before it becomes a drag. */
const REF_SLOP = 5;

/** Follow a press that began at (x0, y0): once it travels REF_SLOP, `onDrag` gets the pointer's
 *  position (and the drag layer follows it from there); a release before that is a click. */
function followPress(x0: number, y0: number, onDrag: (x: number, y: number) => void) {
  const move = (e: PointerEvent) => {
    if (Math.abs(e.clientX - x0) < REF_SLOP && Math.abs(e.clientY - y0) < REF_SLOP) return;
    stop();
    onDrag(e.clientX, e.clientY);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
}

/** The press handler `useRefDrag` returns, to spread on a chip or a card. */
export type RefDragProps = { onPointerDown: (event: unknown) => void };

/** Makes a reference draggable: spread the returned props on its chip or card. A press with a
 *  mouse or pen that travels a few pixels drags it; a plain click still reaches it. Null where
 *  references don't drag: the mobile shells, a touch screen, a kind nothing takes. */
export function useRefDrag(type: string, id: string, label: string): RefDragProps | null {
  const begin = useContext(DndCtx)?.beginPointerDrag;
  const payload = refPayload(type, id, label);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const props = useMemo<RefDragProps | null>(
    () =>
      begin
        ? {
            onPointerDown: (event) => {
              const e = event as { nativeEvent: PointerEvent; preventDefault: () => void; stopPropagation: () => void };
              const { button, pointerType, clientX, clientY } = e.nativeEvent;
              if (button !== 0 || pointerType === "touch" || !payloadRef.current) return;
              // Cancelling the press stops the browser's mouse events until release, which is
              // what the gesture system would hand the drag around with. The click a plain press
              // ends in still comes, and opens the reference.
              e.preventDefault();
              // A chip inside a preview card drags itself, not the card.
              e.stopPropagation();
              followPress(clientX, clientY, (x, y) => {
                if (payloadRef.current) begin(payloadRef.current, x, y);
              });
            },
          }
        : null,
    [begin],
  );
  return props && FINE_POINTER && payload ? props : null;
}

/** An editor's `onRefDragStart`: a link chip dragged out of a note, a task's notes, the daily
 *  note or the chat composer is handed to the drag layer. Undefined without one. */
export function useEditorRefDrag(): ((drag: RefDragStart) => boolean) | undefined {
  const begin = useContext(DndCtx)?.beginPointerDrag;
  return useMemo(
    () =>
      begin
        ? (drag: RefDragStart) => {
            const payload = refPayload(drag.ref.type, drag.ref.id, drag.label);
            if (!payload) return false;
            begin(payload, drag.x, drag.y);
            return true;
          }
        : undefined,
    [begin],
  );
}

/** The drag layer's `beginPointerDrag`, for a drag the DOM began outside React Native (the
 *  canvas renderer's card grips). Undefined without a drag layer. */
export function usePointerDrag(): DndValue["beginPointerDrag"] | undefined {
  return useContext(DndCtx)?.beginPointerDrag;
}

// --- targets ---------------------------------------------------------------------

/** Register an element as a drop target. Returns a ref to attach and whether a drag is
 *  currently hovering it (for highlight). onDrop fires with the dropped payload. `accepts`
 *  narrows what it takes: anything else passes over it, unhighlighted, and can't drop there.
 *  `onSpring` makes it spring-loaded (see useSpringTarget). */
export function useDropTarget(id: string, onDrop: (payload: DragPayload, x: number, y: number) => void, options: TargetOptions = {}) {
  // Optional provider: shells without a drag layer (the mobile shells) simply never drop.
  const dnd = useContext(DndCtx);
  const registerTarget = dnd?.registerTarget;
  const unregisterTarget = dnd?.unregisterTarget;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const springs = !!options.onSpring;

  // Register once (registerTarget/unregisterTarget are stable). Re-registering on every
  // context change — e.g. hoverId updates mid-drag — would clear the measured bounds and
  // make the target flicker out from under the pointer.
  useEffect(() => {
    if (!registerTarget || !unregisterTarget) return;
    registerTarget(id, {
      measure: () =>
        new Promise<Bounds | null>((resolve) => {
          const node = ref.current;
          if (node && typeof node.measureInWindow === "function") {
            node.measureInWindow((x: number, y: number, width: number, height: number) => resolve({ x, y, width, height }));
          } else {
            resolve(null);
          }
        }),
      onDrop: (p, x, y) => onDropRef.current(p, x, y),
      accepts: (p) => optionsRef.current.accepts?.(p) ?? true,
      onSpring: springs ? (p) => optionsRef.current.onSpring?.(p) : undefined,
    });
    return () => unregisterTarget(id);
  }, [id, registerTarget, unregisterTarget, springs]);

  const isOver = !!dnd && dnd.dragging != null && dnd.hoverId === id;
  return { ref, isOver };
}

/** A spring-loaded target: a drag that rests on it for a moment calls `onSpring` (a tab
 *  opens, the rail's Today view comes up), so what it carries can reach a surface that
 *  wasn't on screen. Dropping on it does nothing. Returns a ref to attach and whether a drag
 *  is resting on it (for highlight). */
export function useSpringTarget(id: string, onSpring: (payload: DragPayload) => void, accepts?: (payload: DragPayload) => boolean) {
  return useDropTarget(id, () => {}, { onSpring, accepts });
}

const GHOST_ICON: Record<DragPayload["kind"], IconName> = { note: "file", task: "tasks", canvas: "canvas", project: "folder" };

/** The floating label that follows the pointer during a drag. */
function DragGhost({ payload, position }: { payload: DragPayload; position: { x: Animated.Value; y: Animated.Value } }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        zIndex: 1000,
        transform: [{ translateX: position.x }, { translateY: position.y }],
      }}
    >
      <View style={styles.ghost}>
        <Icon name={GHOST_ICON[payload.kind]} size={14} color={colors.textSecondary} />
        <Text variant="caption" numberOfLines={1} style={{ maxWidth: 200 }}>
          {payload.label || "Untitled"}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = {
  ghost: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    marginLeft: space.md,
    marginTop: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    ...shadow.md,
  },
};
