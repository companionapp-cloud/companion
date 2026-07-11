import type { CalendarFeed, CalendarItem, CoreBridge } from "./types";

export interface CreateFeedInput {
  name: string;
  /** A subscription URL, or "" when supplying `icsText` from an uploaded file. */
  url: string;
  /** Raw contents of an uploaded .ics file (parsed server-side). Provide this or `url`. */
  icsText?: string | null;
  color?: string | null;
}

export interface UpdateFeedInput {
  name?: string;
  url?: string;
  icsText?: string | null;
  color?: string | null;
}

/** Typed wrappers over the calendar.* core methods (PLAN §6.7). Feeds are user-authored
 *  ICS subscriptions (they sync); the events they clone are server-owned and read-only, so
 *  the only reads a client does are `range` (the merged calendar) and the feed list. */
export function calendarApi(core: CoreBridge) {
  return {
    feeds: {
      list: () => core.invoke<CalendarFeed[]>("calendar.feeds.list"),
      create: (input: CreateFeedInput) => core.invoke<CalendarFeed>("calendar.feeds.create", input),
      update: (id: string, fields: UpdateFeedInput) =>
        core.invoke<CalendarFeed>("calendar.feeds.update", { id, ...fields }),
      remove: (id: string) => core.invoke<{ ok: boolean }>("calendar.feeds.delete", { id }),
    },
    /** The merged, read-only calendar for a half-open window: feed events, due tasks, and
     *  dated notes, sorted by start. `from`/`to` are ISO instants (the visible day/week). */
    range: (from: string, to: string) => core.invoke<CalendarItem[]>("calendar.range", { from, to }),
    /** Force the server to re-fetch this account's ICS feeds now, then pull the results
     *  (the calendar view's manual refresh). `synced` is false when running local-only. */
    refresh: () => core.invoke<{ ok: boolean; synced: boolean }>("calendar.refresh"),
  };
}

export type CalendarApi = ReturnType<typeof calendarApi>;
