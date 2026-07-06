// Companion service worker (PLAN §6.4, web W3). Its only job is routing reminder
// notification *clicks*: the page's in-tab scheduler shows reminders via
// registration.showNotification, and this worker turns a click into "focus (or open) an
// app window and deep-link to the task". It deliberately does NOT schedule anything — the
// web platform can't reliably fire a local notification while the browser is closed, so
// scheduling stays in the page (which is also why a click will almost always find an open
// client to focus).

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
      // No open window (rare — a notification is only shown by a live tab): open one. The
      // taskId rides the URL so the freshly loaded app can pick it up even though it isn't
      // listening for messages yet.
      const url = taskId ? `/?reminder=${encodeURIComponent(taskId)}` : '/';
      await self.clients.openWindow(url);
    })(),
  );
});
