import { useSyncExternalStore } from "react";

// Labs: opt-in experiments, one switch each. Device-local like the rail's tool list (an
// experiment is a choice per machine, not synced data), behind the same synchronous storage
// contract so a native shell can inject its file-backed store with setLabsStorage. Every
// flag is off until switched on.

export type LabsFlag = "notebooks" | "ancientMediums" | "notebookBindings";

export interface LabsStorage {
  load(): string | null;
  save(value: string): void;
}

const STORAGE_KEY = "companion.labs";

let storage: LabsStorage = {
  load: () => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable */
    }
  },
};

let flags: Partial<Record<LabsFlag, boolean>> | null = null;
const listeners = new Set<() => void>();

function current(): Partial<Record<LabsFlag, boolean>> {
  if (!flags) {
    try {
      flags = JSON.parse(storage.load() ?? "{}") ?? {};
    } catch {
      flags = {};
    }
  }
  return flags!;
}

/** Use a shell's own storage (native: a file). Call before first render. */
export function setLabsStorage(s: LabsStorage) {
  storage = s;
  flags = null;
}

export function labsFlag(flag: LabsFlag): boolean {
  return current()[flag] === true;
}

export function setLabsFlag(flag: LabsFlag, on: boolean) {
  flags = { ...current(), [flag]: on };
  storage.save(JSON.stringify(flags));
  listeners.forEach((l) => l());
}

/** A flag, re-rendering when it's switched. */
export function useLabsFlag(flag: LabsFlag): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => labsFlag(flag),
    () => false,
  );
}
