import type { CoreBridge, TrashEntityType, TrashItem } from "./types";

/** Typed wrappers over the trash.* core methods (PLAN §4.3). The Trash aggregates every
 *  trashable entity type, so callers pass an { entityType, id } ref to act on a row. */
export function trashApi(core: CoreBridge) {
  return {
    /** Every trashed entity, soonest-to-be-purged first. */
    list: () => core.invoke<TrashItem[]>("trash.list"),
    /** Pull an item back out of the Trash. */
    restore: (entityType: TrashEntityType, id: string) =>
      core.invoke<{ ok: boolean }>("trash.restore", { entityType, id }),
    /** Permanently delete an item now ("Delete forever"). */
    purge: (entityType: TrashEntityType, id: string) =>
      core.invoke<{ ok: boolean }>("trash.purge", { entityType, id }),
  };
}

export type TrashApi = ReturnType<typeof trashApi>;
