import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, layout } from "./tokens";

export interface SplitViewProps {
  /** The resizable pane (e.g. a list). Its width is drag-controlled and persisted. */
  aside: ReactNode;
  /** The flexible content pane. Fills the remaining space. */
  children: ReactNode;
  /** Which edge the resizable pane sits on. Default "left". */
  asideSide?: "left" | "right";
  /** Initial aside width in px (used when nothing is persisted). */
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  /** localStorage key. When set, the aside width persists across sessions. */
  storageKey?: string;
  style?: StyleProp<ViewStyle>;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A two-pane split with a draggable hairline divider. The `aside` is the fixed pane —
 * its width is drag-controlled and optionally persisted — and `children` flex to fill the
 * rest. (Getting that backwards starves the flexible pane to zero.) Use
 * `asideSide="right"` for a detail panel beside a document. Web/desktop drags via pointer
 * events; on native it renders as a static split.
 */
export function SplitView({
  aside,
  children,
  asideSide = "left",
  defaultWidth = layout.listW,
  minWidth = 200,
  maxWidth = 440,
  storageKey,
  style,
}: SplitViewProps) {
  const [width, setWidth] = usePersistentWidth(storageKey, defaultWidth, minWidth, maxWidth);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const drag = useRef({ startX: 0, startW: 0 });

  const onMove = useCallback(
    (e: PointerEvent) => {
      const dir = asideSide === "left" ? 1 : -1;
      const next = drag.current.startW + dir * (e.clientX - drag.current.startX);
      setWidth(clamp(next, minWidth, maxWidth));
    },
    [asideSide, minWidth, maxWidth, setWidth],
  );

  const onUp = useCallback(() => {
    setDragging(false);
    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [onMove]);

  const onDown = useCallback(
    (e: { clientX?: number; nativeEvent?: { clientX?: number } }) => {
      if (typeof window === "undefined") return;
      const clientX = e?.nativeEvent?.clientX ?? e?.clientX ?? 0;
      drag.current = { startX: clientX, startW: width };
      setDragging(true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, onMove, onUp],
  );

  // Belt-and-suspenders: drop listeners if we unmount mid-drag.
  useEffect(
    () => () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    },
    [onMove, onUp],
  );

  const active = dragging || hovered;
  const asidePane = (
    <View style={[styles.aside, { width }]}>{aside}</View>
  );
  const handle = (
    <View
      onPointerDown={onDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      aria-label="Resize"
      style={styles.handle}
    >
      <View style={[styles.line, active && styles.lineActive]} />
    </View>
  );
  const content = <View style={styles.content}>{children}</View>;

  return (
    <View style={[styles.root, style]}>
      {asideSide === "left" ? (
        <>
          {asidePane}
          {handle}
          {content}
        </>
      ) : (
        <>
          {content}
          {handle}
          {asidePane}
        </>
      )}
    </View>
  );
}

function usePersistentWidth(key: string | undefined, initial: number, min: number, max: number) {
  const [width, setWidthState] = useState<number>(() => {
    if (!key || typeof window === "undefined") return initial;
    try {
      const stored = window.localStorage?.getItem(key);
      const n = stored == null ? NaN : Number(stored);
      return Number.isFinite(n) ? clamp(n, min, max) : initial;
    } catch {
      return initial;
    }
  });
  const setWidth = useCallback(
    (next: number) => {
      setWidthState(next);
      if (!key || typeof window === "undefined") return;
      try {
        window.localStorage?.setItem(key, String(Math.round(next)));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [width, setWidth] as const;
}

const styles = StyleSheet.create({
  root: { flexDirection: "row", height: "100%" },
  aside: { flexShrink: 0, height: "100%" },
  content: { flex: 1, minWidth: 0, height: "100%" },
  // A 1px hairline with a 7px invisible grab area: negative margins let the hit area
  // overlap the seam without consuming layout width. The line goes accent while dragging.
  handle: {
    width: 7,
    marginHorizontal: -3,
    zIndex: 1,
    alignItems: "center",
    justifyContent: "center",
    // Web-only resize cursor; not a valid native CursorValue, so cast (no-op on native).
    cursor: "col-resize" as unknown as "auto",
  },
  line: { width: 1, height: "100%", backgroundColor: colors.borderSubtle },
  lineActive: { backgroundColor: colors.accent },
});
