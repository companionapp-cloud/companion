import { detectIos, iosSupportsWebPush } from "./iosInstall";

// Web Push on the web shell (PLAN §6.4). The sync server pushes each task reminder to every browser
// that subscribed, so reminders arrive while the app is closed — the only way an installed web app
// on iOS can be reminded at all. The web shell hands over its service worker registration (the
// subscription hangs off it); shells without one (desktop, native mobile) schedule their own
// notifications and never see any of this.

export interface WebPushHost {
  registration: ServiceWorkerRegistration;
}

let host: WebPushHost | null = null;

/** The web shell registers its service worker here at startup. */
export function setWebPushHost(next: WebPushHost | null): void {
  host = next;
}

export function webPushHost(): WebPushHost | null {
  return host;
}

/** Whether this device can get pushed reminders, and if not, why. */
export type PushSupport =
  /** The browser can subscribe right now. */
  | "supported"
  /** iOS/iPadOS 16.4+ in a browser tab: only a Home Screen web app has the Push API. */
  | "install-first"
  /** iOS/iPadOS before 16.4: no Web Push at all. */
  | "ios-outdated"
  /** No Push API here, or not the web shell. */
  | "unsupported";

export function pushSupport(): PushSupport {
  const ios = detectIos();
  if (ios && !ios.standalone) return iosSupportsWebPush(ios) ? "install-first" : "ios-outdated";
  if (!host || typeof window === "undefined" || !("PushManager" in window) || typeof Notification === "undefined") {
    return ios && !iosSupportsWebPush(ios) ? "ios-outdated" : "unsupported";
  }
  return "supported";
}

/** An authenticated JSON call to the connected sync server (SyncController.request). */
export type ServerRequest = <T = unknown>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

// --- who shows a due reminder ------------------------------------------------------------------

let delivering = false;

/** Whether this device is registered with the sync server for pushed reminders. While it is, the
 *  server delivers every reminder here, so the page's own local notifications stop: both would
 *  otherwise show each fire — and iOS ignores `tag`, stacking the two instead of letting one
 *  replace the other. */
export function setPushDelivering(on: boolean): void {
  delivering = on;
}

export function pushDelivering(): boolean {
  return delivering;
}

// --- which account this device is registered for -----------------------------------------------

const RECORD_KEY = "companion.push";

/** What this device registered, so a later launch can tell "on for this account" from "left over
 *  from a previous one", and notice when the browser rotated the endpoint. */
export interface PushRecord {
  endpoint: string;
  baseUrl: string;
  email: string;
  /** When the server last confirmed the registration (epoch ms). */
  registeredAt: number;
}

export function loadPushRecord(): PushRecord | null {
  try {
    const raw = globalThis.localStorage?.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as PushRecord) : null;
  } catch {
    return null;
  }
}

export function savePushRecord(record: PushRecord | null): void {
  try {
    if (record) globalThis.localStorage?.setItem(RECORD_KEY, JSON.stringify(record));
    else globalThis.localStorage?.removeItem(RECORD_KEY);
  } catch {
    /* storage unavailable: re-registered next launch */
  }
}

/** Whether a saved registration is this account's: the server confirmed it for this sync
 *  server and email. */
export function registeredFor(record: PushRecord | null, baseUrl: string | null, email: string | null): boolean {
  return !!record && !!baseUrl && record.baseUrl === baseUrl && record.email === email;
}

// --- subscribing -------------------------------------------------------------------------------

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!host) return null;
  try {
    return await host.registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** The server's VAPID public key, which every subscription is made with. */
export async function fetchServerKey(request: ServerRequest): Promise<Uint8Array<ArrayBuffer>> {
  const { publicKey } = await request<{ publicKey: string }>("GET", "/v1/push/config");
  return base64UrlBytes(publicKey);
}

/** Subscribe this browser. Call it synchronously from a tap when permission hasn't been granted
 *  yet: iOS only asks — and only lets a web app subscribe — from the gesture's own handler. */
export function subscribeWith(key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  if (!host) return Promise.reject(new Error("Push notifications aren't available here."));
  return host.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** Register a subscription with the server for the signed-in account and this device. */
export async function registerSubscription(request: ServerRequest, deviceId: string, sub: PushSubscription): Promise<void> {
  await request("POST", "/v1/push/subscribe", { deviceId, subscription: sub.toJSON() });
}

/** Subscribe (reusing a subscription made with the same key, replacing one made with another) and
 *  register, outside any gesture — for a launch that finds permission already granted. */
export async function subscribeAndRegister(request: ServerRequest, deviceId: string, key?: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  if (!host) throw new Error("Push notifications aren't available here.");
  key ??= await fetchServerKey(request);
  let sub = await host.registration.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await subscribeWith(key);
  await registerSubscription(request, deviceId, sub);
  return sub;
}

/** Stop this browser's pushes: tell the server (best-effort) and drop the subscription itself, which
 *  the push service then reports gone should the server still try it. */
export async function unsubscribe(request: ServerRequest | null): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  if (request) await request("POST", "/v1/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether a subscription was made with this server key (it's bound to one for life). */
export function subscribedWith(sub: PushSubscription, key: Uint8Array): boolean {
  return sameBytes(sub.options.applicationServerKey, key);
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((v, i) => v === b[i]);
}
