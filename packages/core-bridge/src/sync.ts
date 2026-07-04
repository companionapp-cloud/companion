import type { CoreBridge } from "./types";

/** Typed wrappers over the sync.* core methods. The shell configures the server
 * endpoint + token (from auth), then triggers a push→pull cycle. */
export function syncApi(core: CoreBridge) {
  return {
    configure: (baseUrl: string, token: string) =>
      core.invoke<{ ok: boolean }>("sync.configure", { baseUrl, token }),
    run: () => core.invoke<{ ok: boolean }>("sync.run"),
  };
}

export type SyncApi = ReturnType<typeof syncApi>;
