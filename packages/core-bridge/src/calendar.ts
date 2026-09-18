import type { CalendarAccount, CalendarConflict, CalendarFeed, CalendarItem, CoreBridge } from "./types";

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

export interface AddCalendarAccountInput {
  /** Display name; defaults to the server's host name. */
  name?: string;
  /** e.g. "caldav.icloud.com" — https is assumed. */
  serverUrl: string;
  username: string;
  /** An app-specific password on iCloud and Fastmail. Sent to the core only, never stored by the UI. */
  password: string;
}

/** How an event repeats, as far as Companion can author it: every N days/weeks/months/years from
 *  its own start, optionally until a last day. */
export interface CalendarRepeat {
  freq: "none" | "daily" | "weekly" | "monthly" | "yearly";
  /** Every N units; 1 when omitted. */
  interval?: number;
  /** Last day it may occur on — a date marker (midnight UTC of that day), like all-day events. */
  until?: string | null;
  /** Read-only: the event's rule says more than that ("the last Friday", a count, several
   *  weekdays). It is preserved as is; it can be replaced with a simple rule, but not tweaked. */
  custom?: boolean;
}

/** The fields of a new event. For an all-day event `startsAt` is midnight UTC of the first day
 *  and `endsAt` midnight UTC of the day after the last — the same shape `range` returns. */
export interface CreateEventInput {
  feedId: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  repeat?: CalendarRepeat | null;
}

/** A partial edit; omitted fields are untouched, and "" clears location/description. */
export interface UpdateEventInput {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  /** Replaces the repeat rule; freq "none" removes it. For a repeating event every change here —
   *  times included — applies to the whole series, moved relative to the occurrence being edited. */
  repeat?: CalendarRepeat;
}

/** Typed wrappers over the calendar.* core methods (PLAN §6.7, PLAN-caldav.md). ICS feeds are
 *  read-only subscriptions; CalDAV accounts are two-way. Event edits only ever change local rows —
 *  they show at once and reach the provider on the next `push` (from this device if it is native,
 *  otherwise from one of the user's native devices, via sync). */
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
    /** Send pending event changes on their way — cheap enough to call after every edit. */
    push: () =>
      core.invoke<{ ok: boolean; synced: boolean; conflicts: CalendarConflict[] | null }>("calendar.push"),
    /** What this client can do. `caldav` is false on web, where accounts cannot be added
     *  (but events of accounts added elsewhere can still be edited). `google` additionally needs
     *  a Google OAuth client id in this build. */
    capabilities: () => core.invoke<{ caldav: boolean; google?: boolean }>("calendar.capabilities"),
    accounts: {
      list: () => core.invoke<CalendarAccount[]>("calendar.accounts.list"),
      /** Verifies the login against the server before saving anything. Native clients only. */
      add: (input: AddCalendarAccountInput) => core.invoke<CalendarAccount>("calendar.accounts.add", input),
      update: (id: string, fields: { name?: string; password?: string }) =>
        core.invoke<CalendarAccount>("calendar.accounts.update", { id, ...fields }),
      /** Look for calendars added on the provider since the account was set up. */
      rescan: (id: string) => core.invoke<CalendarAccount>("calendar.accounts.rescan", { id }),
      /** Forgets the account and its events on every device. Nothing is deleted at the provider. */
      remove: (id: string) => core.invoke<{ ok: boolean }>("calendar.accounts.remove", { id }),
    },
    events: {
      create: (input: CreateEventInput) =>
        core.invoke<{ ok: boolean; eventId: string }>("calendar.events.create", input),
      /** What the editor needs beyond `range`: the event's repeat rule (null for a one-off). */
      get: (id: string) => core.invoke<{ id: string; repeat: CalendarRepeat | null }>("calendar.events.get", { id }),
      /** `id` is the occurrence's `sourceId`. Edits to a repeating event apply to the series. */
      update: (id: string, fields: UpdateEventInput) =>
        core.invoke<{ ok: boolean }>("calendar.events.update", { id, ...fields }),
      /** For a repeating event, `scope` picks this occurrence (default) or the whole series. */
      remove: (id: string, scope: "occurrence" | "series" = "occurrence") =>
        core.invoke<{ ok: boolean }>("calendar.events.delete", { id, scope }),
    },
  };
}

export type CalendarApi = ReturnType<typeof calendarApi>;
