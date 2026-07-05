import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Platform,
  View,
  type GestureResponderHandlers,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { noDragRegion } from "@companion/design-system";

// On web a mouse-drag would otherwise start a native text selection that fights the
// PanResponder; disabling user-select on the rows keeps drags clean. No-op on native.
const NO_SELECT = Platform.OS === "web" ? ({ userSelect: "none" } as const) : null;

export interface SortableRenderInfo<T> {
  item: T;
  index: number;
  /** True while this row is the one being dragged. */
  isActive: boolean;
  /** Spread onto the element that should start a drag (a handle, or the whole row). */
  drag: GestureResponderHandlers;
}

export interface SortableListProps<T> {
  items: T[];
  keyExtractor: (item: T) => string;
  renderItem: (info: SortableRenderInfo<T>) => ReactNode;
  /** Called on drop with the new top-to-bottom id order. */
  onReorder: (orderedIds: string[]) => void;
  /** When false, drags are ignored (rows render normally). Default true. */
  enabled?: boolean;
  /** Claim the drag on touch-down instead of on first vertical movement. Use with a
   *  dedicated handle inside a scroll view (native), where the ScrollView would otherwise
   *  win the vertical pan. Default false (move-based, so taps still fall through). */
  activateOnStart?: boolean;
  /** Fires true when a drag begins and false when it ends, so a host ScrollView can
   *  suspend scrolling for the duration. */
  onDragActiveChange?: (active: boolean) => void;
  style?: StyleProp<ViewStyle>;
}

/** A dependency-free drag-to-reorder vertical list (PLAN §6.6). Built on PanResponder +
 *  Animated so it runs identically on native and react-native-web — no gesture-handler or
 *  reanimated. Rows may be different heights (measured via onLayout). A drag is claimed
 *  only on vertical movement, so tapping a row still fires its onPress (e.g. to navigate). */
export function SortableList<T>({
  items,
  keyExtractor,
  renderItem,
  onReorder,
  enabled = true,
  activateOnStart = false,
  onDragActiveChange,
  style,
}: SortableListProps<T>) {
  const heights = useRef<Map<string, number>>(new Map());
  const translates = useRef<Map<string, Animated.Value>>(new Map());
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Live data for the per-row responders, which are created once and must not close over
  // stale values.
  const keysRef = useRef<string[]>([]);
  keysRef.current = items.map(keyExtractor);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activateOnStartRef = useRef(activateOnStart);
  activateOnStartRef.current = activateOnStart;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDragActiveRef = useRef(onDragActiveChange);
  onDragActiveRef.current = onDragActiveChange;

  const getTranslate = useCallback((key: string) => {
    let v = translates.current.get(key);
    if (!v) {
      v = new Animated.Value(0);
      translates.current.set(key, v);
    }
    return v;
  }, []);

  // Snapshot of the drag in progress.
  const session = useRef<{ key: string; startIndex: number; order: string[]; offsets: number[]; targetIndex: number } | null>(null);

  const begin = useCallback((key: string) => {
    const order = [...keysRef.current];
    const startIndex = order.indexOf(key);
    if (startIndex < 0) return;
    const offsets: number[] = [];
    let acc = 0;
    for (const k of order) {
      offsets.push(acc);
      acc += heights.current.get(k) ?? 0;
    }
    session.current = { key, startIndex, order, offsets, targetIndex: startIndex };
    setActiveKey(key);
    onDragActiveRef.current?.(true);
  }, []);

  const move = useCallback(
    (dy: number) => {
      const s = session.current;
      if (!s) return;
      getTranslate(s.key).setValue(dy);
      const h = heights.current.get(s.key) ?? 0;
      const center = s.offsets[s.startIndex] + h / 2 + dy;
      let target = s.startIndex;
      for (let j = s.startIndex + 1; j < s.order.length; j++) {
        const mid = s.offsets[j] + (heights.current.get(s.order[j]) ?? 0) / 2;
        if (center > mid) target = j;
        else break;
      }
      for (let j = s.startIndex - 1; j >= 0; j--) {
        const mid = s.offsets[j] + (heights.current.get(s.order[j]) ?? 0) / 2;
        if (center < mid) target = j;
        else break;
      }
      if (target === s.targetIndex) return;
      s.targetIndex = target;
      // Slide the passed-over rows by the dragged row's height to open the gap.
      for (let j = 0; j < s.order.length; j++) {
        const k = s.order[j];
        if (k === s.key) continue;
        let shift = 0;
        if (s.startIndex < target && j > s.startIndex && j <= target) shift = -h;
        else if (target < s.startIndex && j >= target && j < s.startIndex) shift = h;
        Animated.spring(getTranslate(k), { toValue: shift, useNativeDriver: false, bounciness: 0, speed: 20 }).start();
      }
    },
    [getTranslate],
  );

  const end = useCallback(() => {
    const s = session.current;
    session.current = null;
    setActiveKey(null);
    onDragActiveRef.current?.(false);
    if (!s) return;
    for (const k of s.order) getTranslate(k).setValue(0);
    if (s.targetIndex !== s.startIndex) {
      const order = [...s.order];
      order.splice(s.startIndex, 1);
      order.splice(s.targetIndex, 0, s.key);
      onReorderRef.current(order);
    }
  }, [getTranslate]);

  return (
    <View style={style}>
      {items.map((item, index) => {
        const key = keyExtractor(item);
        return (
          <SortableRow
            key={key}
            rowKey={key}
            translate={getTranslate(key)}
            active={activeKey === key}
            enabledRef={enabledRef}
            activateOnStartRef={activateOnStartRef}
            onLayoutHeight={(hgt) => heights.current.set(key, hgt)}
            onBegin={begin}
            onMove={move}
            onEnd={end}
          >
            {(drag) => renderItem({ item, index, isActive: activeKey === key, drag })}
          </SortableRow>
        );
      })}
    </View>
  );
}

function SortableRow({
  rowKey,
  translate,
  active,
  enabledRef,
  activateOnStartRef,
  onLayoutHeight,
  onBegin,
  onMove,
  onEnd,
  children,
}: {
  rowKey: string;
  translate: Animated.Value;
  active: boolean;
  enabledRef: React.RefObject<boolean>;
  activateOnStartRef: React.RefObject<boolean>;
  onLayoutHeight: (h: number) => void;
  onBegin: (key: string) => void;
  onMove: (dy: number) => void;
  onEnd: () => void;
  children: (drag: GestureResponderHandlers) => ReactNode;
}) {
  // Stable callback refs so the PanResponder (built once) always calls the latest.
  const cbs = useRef({ onBegin, onMove, onEnd });
  cbs.current = { onBegin, onMove, onEnd };

  const responder = useMemo(
    () =>
      PanResponder.create({
        // On a handle (activateOnStart) claim on touch-down so a parent ScrollView can't
        // steal the vertical pan; otherwise wait for a vertical drag so taps fall through.
        onStartShouldSetPanResponder: () => !!enabledRef.current && !!activateOnStartRef.current,
        onMoveShouldSetPanResponder: (_e: unknown, g: PanResponderGestureState) =>
          !!enabledRef.current && Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => cbs.current.onBegin(rowKey),
        onPanResponderMove: (_e: unknown, g: PanResponderGestureState) => cbs.current.onMove(g.dy),
        onPanResponderRelease: () => cbs.current.onEnd(),
        onPanResponderTerminate: () => cbs.current.onEnd(),
        // Don't let an ancestor responder (ScrollView) take over once we're dragging.
        onPanResponderTerminationRequest: () => false,
      }),
    [rowKey, enabledRef, activateOnStartRef],
  );

  return (
    <Animated.View
      onLayout={(e: LayoutChangeEvent) => onLayoutHeight(e.nativeEvent.layout.height)}
      // noDragRegion: on the Wails desktop the rail is a window drag handle, so rows must
      // opt out or a drag would move the window instead of reordering.
      style={{ transform: [{ translateY: translate }], zIndex: active ? 2 : 0, opacity: active ? 0.95 : 1, ...NO_SELECT, ...noDragRegion }}
    >
      {children(responder.panHandlers)}
    </Animated.View>
  );
}
