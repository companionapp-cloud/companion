// Mobile SyncNotifier (PLAN §7.5), built on react-native-sse — an EventSource
// polyfill that, unlike the platform EventSource, can send an Authorization header.
// Following the createNativeBridge pattern, the concrete `react-native-sse` and
// `AppState` are *injected* by the mobile shell so core-bridge itself carries no
// react-native dependency (and typechecks without RN types).

import type { SyncNotifier } from "./notifier";

/** The subset of react-native-sse's EventSource we use. `change` is our server's
 * named event; react-native-sse dispatches named events only to listeners registered
 * for that exact type (not to `message`), so we must listen for `change` explicitly. */
export interface RNEventSource {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "change", listener: (event: { data: string | null }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeAllEventListeners(): void;
  close(): void;
}

export interface RNEventSourceCtor {
  new (
    url: string,
    options: { headers?: Record<string, string>; pollingInterval?: number },
  ): RNEventSource;
}

export interface RNAppStateSubscription {
  remove(): void;
}

/** The subset of react-native's AppState we use (foreground/background lifecycle). */
export interface RNAppState {
  currentState: string;
  addEventListener(type: "change", listener: (state: string) => void): RNAppStateSubscription;
}

export interface NativeSyncNotifierDeps {
  EventSource: RNEventSourceCtor;
  appState: RNAppState;
}

/**
 * createNativeSyncNotifier keeps the stream open only in the foreground: iOS/Android
 * would sever the socket on background anyway, so we close on background and reopen on
 * foreground (which, like any (re)connect, triggers a catch-up sync). react-native-sse
 * handles its own reconnect backoff while foregrounded.
 */
export function createNativeSyncNotifier({ EventSource, appState }: NativeSyncNotifierDeps): SyncNotifier {
  const listeners = new Set<() => void>();
  let current: { baseUrl: string; token: string } | null = null;
  let es: RNEventSource | null = null;
  let appStateSub: RNAppStateSubscription | null = null;

  const emit = () => {
    for (const cb of listeners) cb();
  };

  const closeStream = () => {
    if (es) {
      es.removeAllEventListeners();
      es.close();
      es = null;
    }
  };

  const openStream = () => {
    if (!current) return;
    closeStream();
    const { baseUrl, token } = current;
    const source = new EventSource(`${trimSlash(baseUrl)}/v1/sync/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    es = source;
    // (re)connect and each server `change` both mean "sync now" (PLAN §7.5). The
    // server tags every notification `event: change`, so we listen for that named
    // event — a `message` listener would never fire.
    source.addEventListener("open", () => emit());
    source.addEventListener("change", () => emit());
    // Errors are left to react-native-sse's built-in reconnect; nothing to do here.
    source.addEventListener("error", () => {});
  };

  const onAppStateChange = (state: string) => {
    if (!current) return;
    if (state === "active") {
      openStream();
    } else {
      closeStream(); // backgrounded: OS kills the socket; reopen on next foreground
    }
  };

  return {
    connect(baseUrl, token) {
      current = { baseUrl, token };
      if (!appStateSub) {
        appStateSub = appState.addEventListener("change", onAppStateChange);
      }
      if (appState.currentState === "active") openStream();
    },
    disconnect() {
      current = null;
      closeStream();
      if (appStateSub) {
        appStateSub.remove();
        appStateSub = null;
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
