import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, View, type GestureResponderHandlers, type PanResponderGestureState } from "react-native";
import { Icon, Text, colors, noDragRegion, noSelect, radius, shadow, space } from "@companion/design-system";

/** What is being dragged (a note, task or canvas), plus a label for the drag ghost. */
export type DragPayload = { kind: "note" | "task" | "canvas"; id: string; label: string };

type Bounds = { x: number; y: number; width: number; height: number };
type Target = { measure: () => Promise<Bounds | null>; onDrop: (p: DragPayload, x: number, y: number) => void; bounds: Bounds | null };

interface DndValue {
  dragging: DragPayload | null;
  hoverId: string | null;
  begin: (payload: DragPayload, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: () => void;
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
 *  (`useDraggable`) starts a ghost drag on pointer move; targets (`useDropTarget`) register
 *  their on-screen bounds; on release over a target its onDrop fires. Position rides an
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

  const registerTarget = useCallback((id: string, t: Omit<Target, "bounds">) => {
    const target: Target = { ...t, bounds: null };
    targets.current.set(id, target);
    // A target that mounts mid-drag (the rail's project rows appear when it expands) is
    // measured right away so it can accept the drop.
    if (draggingRef.current) {
      void t.measure().then((b) => {
        if (targets.current.get(id) === target) target.bounds = b;
      });
    }
  }, []);
  const unregisterTarget = useCallback((id: string) => {
    targets.current.delete(id);
  }, []);

  // (Re)measure every target's window bounds. Called when a drag begins and shortly after,
  // once the sidebar has finished revealing (it force-expands during a drag).
  const remeasure = useCallback(async () => {
    await Promise.all(
      [...targets.current.values()].map(async (t) => {
        t.bounds = await t.measure();
      }),
    );
  }, []);

  const hitTest = useCallback((x: number, y: number): string | null => {
    for (const [id, t] of targets.current) {
      const b = t.bounds;
      if (b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return id;
    }
    return null;
  }, []);

  const begin = useCallback(
    (payload: DragPayload, x: number, y: number) => {
      draggingRef.current = payload;
      setDragging(payload);
      lastPos.current = { x, y };
      position.x.setValue(x);
      position.y.setValue(y);
      void remeasure();
    },
    [position, remeasure],
  );
  const subscribeMove = useCallback((cb: (x: number, y: number) => void) => {
    moveListeners.current.add(cb);
    return () => {
      moveListeners.current.delete(cb);
    };
  }, []);

  const move = useCallback(
    (x: number, y: number) => {
      if (!draggingRef.current) return;
      lastPos.current = { x, y };
      position.x.setValue(x);
      position.y.setValue(y);
      for (const cb of moveListeners.current) cb(x, y);
      const hit = hitTest(x, y);
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        setHoverId(hit);
      }
    },
    [position, hitTest],
  );

  const end = useCallback(() => {
    const payload = draggingRef.current;
    const hit = hoverRef.current;
    draggingRef.current = null;
    hoverRef.current = null;
    setDragging(null);
    setHoverId(null);
    if (payload && hit) targets.current.get(hit)?.onDrop(payload, lastPos.current.x, lastPos.current.y);
  }, []);

  // While dragging, suppress the browser's native text selection (a mouse drag would
  // otherwise select whatever text it passes over). Web-only; no-op on native.
  useEffect(() => {
    if (typeof document === "undefined" || !document.body) return;
    const style = document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string };
    style.userSelect = dragging ? "none" : "";
    style.webkitUserSelect = dragging ? "none" : "";
    return () => {
      style.userSelect = "";
      style.webkitUserSelect = "";
    };
  }, [dragging]);

  const value = useMemo<DndValue>(
    () => ({ dragging, hoverId, begin, move, end, registerTarget, unregisterTarget, position, subscribeMove, remeasure }),
    [dragging, hoverId, begin, move, end, registerTarget, unregisterTarget, position, subscribeMove, remeasure],
  );

  return (
    <DndCtx.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
        {dragging ? <DragGhost payload={dragging} position={position} /> : null}
      </View>
    </DndCtx.Provider>
  );
}

export function useDnd(): DndValue {
  const v = useContext(DndCtx);
  if (!v) throw new Error("useDnd must be used within a DndProvider");
  return v;
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
 *  project, area or board. The row itself stays a plain press target. Renders nothing in
 *  shells without a drag layer (the mobile shells). */
export function DragHandle({ payload }: { payload: DragPayload }) {
  const dnd = useContext(DndCtx);
  return dnd ? <Grip payload={payload} /> : null;
}

// A click on the grip must not bubble to the row's Pressable and open the item.
const SWALLOW_CLICK = { onClick: (e: { stopPropagation: () => void }) => e.stopPropagation() } as object;

function Grip({ payload }: { payload: DragPayload }) {
  const handlers = useDraggable(() => payload, { fromStart: true });
  return (
    <View {...handlers} {...SWALLOW_CLICK} aria-label="Drag to a project or area" style={[styles.grip, noSelect, noDragRegion]}>
      <Icon name="grip" size={12} color={colors.textTertiary} strokeWidth={2.5} />
    </View>
  );
}

/** Register an element as a drop target. Returns a ref to attach and whether a drag is
 *  currently hovering it (for highlight). onDrop fires with the dropped payload. */
export function useDropTarget(id: string, onDrop: (payload: DragPayload, x: number, y: number) => void) {
  // Optional provider: shells without a drag layer (the mobile shells) simply never drop.
  const dnd = useContext(DndCtx);
  const registerTarget = dnd?.registerTarget;
  const unregisterTarget = dnd?.unregisterTarget;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

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
    });
    return () => unregisterTarget(id);
  }, [id, registerTarget, unregisterTarget]);

  const isOver = !!dnd && dnd.dragging != null && dnd.hoverId === id;
  return { ref, isOver };
}

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
        <Icon name={payload.kind === "task" ? "tasks" : payload.kind === "canvas" ? "canvas" : "file"} size={14} color={colors.textSecondary} />
        <Text variant="caption" numberOfLines={1} style={{ maxWidth: 200 }}>
          {payload.label || "Untitled"}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = {
  grip: {
    width: 16,
    alignSelf: "stretch" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    // Sit flush with the row's right edge (rows pad their right side by space.sm).
    marginRight: -space.xs,
    cursor: "grab",
  },
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
