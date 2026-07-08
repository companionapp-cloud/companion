import { File, Paths } from 'expo-file-system';
import type { ToolsStorage } from '@companion/app';

// React Native has no localStorage, so the shared ToolVisibilityProvider's default
// backend would silently drop the hidden set. Same file-backed pattern as
// syncStorage.ts: a small JSON file in the app's sandboxed document directory —
// per-device by construction, which is exactly the contract (tool hiding never syncs).
const toolsFile = new File(Paths.document, 'companion-tools.json');

export const nativeToolsStorage: ToolsStorage = {
  load: () => {
    try {
      return toolsFile.exists ? toolsFile.textSync() : null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      if (!toolsFile.exists) toolsFile.create();
      toolsFile.write(value);
    } catch {
      /* storage unavailable */
    }
  },
};
