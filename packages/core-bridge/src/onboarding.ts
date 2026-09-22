import type { CoreBridge } from "./types";

/** How a tour was settled: walked to its last step, or skipped. */
export type OnboardingOutcome = "completed" | "skipped";

/** One settled tour (mirrors core/domain.Onboarding): the user finished or skipped `tourVersion`
 *  of `tour`. A tour is settled once a row exists for its current version or a later one. */
export interface OnboardingRecord {
  id: string;
  tour: string;
  tourVersion: number;
  outcome: OnboardingOutcome;
  createdAt: string;
  updatedAt: string;
}

/** A tour to settle. */
export interface OnboardingEntry {
  tour: string;
  tourVersion: number;
  outcome: OnboardingOutcome;
  /** Forget the tour's earlier rows first: for a row that holds a choice the user can change
   *  (whether tutorials show at all) rather than a fact. */
  replace?: boolean;
}

/** Fired after a local write changes the settled tours. Rows another device settled arrive with
 *  the `data.changed` every sync emits. */
export const ONBOARDING_CHANGED_EVENT = "onboarding.changed";

/** Typed wrapper over the onboarding.* core methods: which guided tours the user has settled.
 *  The rows sync, so a tour seen on one device is not shown again on another. */
export function onboardingApi(core: CoreBridge) {
  return {
    /** Every settled tour version. */
    list: () => core.invoke<OnboardingRecord[]>("onboarding.list"),
    /** Settle tours. One already settled at that version (or a later one) is left as it is,
     *  unless the entry asks to replace it. */
    record: (entries: OnboardingEntry[]) => core.invoke<OnboardingRecord[]>("onboarding.record", { entries }),
    /** Forget the named tours (every tour when none are named), so each shows again. */
    reset: (tours?: string[]) => core.invoke<{ count: number }>("onboarding.reset", { tours: tours ?? [] }),
    onChanged: (cb: () => void) => core.on(ONBOARDING_CHANGED_EVENT, cb),
  };
}

export type OnboardingApi = ReturnType<typeof onboardingApi>;
