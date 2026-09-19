import * as DocumentPicker from 'expo-document-picker';
import { setThingsSourcePicker } from '@companion/app';

// Registers the native Things database picker (PLAN §6.12): the OS document picker copies the
// chosen file — a .zip of "Things Database.thingsdatabase", or its main.sqlite — into the app's
// cache, and core reads it there by path. Web supplies its own upload picker inside @companion/app.
export function registerThingsSourcePicker(): void {
  setThingsSourcePicker(async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/zip', 'application/x-sqlite3', 'application/octet-stream', '*/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const path = decodeURIComponent(asset.uri.replace(/^file:\/\//, ''));
    return { source: { path }, label: asset.name ?? 'Things database' };
  }, 'document');
}
