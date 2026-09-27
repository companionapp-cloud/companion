import { File, Paths } from 'expo-file-system';
import type { LabsStorage } from '@companion/app';

// Labs switches are per device, like the rail's tool list, and React Native has no
// localStorage: the same small JSON file in the app's document directory as toolsStorage.ts.
const labsFile = new File(Paths.document, 'companion-labs.json');

export const nativeLabsStorage: LabsStorage = {
  load: () => {
    try {
      return labsFile.exists ? labsFile.textSync() : null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      if (!labsFile.exists) labsFile.create();
      labsFile.write(value);
    } catch {
      /* storage unavailable */
    }
  },
};
