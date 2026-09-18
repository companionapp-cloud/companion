import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AddCalendarAccountInput,
  CalendarAccount,
  CalendarConflict,
  CalendarFeed,
  CalendarItem,
  CreateEventInput,
  CreateFeedInput,
  UpdateEventInput,
  UpdateFeedInput,
} from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { startOAuthFlow, type OAuthFlowHandle } from "./oauthFlow";
import { useSync } from "./SyncProvider";

/** The week-grid's transient view state, kept on the (always-mounted) provider so it
 *  survives the screen unmounting when you navigate away and back (PLAN §6.7). `anchorMs`
 *  is a day within the visible week; `scrollY` is the hour-grid scroll offset. */
export interface CalendarViewState {
  anchorMs: number | null;
  scrollY: number;
}

export interface CalendarStore {
  /** User-authored ICS feeds. */
  feeds: CalendarFeed[];
  loading: boolean;
  /** Bumps whenever calendar data changes (a local feed edit or a sync pull applied server
   *  events). Screens depend on it so their windowed `range` query re-runs. */
  revision: number;
  /** Fetch the merged, read-only calendar for a window — feed events, due tasks, dated
   *  notes — sorted by start. The window differs per screen (a day agenda vs a week grid),
   *  so this is a thin call rather than cached list state. */
  range: (from: string, to: string) => Promise<CalendarItem[]>;
  /** Force the server to re-fetch the ICS feeds now, then pull — the manual refresh button.
   *  Resolves once done; `data.changed`/`calendar.changed` then bump `revision`. */
  refresh: () => Promise<void>;
  createFeed: (input: CreateFeedInput) => Promise<CalendarFeed>;
  updateFeed: (id: string, fields: UpdateFeedInput) => Promise<CalendarFeed>;
  removeFeed: (id: string) => Promise<void>;
  /** CalDAV logins (PLAN-caldav.md). Their calendars also appear in `feeds`, with kind "caldav". */
  accounts: CalendarAccount[];
  /** True where this client can talk to a CalDAV server (desktop, mobile). On web, accounts
   *  added elsewhere are listed and their events editable, but none can be added. */
  canAddAccounts: boolean;
  /** True where a Google account can be connected: a native client whose build carries a Google
   *  OAuth client id. */
  canAddGoogle: boolean;
  /** Connect a Google account (or, with `accountId`, reconnect one whose access lapsed). Opens
   *  Google's sign-in in the browser; `result` settles when the user finishes or gives up. */
  connectGoogle: (accountId?: string) => OAuthFlowHandle<CalendarAccount>;
  /** Calendars events can be created in: CalDAV, and not read-only. */
  writableFeeds: CalendarFeed[];
  /** Verifies the login with the provider before saving; rejects with a readable message. */
  addAccount: (input: AddCalendarAccountInput) => Promise<CalendarAccount>;
  rescanAccount: (id: string) => Promise<void>;
  /** Forgets the account here and on every device. Nothing is deleted at the provider. */
  removeAccount: (id: string) => Promise<void>;
  /** Event edits land locally at once (so they render immediately, marked pending) and are then
   *  sent on their way in the background. */
  createEvent: (input: CreateEventInput) => Promise<void>;
  updateEvent: (id: string, fields: UpdateEventInput) => Promise<void>;
  removeEvent: (id: string, scope?: "occurrence" | "series") => Promise<void>;
  /** Edits the provider refused because the event had changed there; its copy was kept.
   *  Shown once, then dismissed. */
  conflicts: CalendarConflict[];
  dismissConflicts: () => void;
  /** Read the persisted week-grid view state (visible week + scroll). */
  getViewState: () => CalendarViewState;
  /** Merge into the persisted view state (visible week + scroll). */
  setViewState: (patch: Partial<CalendarViewState>) => void;
}

const CalendarCtx = createContext<CalendarStore | null>(null);

/** Owns the calendar feed list and exposes the merged `range` query (PLAN §6.7). Refreshes
 *  the feed list on `calendar.changed` (local feed edits) and `data.changed` (a sync pull
 *  applied server-cloned events), bumping `revision` so windowed views re-query. Triggers a
 *  sync after every local feed mutation — mirrors TasksProvider/NotesProvider. */
export function CalendarProvider({ children }: { children: ReactNode }) {
  const { core, calendar, oauth } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [canAddAccounts, setCanAddAccounts] = useState(false);
  const [canAddGoogle, setCanAddGoogle] = useState(false);
  const [conflicts, setConflicts] = useState<CalendarConflict[]>([]);

  const refreshFeeds = useCallback(async () => {
    // Accounts are tolerated missing: a shell running an older core (a stale wasm or native
    // binary beside a newer bundle) must still show its subscriptions.
    const [list, accts] = await Promise.all([calendar.feeds.list(), calendar.accounts.list().catch(() => [])]);
    setFeeds(list);
    setAccounts(accts);
    setLoading(false);
    // Re-read with every refresh rather than once: a shell configures Google sign-in at startup
    // through the same async bridge, so the first read can land before that has.
    void calendar
      .capabilities()
      .then((c) => {
        setCanAddAccounts(c.caldav);
        setCanAddGoogle(!!c.google);
      })
      .catch(() => undefined);
  }, [calendar]);

  useEffect(() => {
    void refreshFeeds();
    const bump = () => setRevision((r) => r + 1);
    const offCal = core.on("calendar.changed", () => {
      void refreshFeeds();
      bump();
    });
    // A sync pull that applied server events fires data.changed; re-query windows (no feed
    // list change needed, but the event clone did change).
    const offData = core.on("data.changed", bump);
    // The provider refused an edit because the event changed there first (PLAN-caldav.md §0).
    const offConflict = core.on("calendar.conflict", (payload: unknown) => {
      const list = (payload as { conflicts?: CalendarConflict[] } | null)?.conflicts ?? [];
      if (list.length > 0) setConflicts((prev) => [...prev, ...list]);
    });
    return () => {
      offCal();
      offData();
      offConflict();
    };
  }, [core, refreshFeeds]);

  // Week-grid view state survives the screen unmounting on navigation (this provider stays
  // mounted). A ref, not state — nothing here should trigger a re-render.
  const viewState = useRef<CalendarViewState>({ anchorMs: null, scrollY: 0 });
  const getViewState = useCallback(() => viewState.current, []);
  const setViewState = useCallback((patch: Partial<CalendarViewState>) => {
    viewState.current = { ...viewState.current, ...patch };
  }, []);

  const range = useCallback((from: string, to: string) => calendar.range(from, to), [calendar]);

  // Manual refresh: re-fetch the ICS feeds on the server, then pull. The core emits
  // calendar.changed / data.changed on completion, which re-runs the feed list + windows.
  const refresh = useCallback(async () => {
    await calendar.refresh();
  }, [calendar]);

  const createFeed = useCallback(
    async (input: CreateFeedInput) => {
      const feed = await calendar.feeds.create(input);
      setFeeds((prev) => [...prev, feed]);
      syncTrigger();
      return feed;
    },
    [calendar, syncTrigger],
  );

  const updateFeed = useCallback(
    async (id: string, fields: UpdateFeedInput) => {
      const updated = await calendar.feeds.update(id, fields);
      setFeeds((prev) => prev.map((f) => (f.id === id ? updated : f)));
      syncTrigger();
      return updated;
    },
    [calendar, syncTrigger],
  );

  const removeFeed = useCallback(
    async (id: string) => {
      await calendar.feeds.remove(id);
      setFeeds((prev) => prev.filter((f) => f.id !== id));
      syncTrigger();
    },
    [calendar, syncTrigger],
  );

  const addAccount = useCallback(
    async (input: AddCalendarAccountInput) => {
      const account = await calendar.accounts.add(input);
      await refreshFeeds();
      // First pull, so the new calendars fill in without waiting for the next refresh.
      void calendar.refresh().catch(() => undefined);
      return account;
    },
    [calendar, refreshFeeds],
  );

  const connectGoogle = useCallback(
    (accountId?: string) => {
      const flow = startOAuthFlow<CalendarAccount>(core, oauth, "google", "calendar", accountId ? { accountId } : undefined);
      const result = flow.result.then(async (account) => {
        await refreshFeeds();
        void calendar.refresh().catch(() => undefined);
        return account;
      });
      return { result, cancel: flow.cancel };
    },
    [core, oauth, calendar, refreshFeeds],
  );

  const rescanAccount = useCallback(
    async (id: string) => {
      await calendar.accounts.rescan(id);
      await refreshFeeds();
      void calendar.refresh().catch(() => undefined);
    },
    [calendar, refreshFeeds],
  );

  const removeAccount = useCallback(
    async (id: string) => {
      await calendar.accounts.remove(id);
      await refreshFeeds();
      syncTrigger();
    },
    [calendar, refreshFeeds, syncTrigger],
  );

  // The edit itself is local and instant; `push` then carries it to the provider (native) and
  // into sync (everywhere). A failed push is not an error for the user — the change stays
  // pending and goes out on the next attempt.
  const pushSoon = useCallback(() => {
    void calendar.push().catch(() => undefined);
  }, [calendar]);

  const createEvent = useCallback(
    async (input: CreateEventInput) => {
      await calendar.events.create(input);
      pushSoon();
    },
    [calendar, pushSoon],
  );

  const updateEvent = useCallback(
    async (id: string, fields: UpdateEventInput) => {
      await calendar.events.update(id, fields);
      pushSoon();
    },
    [calendar, pushSoon],
  );

  const removeEvent = useCallback(
    async (id: string, scope: "occurrence" | "series" = "occurrence") => {
      await calendar.events.remove(id, scope);
      pushSoon();
    },
    [calendar, pushSoon],
  );

  const dismissConflicts = useCallback(() => setConflicts([]), []);

  const writableFeeds = useMemo(() => feeds.filter((f) => f.kind === "caldav" && !f.readOnly), [feeds]);

  const value = useMemo<CalendarStore>(
    () => ({
      feeds,
      loading,
      revision,
      range,
      refresh,
      createFeed,
      updateFeed,
      removeFeed,
      accounts,
      canAddAccounts,
      canAddGoogle,
      connectGoogle,
      writableFeeds,
      addAccount,
      rescanAccount,
      removeAccount,
      createEvent,
      updateEvent,
      removeEvent,
      conflicts,
      dismissConflicts,
      getViewState,
      setViewState,
    }),
    [
      feeds,
      loading,
      revision,
      range,
      refresh,
      createFeed,
      updateFeed,
      removeFeed,
      accounts,
      canAddAccounts,
      canAddGoogle,
      connectGoogle,
      writableFeeds,
      addAccount,
      rescanAccount,
      removeAccount,
      createEvent,
      updateEvent,
      removeEvent,
      conflicts,
      dismissConflicts,
      getViewState,
      setViewState,
    ],
  );

  return <CalendarCtx.Provider value={value}>{children}</CalendarCtx.Provider>;
}

export function useCalendar(): CalendarStore {
  const v = useContext(CalendarCtx);
  if (!v) throw new Error("useCalendar must be used within a CalendarProvider");
  return v;
}
