import { useLayoutEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { settingsSection, visibleSettingsSections } from '@companion/app';
import { Icon, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { Card, CardRow, IconTile } from '../ui/native';

// Mobile settings as an actual screen (not a modal): one grouped card of sections that
// pushes to a detail screen for each, the phone-native equivalent of the desktop
// content-details page.
export function SettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  // Only the sections that apply here (no system-wide shortcuts on a phone).
  const sections = visibleSettingsSections();
  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xxl }]}>
      <Card>
        {sections.map((s, i) => (
          <CardRow
            key={s.id}
            leading={
              <IconTile>
                <Icon name={s.icon} size={20} color={colors.textSecondary} />
              </IconTile>
            }
            title={s.label}
            subtitle={s.description}
            isLast={i === sections.length - 1}
            onPress={() => nav.navigate('SettingsSection', { section: s.id })}
          />
        ))}
      </Card>
    </ScrollView>
  );
}

// The detail for one settings section, reusing the same section component the desktop
// page renders. The nav bar title tracks the section.
export function SettingsSectionScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsSection'>>();
  const section = settingsSection(route.params.section);
  const Detail = section.Component;
  useLayoutEffect(() => {
    nav.setOptions({ title: section.label });
  }, [nav, section.label]);
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.detail, { paddingBottom: insets.bottom + space.xxl }]}
      keyboardShouldPersistTaps="handled"
    >
      <Detail />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { padding: space.lg },
  // The 16px touch page gutter: section detail is forms and prose, not a grouped card.
  detail: { padding: space.xl, gap: space.lg },
});
