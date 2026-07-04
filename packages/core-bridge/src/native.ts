import type { CoreBridge } from "./types";

// Native (gomobile) bridge for iOS/Android. The core is bound via `gomobile bind`
// (core/cmd/mobile) into a local Expo module; that module's JS surface is injected
// here so this file has no Expo dependency and stays platform-agnostic.

/** The Expo module's method surface (wraps the bound Go Core.Invoke). */
export interface NativeCoreModule {
  /** Dispatch a core method; resolves to the JSON-encoded result string. */
  invoke(method: string, payloadJson: string): Promise<string>;
}

export interface NativeSubscription {
  remove(): void;
}

/** The Expo module's event emitter; fires for every core EventHandler.OnEvent. */
export interface NativeCoreEmitter {
  addListener(
    eventName: "onCoreEvent",
    listener: (event: { name: string; payload: string }) => void,
  ): NativeSubscription;
}

export interface NativeBridgeOptions {
  module: NativeCoreModule;
  emitter: NativeCoreEmitter;
}

/**
 * createNativeBridge adapts the Expo module (which wraps the gomobile-bound core)
 * to the shared CoreBridge. The mobile shell (apps/mobile) supplies the module +
 * emitter from `requireNativeModule` / its event emitter.
 */
export function createNativeBridge({ module, emitter }: NativeBridgeOptions): CoreBridge {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const subscription = emitter.addListener("onCoreEvent", ({ name, payload }) => {
    const set = listeners.get(name);
    if (!set) return;
    let parsed: unknown = null;
    try {
      parsed = payload ? JSON.parse(payload) : null;
    } catch {
      parsed = payload;
    }
    for (const cb of set) cb(parsed);
  });

  return {
    async invoke<T>(method: string, payload?: unknown): Promise<T> {
      const out = await module.invoke(method, JSON.stringify(payload ?? null));
      return (out ? JSON.parse(out) : null) as T;
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    close() {
      subscription.remove();
    },
  };
}
