import { File, Paths } from 'expo-file-system';

// Whether Today shows the day's agenda, remembered across launches. React Native has no
// localStorage, so this is the same file-backed pattern as toolsStorage.ts: a small JSON
// file in the app's sandboxed document directory — per-device, never synced. Shown until
// the user hides it.
const todayFile = new File(Paths.document, 'companion-today.json');

export function loadShowAgenda(): boolean {
  try {
    if (!todayFile.exists) return true;
    const saved: unknown = JSON.parse(todayFile.textSync());
    return !(typeof saved === 'object' && saved !== null && (saved as { showAgenda?: unknown }).showAgenda === false);
  } catch {
    return true;
  }
}

export function saveShowAgenda(show: boolean): void {
  try {
    if (!todayFile.exists) todayFile.create();
    todayFile.write(JSON.stringify({ showAgenda: show }));
  } catch {
    /* storage unavailable */
  }
}
