// Companion service worker (PLAN §6.4, web W3). Two jobs:
//
// 1. Routing reminder notification *clicks*: turning a click into "focus (or open) an app window
//    and deep-link to the task". The page's in-tab scheduler shows reminders through this worker's
//    registration so a click lands here even after the tab that scheduled it has closed.
// 2. Showing reminders the sync server *pushes* (web push, packages/app/src/push): the only way an
//    installed web app — on iOS above all — is reminded while it is closed. The worker still
//    schedules nothing itself; the server decides when, the worker only words and shows.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data && event.notification.data.taskId;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientList.find((c) => 'focus' in c);
      if (existing) {
        await existing.focus();
        if (taskId) existing.postMessage({ type: 'reminder-activate', taskId });
        return;
      }
      // No open window (the usual case for a pushed reminder): open one. The taskId rides the URL
      // so the freshly loaded app can pick it up even though it isn't listening for messages yet.
      const url = taskId ? `/?reminder=${encodeURIComponent(taskId)}` : '/';
      await self.clients.openWindow(url);
    })(),
  );
});

// --- pushed reminders ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let msg = null;
  try {
    msg = event.data ? event.data.json() : null;
  } catch {
    msg = null;
  }
  // Every push must end in a notification: Safari revokes a web app's push permission after a few
  // that show nothing, so even an unreadable message is shown.
  event.waitUntil(showPushed(msg));
});

async function showPushed(msg) {
  if (msg && msg.type === 'reminder' && msg.taskId) {
    // An encrypted account's push carries no title (the server can't read it): the page caches its
    // own plan — decrypted titles, worded in this device's time zone — for exactly this lookup.
    const cached = await cachedFire(msg.taskId, msg.fireAt);
    const title = (cached && cached.title) || msg.title || 'Task reminder';
    const lateDeadline = isDeadlineFire(msg) && Date.now() - Date.parse(msg.fireAt) > LATE_MS;
    const body = (!lateDeadline && cached && cached.body) || reminderBody(msg);
    return self.registration.showNotification(title, {
      body,
      tag: msg.taskId,
      data: { taskId: msg.taskId, fireAt: msg.fireAt },
    });
  }
  return self.registration.showNotification((msg && msg.title) || 'Companion', {
    body: (msg && msg.body) || '',
    tag: 'companion',
    data: {},
  });
}

// A deadline fire delivered this late (the device was offline) says when it was due, not "Due now".
const LATE_MS = 5 * 60 * 1000;

function isDeadlineFire(msg) {
  return !!msg.dueAt && Date.parse(msg.dueAt) === Date.parse(msg.fireAt);
}

// The wording the apps give a fire (core/notify): "Due now" at the deadline, "Due <when>" for a
// reminder ahead of one, "Reminder" for a task without a deadline.
function reminderBody(msg) {
  if (!msg.dueAt) return 'Reminder';
  const due = Date.parse(msg.dueAt);
  if (Number.isNaN(due)) return 'Reminder';
  if (isDeadlineFire(msg)) return Date.now() - due > LATE_MS ? `Was due ${formatWhen(due)}` : 'Due now';
  return `Due ${formatWhen(due)}`;
}

function formatWhen(ms) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

// The page's reminder plan (packages/app/src/push/planCache.ts — keep the names in step). Looked up
// by task and fire instant; a miss, an error or a slow disk all just mean generic wording.
function cachedFire(taskId, fireAt) {
  const key = `${taskId}|${Date.parse(fireAt)}`;
  const lookup = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open('companion-push', 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('plan')) req.result.createObjectStore('plan', { keyPath: 'key' });
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('plan', 'readonly').objectStore('plan').get(key);
        get.onsuccess = () => {
          db.close();
          resolve(get.result || null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
  return Promise.race([lookup, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
}

// The browser replaced the subscription (keys rotated, or it expired): subscribe again with the
// same server key so reminders keep arriving, and tell any open window to register the new one
// with the server — the worker holds no session to do that itself. A window opened later
// re-registers on launch.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (key && !event.newSubscription) {
        try {
          await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch {
          /* permission gone: the window's next launch notices and turns push off */
        }
      }
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientList) c.postMessage({ type: 'push-subscription-changed' });
    })(),
  );
});
