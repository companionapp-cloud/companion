import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { CoreProvider, NotesProvider, SyncProvider } from '@companion/app';
import { createNativeBridge } from '@companion/core-bridge/native';
import type { CoreBridge } from '@companion/core-bridge';
import CompanionCore from './modules/companion-core';
import { MobileShell } from './src/MobileShell';

// gomobile's Core.New wants a filesystem path, not a file:// URI.
function toFsPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

// Opens the on-device SQLite database via the native core module, wraps it in the
// shared CoreBridge, then mounts the shared data layer (Core/Sync/Notes providers)
// under a mobile-native shell. The desktop AppShell is intentionally NOT used here.
function Root() {
  const [bridge, setBridge] = useState<CoreBridge | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let created: CoreBridge | null = null;
    try {
      const dbPath = `${toFsPath(Paths.document.uri).replace(/\/$/, '')}/companion.db`;
      CompanionCore.initialize(dbPath);
      created = createNativeBridge({ module: CompanionCore, emitter: CompanionCore });
      setBridge(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => created?.close();
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
      <SyncProvider>
        <NotesProvider>
          <MobileShell />
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
