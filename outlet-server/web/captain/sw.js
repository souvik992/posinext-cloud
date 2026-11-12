/* global self, caches */
// DinePOS Captain service worker (P3-01): keeps the app itself available when the shop Wi-Fi blips. Data (orders,
// menu) comes from the outlet server; the last copy and the offline outbox live in IndexedDB (P3-03).
const CACHE = 'dinepos-captain-v2';

self.addEventListener('install', (event) => {
  // The page and the hashed scripts/styles it loads, so the app opens with no connection (P3-03).
  event.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(['/captain/', '/captain/manifest.webmanifest', '/captain/icon.svg']);
      const page = await (await c.match('/captain/')).text();
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
  if (event.request.method !== 'GET' || !url.pathname.startsWith('/captain/')) return; // never the API
  // Pages: network first (new versions show at once), the cached shell when offline. Assets: cache first.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/captain/')));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && url.pathname.startsWith('/captain/assets/')) {
            const copy = res.clone(); // before the page reads the body
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
