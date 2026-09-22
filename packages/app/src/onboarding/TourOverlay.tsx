import { useEffect, useState } from "react";
import { Modal, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { colors, radius } from "@companion/design-system";
import { measureAnchors, type Rect } from "./anchors";
import { stepAnchors } from "./tours";
import { HOLE_PAD, TourCard, cardWidth, placeCard, type TourOverlayProps } from "./TourCard";

// The tutorial's chrome in the native app: a modal over everything (the stack's headers
// included), dimmed except for a lit hole around the step's element, and the card beside it.
// Views measure asynchronously here, so the hole is re-measured on a short timer: it follows a
// screen that is still sliding in, and a step that just opened a screen waits for it. The web has
// its own (TourOverlay.web.tsx).

export type { TourOverlayProps } from "./TourCard";

/** How long a step waits for its element (a screen still opening) before showing in the middle. */
const WAIT_MS = 1500;
const POLL_MS = 120;

export function TourOverlay(props: TourOverlayProps) {
  const { registry, steps, index, insets } = props;
  const step = steps[index];
  const anchors = stepAnchors(step);
  const anchorsKey = anchors.join("|");
  const { width: vw, height: vh } = useWindowDimensions();

  const [rect, setRect] = useState<Rect | null>(null);
  // Whether the step has found its element (or given up waiting), so the card can show.
  const [settled, setSettled] = useState(false);
  const [card, setCard] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const since = Date.now();
    setSettled(anchors.length === 0);
    const measure = async () => {
      const r = anchors.length ? await measureAnchors(registry, anchors) : null;
      if (!alive) return;
      setRect((prev) => (sameRect(prev, r) ? prev : r));
      if (r || Date.now() - since > WAIT_MS) setSettled(true);
    };
    void measure();
    const timer = setInterval(() => void measure(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, anchorsKey, index]);

  // An element scrolled out of the window (native has no scroll-into-view) can't be lit: the card
  // shows in the middle instead. One partly out is lit where it shows.
  const hole = rect && rect.y < vh && rect.y + rect.h > 0 && rect.x < vw && rect.x + rect.w > 0 ? clip(rect, vw, vh) : null;
  const width = cardWidth(vw);
  const at = placeCard(hole, { w: card?.w ?? width, h: card?.h ?? 180 }, vw, vh, insets);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setCard((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  };

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      {...fullScreen}
      // Android's back button skips the tutorial, as Escape does on the web.
      onRequestClose={props.onSkip}
    >
      <View style={styles.fill}>
        {hole ? (
          <>
            {/* Four panes dim everything around the hole; the modal itself blocks the hole. */}
            <View style={[styles.dim, { left: 0, top: 0, width: vw, height: Math.max(0, hole.y) }]} />
            <View style={[styles.dim, { left: 0, top: hole.y + hole.h, width: vw, height: Math.max(0, vh - hole.y - hole.h) }]} />
            <View style={[styles.dim, { left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h }]} />
            <View style={[styles.dim, { left: hole.x + hole.w, top: hole.y, width: Math.max(0, vw - hole.x - hole.w), height: hole.h }]} />
            <View pointerEvents="none" style={[styles.ring, { left: hole.x, top: hole.y, width: hole.w, height: hole.h }]} />
          </>
        ) : (
          <View style={[styles.fill, styles.scrim]} />
        )}
        {settled ? (
          <TourCard props={props} cardProps={{ onLayout }} style={{ left: at.x, top: at.y, width, opacity: card ? 1 : 0 }} />
        ) : null}
      </View>
    </Modal>
  );
}

// Under the status bar too (so window coordinates line up on Android), in any orientation. Not in
// the shared RN typing, hence the cast.
const fullScreen = { statusBarTranslucent: true, supportedOrientations: ["portrait", "landscape"] } as Record<string, unknown>;

/** The padded hole around an element, cut to the window. */
function clip(rect: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, rect.x - HOLE_PAD);
  const y = Math.max(0, rect.y - HOLE_PAD);
  return { x, y, w: Math.min(vw, rect.x + rect.w + HOLE_PAD) - x, h: Math.min(vh, rect.y + rect.h + HOLE_PAD) - y };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

const styles = {
  fill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  scrim: { backgroundColor: colors.scrim },
  dim: { position: "absolute" as const, backgroundColor: colors.scrim },
  // Nearly square, so the square hole's corners don't show past the ring.
  ring: { position: "absolute" as const, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.sm },
};
