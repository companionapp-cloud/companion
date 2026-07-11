import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CalendarFeed, CalendarItem, CreateFeedInput, UpdateFeedInput } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
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
  const { core, calendar } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  const refreshFeeds = useCallback(async () => {
    const list = await calendar.feeds.list();
    setFeeds(list);
    setLoading(false);
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
    return () => {
      offCal();
      offData();
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

  const value = useMemo<CalendarStore>(
    () => ({ feeds, loading, revision, range, refresh, createFeed, updateFeed, removeFeed, getViewState, setViewState }),
    [feeds, loading, revision, range, refresh, createFeed, updateFeed, removeFeed, getViewState, setViewState],
  );

  return <CalendarCtx.Provider value={value}>{children}</CalendarCtx.Provider>;
}

export function useCalendar(): CalendarStore {
  const v = useContext(CalendarCtx);
  if (!v) throw new Error("useCalendar must be used within a CalendarProvider");
  return v;
}
