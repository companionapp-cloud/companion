import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { setIcsFilePicker, type IcsFile } from '@companion/app';

// Registers the native .ics picker used by the shared CalendarSettings (PLAN §6.7): the OS
// document picker returns a file:// URI, which expo-file-system reads as text. The raw ICS
// is then stored on the feed row and parsed server-side, like a URL feed. Web supplies its
// own DOM-based picker inside @companion/app, so this is native-only.
export function registerIcsFilePicker(): void {
  setIcsFilePicker(async (): Promise<IcsFile | null> => {
    const res = await DocumentPicker.getDocumentAsync({
      // Some providers report .ics as octet-stream; accept broadly and validate on the server.
      type: ['text/calendar', 'application/octet-stream', '*/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const text = await FileSystem.readAsStringAsync(asset.uri);
    return { name: asset.name ?? 'calendar.ics', text };
  });
}
