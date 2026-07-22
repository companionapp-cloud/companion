import { ScrollView, StyleSheet } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Icon, colors, space } from "@companion/design-system";
import { visibleSettingsSections, type SettingsSectionId } from "../settingsSections";
import { Card, CardRow, IconTile } from "./ui";

// Mobile web settings — a port of the native app's list → detail settings: a card of
// sections that pushes to a detail screen for each, reusing the same section components
// the desktop master-detail page renders.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

export function SettingsListScreen() {
  const navigation = useNavigation<NavLike>();
  const sections = visibleSettingsSections();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card>
        {sections.map((s, i) => (
          <CardRow
            key={s.id}
            leading={
              <IconTile variant="neutral">
                <Icon name={s.icon} size={20} color={colors.textSecondary} />
              </IconTile>
            }
            title={s.label}
            subtitle={s.description}
            isLast={i === sections.length - 1}
            onPress={() => navigation.navigate("settingsSection", { section: s.id })}
          />
        ))}
      </Card>
    </ScrollView>
  );
}

export function SettingsSectionScreen() {
  const params = (useRoute().params ?? {}) as { section?: SettingsSectionId };
  const section = visibleSettingsSections().find((s) => s.id === params.section);
  if (!section) return null;
  const Detail = section.Component;
  return (
    <ScrollView contentContainerStyle={styles.sectionContent}>
      <Detail />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, gap: space.xs },
  sectionContent: { padding: space.md, gap: space.lg },
});
