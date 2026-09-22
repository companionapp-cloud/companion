import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { devicesApi } from "@companion/core-bridge";
import { useCore } from "../CoreContext";
import { useSync } from "../SyncProvider";
import { clearPlanCache } from "./planCache";
import {
  currentSubscription,
  fetchServerKey,
  loadPushRecord,
  pushSupport,
  registerSubscription,
  registeredFor,
  savePushRecord,
  setPushDelivering,
  subscribeAndRegister,
  subscribeWith,
  subscribedWith,
  unsubscribe,
  webPushHost,
  type PushSupport,
} from "./webPush";

/** Push state for this device, shared by Settings › Notifications and the prompt banners. */
export interface WebPushController {
  support: PushSupport;
  /** The browser's notification permission ("unsupported" without the Notification API). */
  permission: NotificationPermission | "unsupported";
  /** Reminders are pushed to this device for the signed-in account. */
  enabled: boolean;
  busy: boolean;
  error: string | null;
  /** Ask for permission and subscribe. Call straight from a tap: iOS only shows the permission
   *  prompt in response to one. */
  enable: () => void;
  disable: () => Promise<void>;
  /** Send a test notification to this device through the server. */
  sendTest: () => Promise<void>;
}

const INERT: WebPushController = {
  support: "unsupported",
  permission: "unsupported",
  enabled: false,
  busy: false,
  error: null,
  enable: () => {},
  disable: async () => {},
  sendTest: async () => {},
};

const WebPushCtx = createContext<WebPushController>(INERT);

/** How often a registration is re-confirmed with the server, healing a server that lost it. */
const REREGISTER_MS = 24 * 60 * 60 * 1000;

function currentPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Owns this device's reminder-push subscription (PLAN §6.4, web push): turning it on and off,
 *  and on every launch keeping it true to the signed-in account — re-registering an endpoint the
 *  browser rotated, and dropping one left from an account that has since signed out. Inert on
 *  shells that never registered a service worker (desktop, native mobile). */
export function WebPushProvider({ children }: { children: ReactNode }) {
  const { core } = useCore();
  const sync = useSync();
  const { connected, baseUrl, email, request } = sync;
  const devices = useMemo(() => devicesApi(core), [core]);
  const support = useMemo(pushSupport, []);
  const [permission, setPermission] = useState(currentPermission);
  const active = support === "supported" && !!webPushHost();
  // Start from the saved registration rather than off, so a launch never shows local notifications
  // for a device the server is already pushing to while the launch check is still in flight.
  const [enabled, setEnabled] = useState(
    () => active && currentPermission() === "granted" && registeredFor(loadPushRecord(), baseUrl, email),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's key, fetched ahead of time so a tap can subscribe without awaiting anything first.
  const serverKey = useRef<Uint8Array<ArrayBuffer> | null>(null);
  useEffect(() => {
    serverKey.current = null;
    if (!active || !connected) return;
    let cancelled = false;
    fetchServerKey(request)
      .then((key) => {
        if (!cancelled) serverKey.current = key;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, connected, baseUrl, email, request]);

  // Registered with the sync server: it pushes every reminder here, so the page's own local
  // notifications stop for this device — for as long as the registration stands.
  useEffect(() => {
    setPushDelivering(enabled);
    return () => setPushDelivering(false);
  }, [enabled]);

  const remember = useCallback(
    (sub: PushSubscription) => {
      if (!baseUrl || !email) return;
      savePushRecord({ endpoint: sub.endpoint, baseUrl, email, registeredAt: Date.now() });
      setEnabled(true);
    },
    [baseUrl, email],
  );

  const register = useCallback(async () => {
    const device = await devices.this();
    remember(await subscribeAndRegister(request, device.id, serverKey.current ?? undefined));
  }, [devices, request, remember]);

  // Keep the subscription true to the account on launch, on sign-in/out, and when the service
  // worker reports the browser rotated it. A change arriving mid-run (signing out while a check is
  // in flight) runs it again with the latest state once the current run ends.
  const reconciling = useRef(false);
  const again = useRef(false);
  const latest = useRef<() => Promise<void>>(async () => {});
  const reconcile = useCallback(async () => {
    if (!active) return;
    if (reconciling.current) {
      again.current = true;
      return;
    }
    reconciling.current = true;
    try {
      const perm = currentPermission();
      setPermission(perm);
      const record = loadPushRecord();
      const sub = await currentSubscription();
      const sameAccount = connected && registeredFor(record, baseUrl, email);
      if (!record) {
        setEnabled(false);
        return;
      }
      if (!sameAccount || perm !== "granted") {
        // Signed out (or into another account), or permission withdrawn: this device's pushes
        // belonged to the old session. Dropping the subscription makes the push service report it
        // gone, and the server forgets it on its next reminder.
        await unsubscribe(null);
        savePushRecord(null);
        void clearPlanCache();
        setEnabled(false);
        return;
      }
      // A subscription is bound to the server key it was made with; a server whose key changed
      // can't reach it, so it's replaced now rather than at the next daily re-confirmation.
      serverKey.current ??= await fetchServerKey(request);
      const current = !!sub && sub.endpoint === record.endpoint && subscribedWith(sub, serverKey.current);
      if (current && Date.now() - record.registeredAt < REREGISTER_MS) {
        setEnabled(true);
        return;
      }
      await register(); // rotated, lost, keyed to an old server key, or due a re-confirmation
    } catch (e) {
      if (e instanceof DOMException) {
        // The browser itself refused to subscribe again (some only do from a tap): push is off
        // until the user turns it back on.
        savePushRecord(null);
        setEnabled(false);
      } else {
        // Offline or the server is unreachable: keep what we believe and try again next launch.
        setEnabled(!!loadPushRecord());
      }
    } finally {
      reconciling.current = false;
      if (again.current) {
        again.current = false;
        void latest.current();
      }
    }
  }, [active, connected, baseUrl, email, request, register]);
  latest.current = reconcile;

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "push-subscription-changed") void reconcile();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [active, reconcile]);

  const enable = useCallback(() => {
    if (!active || typeof Notification === "undefined") return;
    setError(null);
    if (!connected) {
      setError("Sign in to sync first: reminders are pushed by your sync server.");
      return;
    }
    // Subscribe right here in the tap, before anything is awaited: iOS only shows the permission
    // prompt — and only lets a web app subscribe — from the gesture's own handler. Subscribing asks
    // for permission itself. Without the key yet (still loading), ask for permission here instead
    // and subscribe once it has arrived.
    const key = serverKey.current;
    // Settled into a value at once, so a refusal isn't an unhandled rejection while we await below.
    const subscribing = key
      ? subscribeWith(key).then(
          (sub) => ({ sub, error: null }),
          (error: unknown) => ({ sub: null, error }),
        )
      : null;
    const asking = subscribing ? null : Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
    setBusy(true);
    void (async () => {
      try {
        if (asking && (await asking) !== "granted") return;
        const device = await devices.this();
        let sub: PushSubscription | null = null;
        if (subscribing) {
          const result = await subscribing;
          // A subscription made with another key (the server's changed) blocks a new one; with
          // permission already granted, replacing it needs no gesture.
          const staleKey = result.error instanceof DOMException && result.error.name === "InvalidStateError";
          if (result.error && !staleKey) throw result.error;
          sub = result.sub;
          if (sub) await registerSubscription(request, device.id, sub);
        }
        sub ??= await subscribeAndRegister(request, device.id, key ?? undefined);
        remember(sub);
      } catch (e) {
        // A refused prompt rejects the subscription too; the UI shows "blocked" from `permission`.
        if (currentPermission() !== "denied") setError(`Couldn’t turn on notifications (${e instanceof Error ? e.message : String(e)}).`);
      } finally {
        setPermission(currentPermission());
        setBusy(false);
      }
    })();
  }, [active, connected, devices, request, remember]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await unsubscribe(connected ? request : null);
    } finally {
      savePushRecord(null);
      void clearPlanCache();
      setEnabled(false);
      setBusy(false);
    }
  }, [connected, request]);

  const sendTest = useCallback(async () => {
    setError(null);
    const sub = await currentSubscription();
    if (!sub) {
      setEnabled(false);
      setError("This device isn't subscribed any more. Turn notifications on again.");
      return;
    }
    setBusy(true);
    try {
      await request("POST", "/v1/push/test", { endpoint: sub.endpoint });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [request]);

  const value = useMemo<WebPushController>(
    () => ({ support, permission, enabled, busy, error, enable, disable, sendTest }),
    [support, permission, enabled, busy, error, enable, disable, sendTest],
  );
  return <WebPushCtx.Provider value={value}>{children}</WebPushCtx.Provider>;
}

export function useWebPush(): WebPushController {
  return useContext(WebPushCtx);
}
