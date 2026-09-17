import { ScrollView, StyleSheet, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Icon, colors, icon, space } from "@companion/design-system";
import { SETTINGS_SECTIONS, visibleSettingsSections, type SettingsSectionId } from "../settingsSections";
import { Card, CardRow, IconTile, NavBar } from "./ui";

// Mobile web settings — a port of the native app's list → detail settings: a grouped card
// of sections that pushes to a detail screen for each, reusing the same section components
// the desktop master-detail page renders.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

export function SettingsListScreen() {
  const navigation = useNavigation<NavLike>();
  const sections = visibleSettingsSections();
  return (
    <View style={styles.root}>
      <NavBar title="Settings" />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          {sections.map((s, i) => (
            <CardRow
              key={s.id}
              leading={
                <IconTile variant="neutral">
                  <Icon name={s.icon} size={icon.tile} color={colors.textSecondary} />
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
    </View>
  );
}

export function SettingsSectionScreen() {
  const params = (useRoute().params ?? {}) as { section?: SettingsSectionId };
  const section = visibleSettingsSections().find((s) => s.id === params.section);
  const Detail = section?.Component;
  return (
    <View style={styles.root}>
      <NavBar title={section?.label ?? SETTINGS_SECTIONS.find((s) => s.id === params.section)?.label ?? "Settings"} />
      {Detail ? (
        <ScrollView contentContainerStyle={styles.sectionContent}>
          <Detail />
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { padding: space.ml },
  // A page gutter, not a card inset: section detail is forms and prose, so it takes 16px.
  sectionContent: { padding: space.xl, gap: space.lg },
});
