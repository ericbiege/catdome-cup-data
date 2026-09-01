// Catdome Cup -- push notification service worker.
//
// This exists for exactly one job: receive a Web Push event from the browser
// and show a system notification, then route a click on that notification
// back into the app at the right page. It deliberately does NOT do any asset
// caching or offline support -- that's a separate concern this isn't taking
// on, so there's no 'install'/'fetch' handling here, just 'push' and
// 'notificationclick'.
//
// Registered from index.html's subscribeToPush() at navigator.serviceWorker
// .register('/sw.js') -- served at the site root so its scope covers the
// whole app (a service worker's default scope is the directory it's served
// from and everything below it).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Catdome Cup', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Catdome Cup';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
    // No icon/badge asset is wired up yet -- the site's own logo is an inline
    // base64 data URI baked into index.html, not a standalone file this
    // service worker can point at. Browsers fall back to a generic icon.
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
