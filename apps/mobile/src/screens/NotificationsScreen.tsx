import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { NotificationsScreen as SharedNotificationsScreen } from '@companion/app';
import type { RootStackParamList } from '../MobileShell';

// The shared notifications feed (PLAN §6.4), hosted in the mobile stack: tapping an entry
// opens the task's full-screen editor.
export function NotificationsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return <SharedNotificationsScreen onOpenTask={(id) => nav.navigate('TaskEditor', { id })} />;
}
