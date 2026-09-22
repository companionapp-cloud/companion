import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { colors, motion, radius, transition } from "@companion/design-system";
import { Overlay } from "../Overlay";
import { revealAnchor, unionRect, type Rect } from "./anchors";
import { stepAnchors } from "./tours";
import { HOLE_PAD, TourCard, cardWidth, placeCard, type TourOverlayProps } from "./TourCard";

// The tutorial's chrome on the web (desktop and the mobile web shell): the page dimmed except
// for a lit hole around the step's element, and the card beside it. The whole window is blocked
// while it shows, hole included, so a tutorial can't be knocked off its page by a stray click;
// keys are held back from the page too. The hole follows its element every frame, so a panel
// sliding open or a window resize never leaves it behind. Native has its own (TourOverlay.tsx).

export type { TourOverlayProps } from "./TourCard";

export function TourOverlay(props: TourOverlayProps) {
  const { registry, tour, steps, index, insets } = props;
  const step = steps[index];
  const anchors = stepAnchors(step);
  const anchorsKey = anchors.join("|");
  const { width: vw, height: vh } = useWindowDimensions();

  const [rect, setRect] = useState<Rect | null>(null);
  const [card, setCard] = useState<{ w: number; h: number } | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  // Follow the element (and the card's own size) while the step shows. requestAnimationFrame
  // for smooth tracking; a slow interval as well, since frames stop in a hidden window.
  useEffect(() => {
    let alive = true;
    let raf = 0;
    const measure = () => {
      const r = anchors.length ? unionRect(registry, anchors) : null;
      setRect((prev) => (sameRect(prev, r) ? prev : r));
      const box = cardRef.current?.getBoundingClientRect?.();
      if (box) setCard((prev) => (prev && prev.w === box.width && prev.h === box.height ? prev : { w: box.width, h: box.height }));
    };
    const frame = () => {
      if (!alive) return;
      measure();
      raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(frame) : 0;
    };
    frame();
    const slow = setInterval(measure, 250);
    return () => {
      alive = false;
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      clearInterval(slow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, anchorsKey]);

  // A new step: bring its element into view and move focus onto the card, off the page behind.
  useLayoutEffect(() => {
    if (anchors[0]) revealAnchor(registry, anchors[0]);
    cardRef.current?.focus?.({ preventScroll: true } as FocusOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.id, index]);

  // Keys: arrows and Enter step through, Escape skips. Nothing reaches the page behind.
  const handlers = useRef(props);
  handlers.current = props;
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      const inCard = !!cardRef.current && cardRef.current.contains(e.target as Node);
      const onControl = inCard && e.target !== cardRef.current;
      const s = h.steps[h.index];
      const isLast = h.index === h.steps.length - 1;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!h.busy) h.onSkip();
        return;
      }
      if (e.key === "ArrowRight" || (e.key === "Enter" && !onControl)) {
        e.preventDefault();
        e.stopPropagation();
        if (h.busy || s.choices) return;
        if (isLast) h.onDone();
        else h.onNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        if (!h.busy && h.index > 0) h.onBack();
        return;
      }
      // Tab and the keys a focused button uses stay with the card; the page gets nothing.
      if (!inCard) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const hole = rect ? { x: rect.x - HOLE_PAD, y: rect.y - HOLE_PAD, w: rect.w + HOLE_PAD * 2, h: rect.h + HOLE_PAD * 2 } : null;
  const width = cardWidth(vw);
  const at = placeCard(hole, { w: card?.w ?? width, h: card?.h ?? 160 }, vw, vh, insets);

  return (
    <Overlay>
      <View style={styles.layer}>
        {/* Blocks the page, and dims it outright when there is nothing to light. */}
        <View style={[styles.fill, hole ? null : { backgroundColor: colors.scrim }]} />
        {hole ? (
          <View
            pointerEvents="none"
            style={[styles.spot, { left: hole.x, top: hole.y, width: hole.w, height: hole.h }, transition("left, top, width, height", motion.medium)]}
          />
        ) : null}
        <TourCard
          props={props}
          cardRef={(el: unknown) => {
            cardRef.current = el as HTMLElement | null;
          }}
          cardProps={dialogProps}
          style={[{ left: at.x, top: at.y, width, opacity: card ? 1 : 0 }, noOutline]}
        />
      </View>
    </Overlay>
  );
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

// The card is a focusable dialog, so keys land on it rather than on the page behind. These
// aren't in this RN typing, hence the casts.
const dialogProps = { role: "dialog", focusable: true } as Record<string, unknown>;
const noOutline = { outlineStyle: "none" } as Record<string, unknown>;

const styles = {
  layer: { position: "fixed" as "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000 },
  fill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  // The lit hole: a hairline accent ring and a soft glow, with the rest of the window dimmed by
  // one enormous spread shadow, so the hole's corners stay round.
  spot: {
    position: "absolute" as const,
    borderRadius: radius.lg,
    boxShadow: `0 0 0 1px ${colors.accent}, 0 0 0 4px ${colors.focusRing}, 0 0 0 200vmax ${colors.scrim}`,
  } as Record<string, unknown>,
};
