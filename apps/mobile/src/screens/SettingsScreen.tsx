import { useLayoutEffect } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SETTINGS_SECTIONS, settingsSection } from '@companion/app';
import { Icon, Text, colors, radius, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// Mobile settings as an actual screen (not a modal): a list of sections that pushes to a
// detail screen for each, the phone-native equivalent of the desktop content-details page.
export function SettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.xs }}>
      {SETTINGS_SECTIONS.map((s) => (
        <Pressable
          key={s.id}
          onPress={() => nav.navigate('SettingsSection', { section: s.id })}
          style={styles.row}
        >
          <Icon name={s.icon} size={20} color={colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text>{s.label}</Text>
            <Text variant="caption" tone="tertiary">
              {s.description}
            </Text>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textTertiary} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

// The detail for one settings section, reusing the same section component the desktop
// page renders. The header title tracks the section.
export function SettingsSectionScreen() {
  const nav = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsSection'>>();
  const section = settingsSection(route.params.section);
  const Detail = section.Component;
  useLayoutEffect(() => {
    nav.setOptions({ title: section.label });
  }, [nav, section.label]);
  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg }}>
      <Detail />
    </ScrollView>
  );
}

const styles = {
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
  },
};
