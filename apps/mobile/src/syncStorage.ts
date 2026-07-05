import { File, Paths } from 'expo-file-system';
import type { SyncStorage } from '@companion/app';

// React Native has no localStorage, so the shared SyncProvider's default backend
// silently dropped the sync config — settings didn't survive a cold boot. This
// persists it to a small JSON file in the app's document directory (sandboxed
// per-app), using expo-file-system's synchronous read/write API so it slots into
// SyncProvider's synchronous SyncStorage contract.
const configFile = new File(Paths.document, 'companion-sync.json');

export const nativeSyncStorage: SyncStorage = {
  load: () => {
    try {
      return configFile.exists ? configFile.textSync() : null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      if (!configFile.exists) configFile.create();
      configFile.write(value);
    } catch {
      /* storage unavailable */
    }
  },
  clear: () => {
    try {
      if (configFile.exists) configFile.delete();
    } catch {
      /* storage unavailable */
    }
  },
};
