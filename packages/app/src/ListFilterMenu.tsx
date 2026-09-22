import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Icon, Text, colors, control, font, icon, radius, row, shadow, space, transition, motion, useDensity, type PressState } from "@companion/design-system";
import { TourAnchor } from "./onboarding/anchors";

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

/** A section-title dropdown that filters a browse list (PLAN §6.6). The trigger reads as the
 *  current option's label with a chevron; tapping it opens a menu of options with a check on
 *  the active one. Shared by desktop (the Notes/Tasks list headers) and mobile. Generic over
 *  the filter value so any small enum works. */
export function ListFilterMenu<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const touch = useDensity() === "touch";
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <View style={styles.root}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        aria-label="Filter list"
        style={({ hovered, pressed }: PressState) => [
          styles.trigger,
          touch ? styles.triggerTouch : null,
          transition("background-color", motion.instant),
          { backgroundColor: pressed || open ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
        ]}
      >
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {current.label}
        </Text>
        <Icon name="chevronDown" size={11} color={colors.textQuaternary} />
      </Pressable>
      {open ? (
        <>
          {/* Full-bleed scrim closes the menu on an outside tap. */}
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} aria-label="Close filter" />
          <View style={styles.menu}>
            {options.map((o) => (
              <Pressable
                key={o.value}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                style={({ hovered, pressed }: PressState) => [
                  styles.option,
                  touch ? styles.optionTouch : null,
                  { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                ]}
              >
                <Text variant="label" tone={o.value === value ? "default" : "secondary"} numberOfLines={1} style={{ flex: 1 }}>
                  {o.label}
                </Text>
                {o.value === value ? <Icon name="check" size={icon.sm} color={colors.textAccent} /> : null}
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** A segmented (tab) variant of the list filter — used on mobile, where a floating dropdown
 *  over a scroll list is fiddly. Same options/value contract as ListFilterMenu. */
export function ListFilterTabs<T extends string>({
  value,
  options,
  onChange,
  scroll,
  anchorPrefix,
}: {
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
  /** More segments than a phone is wide (the task lists' six): keep them full size and let the
   *  track scroll sideways instead of squeezing every label. */
  scroll?: boolean;
  /** Make each segment a tutorial anchor, `<prefix><value>` (a page's sections). */
  anchorPrefix?: string;
}) {
  const touch = useDensity() === "touch";
  if (scroll) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={tabStyles.scroller}>
        <ListFilterTabs value={value} options={options} onChange={onChange} anchorPrefix={anchorPrefix} />
      </ScrollView>
    );
  }
  return (
    <View style={tabStyles.track}>
      {options.map((o) => {
        const active = o.value === value;
        const segment = (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            aria-label={o.label}
            style={({ hovered, pressed }: PressState) => [
              tabStyles.segment,
              { minHeight: touch ? control.lg : control.md },
              active ? tabStyles.segmentActive : pressed ? tabStyles.segmentPressed : hovered ? tabStyles.segmentHover : null,
            ]}
          >
            <Text variant="caption" tone={active ? "default" : "secondary"} numberOfLines={1} style={active ? tabStyles.activeLabel : undefined}>
              {o.label}
            </Text>
          </Pressable>
        );
        return anchorPrefix ? (
          <TourAnchor key={o.value} id={`${anchorPrefix}${o.value}`} style={tabStyles.anchor}>
            {segment}
          </TourAnchor>
        ) : (
          segment
        );
      })}
    </View>
  );
}

// A sunken track with hairline; the selected segment is the one raised card in it. Sized by
// its content (alignSelf) and free to shrink, so it sits inside a mobile nav bar.
const tabStyles = {
  scroller: { flexGrow: 0, maxWidth: "100%" as const },
  track: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    alignSelf: "flex-start" as const,
    maxWidth: "100%" as const,
    flexShrink: 1,
    gap: space.xxs,
    padding: space.xxs,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  // A segment wrapped as a tutorial anchor: the wrapper takes the segment's place in the row.
  anchor: { flexShrink: 1, minWidth: 0 },
  segment: {
    flexShrink: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  segmentHover: { backgroundColor: colors.surfaceHover },
  segmentPressed: { backgroundColor: colors.surfaceActive },
  segmentActive: { backgroundColor: colors.surfaceCard, ...shadow.sm },
  activeLabel: { fontWeight: font.weight.semibold },
};

const styles = {
  root: { position: "relative" as const, zIndex: 30, alignItems: "flex-start" as const },
  // No pill: the label reads as the list's title; only hover/press gives it a fill.
  trigger: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 3,
    maxWidth: "100%" as const,
    minHeight: control.sm,
    marginLeft: -space.xs,
    paddingHorizontal: space.xs,
    borderRadius: radius.sm,
  },
  triggerTouch: { minHeight: control.lg },
  scrim: { position: "absolute" as const, top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  menu: {
    position: "absolute" as const,
    top: "100%" as const,
    left: -space.xs,
    marginTop: space.xxs,
    minWidth: 176,
    gap: 1,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: space.xs,
    zIndex: 40,
    ...shadow.md,
  },
  option: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  optionTouch: { minHeight: row.touch, paddingHorizontal: space.ml },
};
