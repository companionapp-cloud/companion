import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, Text, colors, radius, shadow, space, type PressState } from "@companion/design-system";

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
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <View style={styles.root}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        aria-label="Filter list"
        style={({ hovered }: PressState) => [styles.trigger, hovered ? styles.triggerHover : null]}
      >
        <Text variant="caption" tone="secondary" style={styles.triggerLabel}>
          {current.label}
        </Text>
        <View style={{ transform: [{ rotate: open ? "-90deg" : "90deg" }] }}>
          <Icon name="chevronRight" size={12} color={colors.textTertiary} />
        </View>
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
                style={({ hovered }: PressState) => [styles.option, hovered ? styles.optionHover : null]}
              >
                <Text variant="caption" tone={o.value === value ? "default" : "secondary"}>
                  {o.label}
                </Text>
                {o.value === value ? <Icon name="check" size={13} color={colors.accent} /> : null}
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
}: {
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={tabStyles.row}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={[tabStyles.tab, active ? tabStyles.tabActive : null]}>
            <Text variant="caption" tone={active ? "default" : "secondary"} style={active ? tabStyles.tabActiveLabel : undefined}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const tabStyles = {
  row: { flexDirection: "row" as const, gap: space.xs, padding: 3, backgroundColor: colors.gray50, borderRadius: radius.md, alignSelf: "flex-start" as const },
  tab: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.sm },
  tabActive: { backgroundColor: colors.surfaceCard, ...shadow.sm },
  tabActiveLabel: { fontWeight: "600" as const },
};

const styles = {
  root: { position: "relative" as const, zIndex: 30 },
  trigger: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    marginLeft: -space.xs,
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  triggerHover: { backgroundColor: colors.surfaceHover },
  triggerLabel: { fontWeight: "600" as const },
  scrim: { position: "absolute" as const, top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  menu: {
    position: "absolute" as const,
    top: 26,
    left: -space.xs,
    minWidth: 176,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    paddingVertical: space.xs,
    zIndex: 40,
    ...shadow.md,
  },
  option: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  optionHover: { backgroundColor: colors.surfaceHover },
};
