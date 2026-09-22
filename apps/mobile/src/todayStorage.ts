import { File, Paths } from 'expo-file-system';

// Which segment Today last showed, the note or the agenda, remembered across launches. React
// Native has no localStorage, so this is the same file-backed pattern as toolsStorage.ts: a small
// JSON file in the app's sandboxed document directory, per-device and never synced. The note
// until the user picks the agenda.
const todayFile = new File(Paths.document, 'companion-today.json');

export type TodaySegment = 'note' | 'agenda';

export function loadTodaySegment(): TodaySegment {
  try {
    if (!todayFile.exists) return 'note';
    const saved: unknown = JSON.parse(todayFile.textSync());
    return typeof saved === 'object' && saved !== null && (saved as { segment?: unknown }).segment === 'agenda' ? 'agenda' : 'note';
  } catch {
    return 'note';
  }
}

export function saveTodaySegment(segment: TodaySegment): void {
  try {
    if (!todayFile.exists) todayFile.create();
    todayFile.write(JSON.stringify({ segment }));
  } catch {
    /* storage unavailable */
  }
}
