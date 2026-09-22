import type { Ref } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { Button, Icon, Text, colors, icon, radius, shadow, space, useDensity, type PressState } from "@companion/design-system";
import { openExternalUrl } from "../externalUrl";
import type { AnchorRegistry, Rect } from "./anchors";
import type { TourChoice, TourDef, TourStep } from "./tours";

// The tutorial's card: which tutorial and step, the step's copy, a docs link, and the buttons.
// Shared by the web overlay (TourOverlay.web.tsx) and the native one (TourOverlay.tsx), which
// differ only in how they dim the page and find the element.

export interface TourOverlayProps {
  registry: AnchorRegistry;
  tour: TourDef;
  steps: readonly TourStep[];
  index: number;
  busy: boolean;
  /** Space system chrome takes at the window's edges, kept clear of the card. */
  insets?: { top: number; bottom: number };
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** End the tutorial from its last step. */
  onDone: () => void;
  onChoice: (choice: TourChoice) => void;
  onAction: () => void;
}

export const CARD_W = 300;
const GAP = 10;
const MARGIN = 12;
export const HOLE_PAD = 4;

/** The card's width in a window this wide. */
export function cardWidth(vw: number): number {
  return Math.min(CARD_W, vw - MARGIN * 2);
}

/** Where the card goes: beside the hole (below it by preference, or to the side of a tall one),
 *  kept inside the window and clear of its insets. With no room anywhere it sits inside the
 *  hole's lower edge. */
export function placeCard(
  hole: Rect | null,
  card: { w: number; h: number },
  vw: number,
  vh: number,
  insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
): { x: number; y: number } {
  const top = MARGIN + insets.top;
  const bottom = vh - MARGIN - insets.bottom;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - card.w - MARGIN));
  const clampY = (y: number) => Math.max(top, Math.min(y, bottom - card.h));
  if (!hole) return { x: clampX((vw - card.w) / 2), y: clampY((vh - card.h) / 2) };
  const midX = hole.x + hole.w / 2 - card.w / 2;
  const midY = hole.y + hole.h / 2 - card.h / 2;
  const below = { fits: hole.y + hole.h + GAP + card.h <= bottom, at: { x: clampX(midX), y: hole.y + hole.h + GAP } };
  const above = { fits: hole.y - GAP - card.h >= top, at: { x: clampX(midX), y: hole.y - GAP - card.h } };
  const right = { fits: hole.x + hole.w + GAP + card.w + MARGIN <= vw, at: { x: hole.x + hole.w + GAP, y: clampY(midY) } };
  const left = { fits: hole.x - GAP - card.w >= MARGIN, at: { x: hole.x - GAP - card.w, y: clampY(midY) } };
  const tall = hole.h > vh * 0.45;
  for (const side of tall ? [right, left, below, above] : [below, above, right, left]) {
    if (side.fits) return side.at;
  }
  return { x: clampX(midX), y: clampY(hole.y + hole.h - card.h - space.xxl) };
}

export function TourCard({
  props,
  cardRef,
  style,
  cardProps,
}: {
  props: TourOverlayProps;
  cardRef?: Ref<unknown>;
  style?: StyleProp<ViewStyle>;
  /** Extra props for the card's View (the web makes it a focusable dialog). */
  cardProps?: Record<string, unknown>;
}) {
  const { tour, steps, index, busy } = props;
  const step = steps[index];
  const last = index === steps.length - 1;
  // Pointer: dense buttons in one row. Touch: the density's own (bigger) buttons, and choices
  // and actions stacked full width, since a phone-wide row can't hold them.
  const touch = useDensity() === "touch";
  const size = touch ? undefined : "sm";

  const extras = step.choices
    ? step.choices.map((c) => (
        <Button key={c.label} label={c.label} variant={c.primary ? "primary" : touch ? "secondary" : "ghost"} size={size} fullWidth={touch} disabled={busy} onPress={() => props.onChoice(c)} />
      ))
    : step.action
      ? [<Button key="action" label={step.action.label} variant="secondary" size={size} fullWidth={touch} disabled={busy} onPress={props.onAction} />]
      : [];

  return (
    <View ref={cardRef as never} aria-label={`${tour.label}: ${step.title}`} {...cardProps} style={[styles.card, style]}>
      <View style={styles.head}>
        <Text variant="eyebrow" tone="accent" numberOfLines={1} style={{ flexShrink: 1 }}>
          {tour.label}
        </Text>
        {steps.length > 1 ? (
          <Text variant="mono" tone="quaternary">
            {index + 1}/{steps.length}
          </Text>
        ) : null}
      </View>
      <Text variant="label" style={styles.title}>
        {step.title}
      </Text>
      <Text variant="caption" tone="secondary" style={styles.body}>
        {step.body}
      </Text>
      {step.link ? <DocLink label={step.link.label} url={step.link.url} /> : null}
      {touch && extras.length ? <View style={styles.stack}>{step.choices ? [...extras].reverse() : extras}</View> : null}
      <View style={styles.foot}>
        {!touch && step.action ? extras : null}
        {!last && !step.choices ? <Button label="Skip" variant="ghost" size={size} disabled={busy} onPress={props.onSkip} /> : null}
        <View style={{ flex: 1 }} />
        {index > 0 ? <Button label="Back" variant="ghost" size={size} disabled={busy} onPress={props.onBack} /> : null}
        {step.choices ? (touch ? null : extras) : <Button label={last ? "Done" : "Next"} size={size} disabled={busy} onPress={last ? props.onDone : props.onNext} />}
      </View>
    </View>
  );
}

function DocLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      onPress={() => void openExternalUrl(url).catch(() => undefined)}
      aria-label={`${label} (opens in your browser)`}
      style={({ hovered }: PressState) => [styles.link, hovered ? styles.linkHover : null]}
    >
      <Text variant="caption" tone="accent">
        {label}
      </Text>
      <Icon name="external" size={icon.sm} color={colors.textAccent} />
    </Pressable>
  );
}

const styles = {
  card: {
    position: "absolute" as const,
    paddingHorizontal: space.lg,
    paddingTop: space.ml,
    paddingBottom: space.ml,
    gap: space.xs,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    ...shadow.lg,
  },
  head: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: space.sm },
  title: { marginTop: space.xxs, fontWeight: "600" as const },
  body: { lineHeight: 17 },
  link: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    alignSelf: "flex-start" as const,
    gap: space.xs,
    marginTop: space.xxs,
    borderRadius: radius.sm,
  },
  linkHover: { opacity: 0.8 },
  stack: { gap: space.sm, marginTop: space.sm },
  foot: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, marginTop: space.sm },
};
