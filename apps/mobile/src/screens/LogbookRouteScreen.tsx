import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LogbookScreen } from '@companion/app';
import { colors } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// The Logbook under the stack's nav bar (the native twin of the mobile web shell's
// LogbookRouteScreen). The shared LogbookScreen owns the list; rows open through this stack.
export function LogbookRouteScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <View style={styles.root}>
      <LogbookScreen onOpenTask={(id) => nav.navigate('TaskEditor', { id })} onOpenProject={(projectId) => nav.navigate('Project', { projectId })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
