import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, View, type GestureResponderHandlers, type PanResponderGestureState } from "react-native";
import { Icon, Text, colors, radius, shadow, space } from "@companion/design-system";

/** What is being dragged (a note or task), plus a label for the drag ghost. */
export type DragPayload = { kind: "note" | "task"; id: string; label: string };

type Bounds = { x: number; y: number; width: number; height: number };
type Target = { measure: () => Promise<Bounds | null>; onDrop: (p: DragPayload) => void; bounds: Bounds | null };

interface DndValue {
  dragging: DragPayload | null;
  hoverId: string | null;
  begin: (payload: DragPayload, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: () => void;
  registerTarget: (id: string, target: Omit<Target, "bounds">) => void;
  unregisterTarget: (id: string) => void;
  position: { x: Animated.Value; y: Animated.Value };
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
  const draggingRef = useRef<DragPayload | null>(null);
  const hoverRef = useRef<string | null>(null);

  const registerTarget = useCallback((id: string, t: Omit<Target, "bounds">) => {
    targets.current.set(id, { ...t, bounds: null });
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
      position.x.setValue(x);
      position.y.setValue(y);
      void remeasure();
      // The sidebar expands on drag; give its transition a beat, then measure again.
      setTimeout(() => void remeasure(), 260);
    },
    [position, remeasure],
  );

  const move = useCallback(
    (x: number, y: number) => {
      if (!draggingRef.current) return;
      position.x.setValue(x);
      position.y.setValue(y);
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
    if (payload && hit) targets.current.get(hit)?.onDrop(payload);
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
    () => ({ dragging, hoverId, begin, move, end, registerTarget, unregisterTarget, position }),
    [dragging, hoverId, begin, move, end, registerTarget, unregisterTarget, position],
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
 *  lazily at drag start. */
export function useDraggable(getPayload: () => DragPayload): GestureResponderHandlers {
  const dnd = useDnd();
  // Read the payload and the (stable-but-fresh) dnd handlers through refs so the responder
  // is created exactly once. If it depended on `dnd` directly it would be rebuilt whenever
  // the context changes (e.g. hoverId updates on drag-over), tearing down the live gesture.
  const payloadRef = useRef(getPayload);
  payloadRef.current = getPayload;
  const dndRef = useRef(dnd);
  dndRef.current = dnd;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e: unknown, g: PanResponderGestureState) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: (_e: unknown, g: PanResponderGestureState) => dndRef.current.begin(payloadRef.current(), g.moveX, g.moveY),
        onPanResponderMove: (_e: unknown, g: PanResponderGestureState) => dndRef.current.move(g.moveX, g.moveY),
        onPanResponderRelease: () => dndRef.current.end(),
        onPanResponderTerminate: () => dndRef.current.end(),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  return responder.panHandlers;
}

/** A convenience wrapper: makes its children a draggable source with the given payload. */
export function Draggable({ payload, children }: { payload: DragPayload; children: ReactNode }) {
  const handlers = useDraggable(() => payload);
  return <View {...handlers}>{children}</View>;
}

/** Register an element as a drop target. Returns a ref to attach and whether a drag is
 *  currently hovering it (for highlight). onDrop fires with the dropped payload. */
export function useDropTarget(id: string, onDrop: (payload: DragPayload) => void) {
  const dnd = useDnd();
  const { registerTarget, unregisterTarget } = dnd;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  // Register once (registerTarget/unregisterTarget are stable). Re-registering on every
  // context change — e.g. hoverId updates mid-drag — would clear the measured bounds and
  // make the target flicker out from under the pointer.
  useEffect(() => {
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
      onDrop: (p) => onDropRef.current(p),
    });
    return () => unregisterTarget(id);
  }, [id, registerTarget, unregisterTarget]);

  const isOver = dnd.dragging != null && dnd.hoverId === id;
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
        <Icon name={payload.kind === "task" ? "tasks" : "file"} size={14} color={colors.textSecondary} />
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
