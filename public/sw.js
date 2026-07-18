/**
 * Kill-switch service worker. An earlier version cached the app shell, which on
 * a shared localhost origin can serve stale code and hide errors. This version
 * unregisters itself and clears all caches on activation, so any browser that
 * still has the old SW cleans up on its next visit. (No caching / no offline for
 * now; the terminal view needs a live socket anyway.)
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.navigate(c.url));
    })(),
  );
});
