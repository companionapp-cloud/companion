import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import EventSource from 'react-native-sse';
import { CoreProvider, NotesProvider, TasksProvider, RemindersProvider, NotificationsProvider, ProjectsProvider, ObjectTypesProvider, CalendarProvider, SyncProvider, ToolVisibilityProvider, RecoveryResetScreen, type NotificationScheduler } from '@companion/app';
import { createNativeSyncNotifier, type CoreBridge, type SyncNotifier } from '@companion/core-bridge';
import { MobileShell } from './src/MobileShell';
import { openCore } from './src/core';
import { createMobileNotificationScheduler, REMINDER_HORIZON_DAYS } from './src/notifications';
import { registerReminderRefresh } from './src/backgroundReminders';
import { nativeSyncStorage } from './src/syncStorage';
import { nativeToolsStorage } from './src/toolsStorage';
import { registerIcsFilePicker } from './src/icsFilePicker';

// Register the native .ics file picker so the shared CalendarSettings can upload calendars
// on mobile (web uses its own DOM picker). Module-scope: runs once at import.
registerIcsFilePicker();

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

  // Forgot-password recovery deep link. Linking.useURL() yields the URL the app was opened with (or
  // navigated to); a reset link carries resetToken + server. Dismissed once the flow finishes.
  const url = Linking.useURL();
  const [resetDismissed, setResetDismissed] = useState(false);
  const reset = resetDismissed ? null : parseResetUrl(url);

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
  // A forgot-password reset deep link (companion://…?resetToken=…&server=…) takes over: run the
  // recovery flow with the local crypto core before the normal app. Needs `scheme` in app.json and
  // an `expo prebuild` to receive the link (PLAN §E2EE).
  if (reset) {
    return (
      <CoreProvider core={bridge}>
        <RecoveryResetScreen baseUrl={reset.baseUrl} token={reset.token} onDone={() => setResetDismissed(true)} />
      </CoreProvider>
    );
  }
  return (
    <CoreProvider core={bridge}>
      <SyncProvider storage={nativeSyncStorage} notifier={notifier}>
        <NotesProvider>
          <TasksProvider>
            <RemindersProvider scheduler={notificationScheduler} horizonDays={REMINDER_HORIZON_DAYS}>
              <NotificationsProvider>
                <ProjectsProvider>
                  <ObjectTypesProvider>
                    <CalendarProvider>
                      <ToolVisibilityProvider storage={nativeToolsStorage}>
                        <MobileShell />
                      </ToolVisibilityProvider>
                    </CalendarProvider>
                  </ObjectTypesProvider>
                </ProjectsProvider>
              </NotificationsProvider>
            </RemindersProvider>
          </TasksProvider>
        </NotesProvider>
      </SyncProvider>
    </CoreProvider>
  );
}

// parseResetUrl extracts a reset deep link's token + server API base from an opened URL, or null.
// Handles both custom-scheme (companion://…) and universal (https://…) links by parsing the query.
function parseResetUrl(url: string | null): { token: string; baseUrl: string } | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const token = params.get('resetToken');
  const server = params.get('server');
  return token && server ? { token, baseUrl: server } : null;
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
