import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Icon, SplitView, Text, colors, layout, radius, space, type PressState } from "@companion/design-system";
import { visibleSettingsSections, settingsSection, type SettingsSectionId } from "./settingsSections";

/** The settings page (web/desktop): a content-details master-detail rendered in the main
 *  content area — not a modal. The list column is the settings navigation (Sync / AI /
 *  Objects); the detail pane renders the selected section. Mirrors the ProjectView
 *  master-detail so settings reads as a first-class screen (PLAN §3.1 shell). */
export function SettingsScreen() {
  const [selected, setSelected] = useState<SettingsSectionId>("sync");
  const section = settingsSection(selected);
  const Detail = section.Component;

  return (
    <SplitView
      aside={<SettingsNav selected={selected} onSelect={setSelected} />}
      storageKey="companion.settings.listWidth"
      defaultWidth={260}
      minWidth={220}
      maxWidth={360}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.detailScroll}>
        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <Text variant="title">{section.label}</Text>
            <Text variant="caption" tone="tertiary">
              {section.description}
            </Text>
          </View>
          <Detail />
        </View>
      </ScrollView>
    </SplitView>
  );
}

function SettingsNav({ selected, onSelect }: { selected: SettingsSectionId; onSelect: (id: SettingsSectionId) => void }) {
  return (
    <View style={styles.nav}>
      <Text variant="title" style={styles.navTitle}>
        Settings
      </Text>
      <View style={{ gap: 2 }}>
        {visibleSettingsSections().map((s) => {
          const active = s.id === selected;
          return (
            <Pressable
              key={s.id}
              onPress={() => onSelect(s.id)}
              style={({ hovered }: PressState) => [
                styles.navRow,
                active ? styles.navRowActive : hovered ? styles.navRowHover : null,
              ]}
            >
              <Icon name={s.icon} size={17} color={active ? colors.accentHover : colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text tone={active ? "accent" : undefined}>{s.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = {
  nav: { flex: 1, padding: space.md, gap: space.md },
  navTitle: { paddingHorizontal: space.sm, paddingTop: space.xs },
  navRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  navRowActive: { backgroundColor: colors.accentSoft },
  navRowHover: { backgroundColor: colors.surfaceHover },
  // Center the detail column: the scroll container aligns its child, the child caps its
  // width. (marginHorizontal:auto on a ScrollView content container doesn't center in RNW.)
  detailScroll: {
    alignItems: "center" as const,
    padding: space.xxl,
  },
  detail: {
    width: "100%" as const,
    maxWidth: layout.contentMax,
    gap: space.xl,
  },
  detailHeader: { gap: space.xs },
};
