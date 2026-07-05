// SyncNotifier — the realtime "sync now" poke (PLAN §7.5). It holds one long-lived
// SSE stream to the server's GET /v1/sync/events and fires onChange whenever the
// server announces a change *and* on every (re)connect (a reconnect may have missed
// events, so the client resyncs to catch up). It deliberately lives in core-bridge,
// not the Go core: it is connection-lifecycle glue tied to app foreground/visibility,
// while the core's job stays "run a sync cycle when poked".
//
// Two implementations share this interface:
//   - createSyncNotifier (below): web + desktop, using fetch + ReadableStream. Native
//     EventSource can't send an Authorization header, and tokens-in-query-strings leak
//     bearer tokens into server logs — so we stream the fetch body by hand.
//   - createNativeSyncNotifier (notifier.native.ts): mobile, using react-native-sse
//     (an EventSource polyfill that *does* support custom headers), injected by the
//     shell so core-bridge keeps no react-native dependency.

export interface SyncNotifier {
  /** Open (or reopen) the stream against a server endpoint + bearer token. Calling
   * connect again — e.g. after a silent token refresh — replaces the connection with
   * one using the new token. */
  connect(baseUrl: string, token: string): void;
  /** Close the stream and detach lifecycle listeners. Idempotent. */
  disconnect(): void;
  /** Fires on each server `change` event and on every (re)connect. The shell wires
   * this to a debounced sync.run. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
}

/** ~5s reconnect backoff, matching the server's `retry:` hint. */
const RECONNECT_MS = 5000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** An SSE frame carries data when it has at least one `data:` line; heartbeat frames
 * are comments (`: ping`) with none. We treat any data-bearing frame as a change. */
function frameIsChange(frame: string): boolean {
  return frame.split("\n").some((line) => line.startsWith("data:"));
}

/**
 * createSyncNotifier is the web + desktop implementation. It streams the SSE response
 * body with fetch (so it can send `Authorization`), reconnecting on drop, and — where
 * a document exists — re-opens the stream when the tab becomes visible again. Every
 * successful open emits a change so the shell runs a catch-up sync.
 */
export function createSyncNotifier(): SyncNotifier {
  const listeners = new Set<() => void>();
  let current: { baseUrl: string; token: string } | null = null;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHandler: (() => void) | null = null;

  const emit = () => {
    for (const cb of listeners) cb();
  };

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  // Reconnect only if this attempt is still the active one (a newer connect() or a
  // disconnect() swaps `controller`, orphaning older loops).
  const scheduleReconnect = (ac: AbortController) => {
    if (current === null || controller !== ac) return;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      if (current && controller === ac) void open();
    }, RECONNECT_MS);
  };

  async function open() {
    if (!current) return;
    clearReconnect();
    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    const { baseUrl, token } = current;

    try {
      const res = await fetch(`${trimSlash(baseUrl)}/v1/sync/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        scheduleReconnect(ac);
        return;
      }
      // Connected: catch up on anything missed while disconnected (PLAN §7.5).
      emit();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        // Frames are separated by a blank line.
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (frameIsChange(frame)) emit();
        }
      }
      scheduleReconnect(ac); // stream ended cleanly; reopen
    } catch {
      if (!ac.signal.aborted) scheduleReconnect(ac);
    }
  }

  return {
    connect(baseUrl, token) {
      current = { baseUrl, token };
      if (!visibilityHandler && typeof document !== "undefined") {
        visibilityHandler = () => {
          if (document.visibilityState === "visible") void open();
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }
      void open();
    },
    disconnect() {
      current = null;
      clearReconnect();
      controller?.abort();
      controller = null;
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
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
