/* global self, caches */
// DinePOS kitchen display service worker (P4-02): keeps the app itself available when the shop Wi-Fi blips. Tickets
// always come from the outlet server.
const CACHE = 'dinepos-kds-v1';

self.addEventListener('install', (event) => {
  // The page and the hashed scripts/styles it loads, so the app opens with no connection (P3-03).
  event.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(['/kds/', '/kds/manifest.webmanifest', '/kds/icon.svg']);
      const page = await (await c.match('/kds/')).text();
      const assets = [...new Set(page.match(/\/captain\/assets\/[^"']+/g) ?? [])];
      await c.addAll(assets);
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.pathname.startsWith('/kds/')) return; // never the API
  // Pages: network first (new versions show at once), the cached shell when offline. Assets: cache first.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/kds/')));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && url.pathname.startsWith('/kds/assets/')) {
            const copy = res.clone(); // before the page reads the body
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
