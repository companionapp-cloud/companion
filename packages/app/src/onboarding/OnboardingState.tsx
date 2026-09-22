import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OnboardingEntry, OnboardingOutcome, OnboardingRecord } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";

// What the user has seen of onboarding: the welcome sheet, whether they want tutorials, and each
// tutorial settled. It all lives in core as synced rows (onboarding.*), loaded here once for the
// whole app so the welcome sheet (every shell) and the tutorials (the desktop shell) agree.

/** The welcome sheet. Bump the version to show a changed sheet to everyone once more. */
export const WELCOME = { id: "welcome", version: 1 } as const;
/** The row holding whether tutorials show at all: completed = yes, skipped = no. */
const TUTORIALS = "tutorials";

export interface OnboardingState {
  /** False until the rows have loaded. */
  loaded: boolean;
  rows: readonly OnboardingRecord[];
  /** The highest version of a tour the user has settled (0 for none). */
  settled: (tour: string) => number;
  /** How the user last settled a tour at `version` or later, or null. */
  outcome: (tour: string, version: number) => OnboardingOutcome | null;
  welcomeSeen: boolean;
  /** The user's answer to "enable tutorials?". On until they say otherwise. */
  tutorialsEnabled: boolean;
  /** Settle tours. Counted at once; the write follows. */
  record: (entries: OnboardingEntry[]) => Promise<void>;
  /** The welcome sheet was read, and whether the user wants tutorials. */
  finishWelcome: (tutorials: boolean) => Promise<void>;
  setTutorialsEnabled: (on: boolean) => Promise<void>;
  /** Forget the named tours, so each shows again. */
  reset: (tours: string[]) => Promise<void>;
}

const Ctx = createContext<OnboardingState | null>(null);

export function useOnboardingState(): OnboardingState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOnboardingState must be used within OnboardingStateProvider");
  return v;
}

/** The onboarding state, or null where the app root didn't mount it (the native app). */
export function useOptionalOnboardingState(): OnboardingState | null {
  return useContext(Ctx);
}

export function OnboardingStateProvider({ children }: { children: ReactNode }) {
  const { core, onboarding } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [rows, setRows] = useState<OnboardingRecord[] | null>(null);

  const refresh = useCallback(() => {
    onboarding
      .list()
      .then(setRows)
      .catch(() => setRows((r) => r ?? []));
  }, [onboarding]);
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A sync pull lands with a bulk data.changed; local edits of anything fire it too, so debounce.
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const offOwn = onboarding.onChanged(soon);
    const offData = core.on("data.changed", soon);
    return () => {
      offOwn();
      offData();
      if (timer) clearTimeout(timer);
    };
  }, [core, onboarding, refresh]);

  const record = useCallback(
    async (entries: OnboardingEntry[]) => {
      // Count them straight away (the tutorial must not start again while the write is on its
      // way); the reload after the write replaces these stand-ins.
      const now = new Date().toISOString();
      setRows((r) => {
        const replaced = new Set(entries.filter((e) => e.replace).map((e) => e.tour));
        const kept = (r ?? []).filter((row) => !replaced.has(row.tour));
        return [...kept, ...entries.map((e) => ({ id: `pending:${e.tour}`, tour: e.tour, tourVersion: e.tourVersion, outcome: e.outcome, createdAt: now, updatedAt: now }))];
      });
      try {
        await onboarding.record(entries);
      } catch {
        // Kept for this session; the next reload shows what was really written.
      }
      syncTrigger();
    },
    [onboarding, syncTrigger],
  );

  const reset = useCallback(
    async (tours: string[]) => {
      if (tours.length === 0) return;
      await onboarding.reset(tours);
      refresh();
      syncTrigger();
    },
    [onboarding, refresh, syncTrigger],
  );

  const value = useMemo<OnboardingState>(() => {
    const list = rows ?? [];
    const settled = (tour: string) => list.reduce((max, r) => (r.tour === tour ? Math.max(max, r.tourVersion) : max), 0);
    const outcome = (tour: string, version: number) => {
      let latest: OnboardingRecord | null = null;
      for (const r of list) {
        if (r.tour === tour && r.tourVersion >= version && (!latest || r.createdAt > latest.createdAt)) latest = r;
      }
      return latest?.outcome ?? null;
    };
    const tutorials = (on: boolean): OnboardingEntry => ({ tour: TUTORIALS, tourVersion: 1, outcome: on ? "completed" : "skipped", replace: true });
    return {
      loaded: rows !== null,
      rows: list,
      settled,
      outcome,
      welcomeSeen: settled(WELCOME.id) >= WELCOME.version,
      tutorialsEnabled: outcome(TUTORIALS, 1) !== "skipped",
      record,
      finishWelcome: (on) => record([{ tour: WELCOME.id, tourVersion: WELCOME.version, outcome: "completed" }, tutorials(on)]),
      setTutorialsEnabled: (on) => record([tutorials(on)]),
      reset,
    };
  }, [rows, record, reset]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
