import { requireOptionalNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';

// Thin JS wrapper over the iOS-only WatchBridge native module (WCSession). Uses the *optional*
// require so importing this on Android/web yields `null` instead of throwing — the exports then
// no-op, matching how the phone↔watch path is a no-op off iOS.

/** A message sent from the watch, e.g. `{ type: "createTask", title: "…" }`. */
export interface WatchMessage {
  type?: string;
  [key: string]: unknown;
}

interface WatchBridgeNativeModule {
  isSupported(): boolean;
  updateContext(payload: Record<string, unknown>): boolean;
  respond(requestId: string, response: Record<string, unknown>): void;
  addListener(event: 'onWatchMessage', listener: (message: WatchMessage) => void): EventSubscription;
}

const WatchBridge = requireOptionalNativeModule<WatchBridgeNativeModule>('WatchBridge');

/** True when WCSession is available (an iOS device that can pair a watch). */
export function isWatchBridgeAvailable(): boolean {
  return WatchBridge?.isSupported() ?? false;
}

/** Send the latest snapshot to the paired watch as WCSession application context. */
export function updateWatchContext(payload: Record<string, unknown>): boolean {
  return WatchBridge?.updateContext(payload) ?? false;
}

/** Subscribe to messages coming *from* the watch (task-create / parse / snapshot requests).
 *  No-op off iOS. */
export function addWatchMessageListener(
  listener: (message: WatchMessage) => void,
): EventSubscription | null {
  return WatchBridge?.addListener('onWatchMessage', listener) ?? null;
}

/** Reply to a reply-expecting watch message (its `requestId`). No-op off iOS. */
export function respondToWatch(requestId: string, response: Record<string, unknown>): void {
  WatchBridge?.respond(requestId, response);
}
