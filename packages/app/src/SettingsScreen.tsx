import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Icon, ListRow, SplitView, Text, colors, icon, space } from "@companion/design-system";
import { visibleSettingsSections, settingsSection, type SettingsSectionId } from "./settingsSections";

/** The settings page (web/desktop): a content-details master-detail rendered in the main
 *  content area — not a modal. A 190px section list (dense rows, hairline on its right)
 *  beside a 520px-max content column that renders the selected section. Mirrors the
 *  ProjectView master-detail so settings reads as a first-class screen (PLAN §3.1 shell). */
export function SettingsScreen() {
  const [selected, setSelected] = useState<SettingsSectionId>("sync");
  const section = settingsSection(selected);
  const Detail = section.Component;

  return (
    <SplitView
      aside={<SettingsNav selected={section.id} onSelect={setSelected} />}
      storageKey="companion.settings.navWidth"
      defaultWidth={190}
      minWidth={160}
      maxWidth={260}
    >
      <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <Text variant="heading">{section.label}</Text>
            <Text variant="caption" tone="secondary">
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
    <ScrollView style={styles.nav} contentContainerStyle={styles.navContent}>
      {visibleSettingsSections().map((s) => {
        const active = s.id === selected;
        return (
          <ListRow
            key={s.id}
            icon={<Icon name={s.icon} size={icon.sm} color={active ? colors.textAccent : colors.textQuaternary} />}
            title={s.label}
            selected={active}
            onPress={() => onSelect(s.id)}
          />
        );
      })}
    </ScrollView>
  );
}

const styles = {
  nav: { flex: 1, backgroundColor: colors.surfaceCard },
  navContent: { padding: space.xs, gap: 1 },
  detailScroll: { flex: 1, backgroundColor: colors.surfaceCard },
  detailContent: { paddingVertical: space.xl2, paddingHorizontal: space.xxl },
  // The column hugs the left edge at 520px — a form, not a centred document.
  detail: { width: "100%" as const, maxWidth: 520, gap: space.xl },
  detailHeader: { gap: space.xs },
};
