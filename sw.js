const CACHE_NAME = 'notizbuch-v2';

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './libs/petite-vue.iife.js',
  './libs/genosdb.js',
  './libs/genosrtc.min.js',
  './libs/qrcode.min.js'
];

const OPTIONAL_ASSETS = [
  './img/favicon.ico',
  './img/apple-touch-icon.png',
  './img/apple-touch-icon-144x144.png',
  './img/apple-touch-icon-180x180.png'
];

// Installation: statische Assets cachen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_ASSETS);
      for (const url of OPTIONAL_ASSETS) {
        try { await cache.add(url); } catch (e) { /* optional, ignorieren */ }
      }
    })
  );
  self.skipWaiting();
});

// Aktivierung: alte Caches aufräumen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  return self.clients.claim();
});

// Fetch: Cache-First mit Hintergrund-Update für HTML
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // WebSocket / externe Requests (Nostr-Relays etc.) direkt durchlassen
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) {
    // HTML im Hintergrund aktualisieren (stale-while-revalidate)
    if (request.url.endsWith('.html') || request.url.endsWith('/') ||
        request.url.includes('/libs/')) {
      fetch(request).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res));
      }).catch(() => {});
    }
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('./app.html');
    }
    throw new Error('Offline und nicht gecacht: ' + request.url);
  }
}
