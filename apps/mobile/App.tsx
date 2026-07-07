import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import EventSource from 'react-native-sse';
import { CoreProvider, NotesProvider, TasksProvider, RemindersProvider, ProjectsProvider, ObjectTypesProvider, SyncProvider, type NotificationScheduler } from '@companion/app';
import { createNativeSyncNotifier, type CoreBridge, type SyncNotifier } from '@companion/core-bridge';
import { MobileShell } from './src/MobileShell';
import { openCore } from './src/core';
import { createMobileNotificationScheduler, REMINDER_HORIZON_DAYS } from './src/notifications';
import { registerReminderRefresh } from './src/backgroundReminders';
import { nativeSyncStorage } from './src/syncStorage';

// Opens the on-device SQLite database via the shared core singleton, wraps it in the
// shared CoreBridge, then mounts the shared data layer (Core/Sync/Notes providers)
// under a mobile-native shell. The desktop AppShell is intentionally NOT used here.
function Root() {
  const [bridge, setBridge] = useState<CoreBridge | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Realtime SSE notifier (PLAN §7.5). react-native-sse + AppState are injected here
  // so core-bridge carries no react-native dependency. Foreground-only: SSE dies on
  // background (the OS kills the socket), so we catch up on next foreground.
  const notifier = useMemo<SyncNotifier>(
    () => createNativeSyncNotifier({ EventSource, appState: AppState }),
    [],
  );

  // Reminder scheduling (PLAN §6.4): expo-notifications local notifications, injected so the
  // shared RemindersProvider stays react-native-free. Taps deep-link inside MobileShell.
  const notificationScheduler = useMemo<NotificationScheduler>(
    () => createMobileNotificationScheduler(),
    [],
  );

  useEffect(() => {
    try {
      // Shared with the background reminder task; don't close on unmount (the OS reclaims
      // the core on process teardown, and closing would break a task running in this
      // process).
      setBridge(openCore());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Register the periodic background refresh that keeps reminders (incl. ones created on
  // other devices) armed while the app is closed (PLAN §6.4, Option B). Best-effort.
  useEffect(() => {
    void registerReminderRefresh();
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to start core:{'\n'}{error}</Text>
      </View>
    );
  }
  if (!bridge) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <CoreProvider core={bridge}>
      <SyncProvider storage={nativeSyncStorage} notifier={notifier}>
        <NotesProvider>
          <TasksProvider>
            <RemindersProvider scheduler={notificationScheduler} horizonDays={REMINDER_HORIZON_DAYS}>
              <ProjectsProvider>
                <ObjectTypesProvider>
                  <MobileShell />
                </ObjectTypesProvider>
              </ProjectsProvider>
            </RemindersProvider>
          </TasksProvider>
        </NotesProvider>
      </SyncProvider>
    </CoreProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  error: { color: '#b00020', textAlign: 'center', paddingHorizontal: 24 },
});
