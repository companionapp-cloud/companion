import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NotificationFeedItem } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface NotificationsStore {
  /** The in-app feed: fires from the trailing window, newest first (PLAN §6.4). */
  items: NotificationFeedItem[];
  unreadCount: number;
  loading: boolean;
  /** Mark one item read (optimistic; the receipt syncs across devices). */
  markRead: (taskId: string, fireAt: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationsCtx = createContext<NotificationsStore | null>(null);

/** Owns the in-app notification feed behind the bell + notifications page (PLAN §6.4).
 *  The feed is derived in core from the live tasks; read receipts are synced rows. Refreshes
 *  on task changes, sync pulls, and local read-state changes — and, because the feed is a
 *  function of *time* as well as data, arms a timer for the next upcoming fire so a reminder
 *  that fires while the app is open surfaces in the bell the moment it happens. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { core, notify } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [items, setItems] = useState<NotificationFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const mutating = useRef(0); // suppress refresh clobber while an optimistic write is in flight

  const nextFire = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    const [feed, plan] = await Promise.all([notify.feed(), notify.plan(1)]);
    if (mutating.current === 0) {
      setItems(feed);
      setLoading(false);
    }
    // Re-arm the wake-up for the next fire inside the coming day; the refresh it triggers
    // re-arms in turn, so an open app tracks fires indefinitely.
    if (nextFire.current) clearTimeout(nextFire.current);
    nextFire.current = null;
    const upcoming = plan.find((n) => new Date(n.fireAt).getTime() > Date.now());
    if (upcoming) {
      const delay = new Date(upcoming.fireAt).getTime() - Date.now() + 1000;
      nextFire.current = setTimeout(() => void refresh(), delay);
    }
  }, [notify]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (mutating.current > 0) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 100);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offTasks = core.on("tasks.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    const offNotif = core.on("notifications.changed", scheduleRefresh);
    return () => {
      offTasks();
      offData();
      offNotif();
      if (debounce.current) clearTimeout(debounce.current);
      if (nextFire.current) clearTimeout(nextFire.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const markRead = useCallback(
    async (taskId: string, fireAt: string) => {
      // Optimistic: flip the item locally, then persist; the receipt pushes on next sync.
      setItems((prev) => prev.map((n) => (n.taskId === taskId && n.fireAt === fireAt ? { ...n, read: true } : n)));
      mutating.current += 1;
      try {
        await notify.markRead(taskId, fireAt);
      } finally {
        mutating.current -= 1;
      }
      syncTrigger();
    },
    [notify, syncTrigger],
  );

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
    mutating.current += 1;
    try {
      await notify.markAllRead();
    } finally {
      mutating.current -= 1;
    }
    syncTrigger();
  }, [notify, syncTrigger]);

  const value = useMemo<NotificationsStore>(
    () => ({
      items,
      unreadCount: items.reduce((n, i) => (i.read ? n : n + 1), 0),
      loading,
      markRead,
      markAllRead,
    }),
    [items, loading, markRead, markAllRead],
  );

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

export function useNotifications(): NotificationsStore {
  const v = useContext(NotificationsCtx);
  if (!v) throw new Error("useNotifications must be used within NotificationsProvider");
  return v;
}
