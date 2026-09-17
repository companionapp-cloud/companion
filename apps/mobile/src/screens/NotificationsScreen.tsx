import { useLayoutEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { NotificationsScreen as SharedNotificationsScreen, useNotifications } from '@companion/app';
import type { RootStackParamList } from '../MobileShell';
import { NavAction } from '../ui/native';

// The shared notifications feed (PLAN §6.4), hosted in the mobile stack: tapping an entry
// opens the task's full-screen editor. Under touch density the shared screen drops its
// title and "Mark all read" button, so mark-all-read is the nav bar's action.
export function NotificationsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { unreadCount, markAllRead } = useNotifications();

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <NavAction icon="check" label="Mark all read" disabled={unreadCount === 0} onPress={() => void markAllRead()} />
      ),
    });
  }, [nav, unreadCount, markAllRead]);

  return <SharedNotificationsScreen onOpenTask={(id) => nav.navigate('TaskEditor', { id })} />;
}
