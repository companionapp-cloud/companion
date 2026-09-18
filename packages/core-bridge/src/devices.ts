import type { CoreBridge } from "./types";

/** A device on the account (mirrors the bridge's device view, PLAN-agents.md §2.2). */
export interface Device {
  id: string;
  name: string;
  platform: string;
  /** Desktops can host local agents; phones and browsers cannot. */
  canHost: boolean;
  online: boolean;
  lastSeenAt?: string | null;
  isThis: boolean;
}

/** Payload of a `devices.presence` event: another device came online or went offline. */
export interface DevicePresenceEvent {
  deviceId: string;
  online: boolean;
  lastSeenAt?: string;
}

/** Typed wrappers over the devices.* core methods. */
export function devicesApi(core: CoreBridge) {
  return {
    this: () => core.invoke<Device>("devices.this"),
    rename: (name: string) => core.invoke<Device>("devices.rename", { name }),
    list: () => core.invoke<Device[]>("devices.list"),
    onPresence: (cb: (e: DevicePresenceEvent) => void) => core.on("devices.presence", (p) => cb(p as DevicePresenceEvent)),
  };
}

export type DevicesApi = ReturnType<typeof devicesApi>;
