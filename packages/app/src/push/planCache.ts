import type { TaskNotification } from "@companion/core-bridge";

// The reminder plan, cached where the service worker can read it (PLAN §6.4, web push). On an
// end-to-end encrypted account a pushed reminder carries no title — the server can't read one — so
// the worker looks the fire up here, in the plan this device last computed from its own decrypted
// data, and words the notification exactly as the app would have. This exposes nothing new: the
// local database those titles come from lives in this origin's IndexedDB as well.
//
// Keep these names in step with apps/web/public/sw.js, which reads the store.

const PLAN_DB = "companion-push";
const PLAN_STORE = "plan";
/** Fires stay cached this long after they pass, so a push delivered a little late (the device was
 *  offline, or the app re-planned just after the instant) still finds its wording. */
const KEEP_PAST_MS = 24 * 60 * 60 * 1000;

interface CachedFire {
  key: string;
  taskId: string;
  fireAt: number;
  title: string;
  body: string;
}

/** A fire's cache key: the task and the instant, as epoch ms so ISO spellings can't disagree. */
export function planKey(taskId: string, fireAt: string | number): string {
  return `${taskId}|${typeof fireAt === "number" ? fireAt : Date.parse(fireAt)}`;
}

function openPlanDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PLAN_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PLAN_STORE)) req.result.createObjectStore(PLAN_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(run: (store: IDBObjectStore) => void): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openPlanDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PLAN_STORE, "readwrite");
      run(tx.objectStore(PLAN_STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Record the current plan (upserting each fire, so a renamed task's wording follows it) and age
 *  out fires more than a day old. Best-effort: without it pushes are worded generically. */
export function cachePlan(plan: TaskNotification[], now = Date.now()): Promise<void> {
  return withStore((store) => {
    for (const n of plan) {
      const fire: CachedFire = { key: planKey(n.taskId, n.fireAt), taskId: n.taskId, fireAt: Date.parse(n.fireAt), title: n.title, body: n.body };
      store.put(fire);
    }
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if ((c.value as CachedFire).fireAt < now - KEEP_PAST_MS) c.delete();
      c.continue();
    };
  }).catch(() => {});
}

/** Forget every cached fire (signing out, or turning push off). */
export function clearPlanCache(): Promise<void> {
  return withStore((store) => {
    store.clear();
  }).catch(() => {});
}
