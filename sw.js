const CACHE_NAME = 'notizbuch-v32';

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.html',
  './app-evolu.html',
  './manifest.json',
  './libs/petite-vue.iife.js',
  './libs/qrcode.min.js',
  './libs/iro.min.js'
];

const OPTIONAL_ASSETS = [
  './img/favicon.ico',
  './img/apple-touch-icon.png',
  './img/apple-touch-icon-144x144.png',
  './img/apple-touch-icon-180x180.png'
];

// Installation: Assets cachen, sofort aktivieren
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_ASSETS);
      for (const url of OPTIONAL_ASSETS) {
        try { await cache.add(url); } catch { /* optional */ }
      }
    })
  );
  self.skipWaiting();
});

// Aktivierung: alte Caches löschen, sofort Kontrolle übernehmen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch-Strategie:
//   HTML → Network-first (immer aktuell, Fallback auf Cache)
//   Libs → Stale-while-revalidate (schnell, im Hintergrund aktualisiert)
//   Rest → Cache-first
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // CDN-Requests (Yjs) cachen
  if (event.request.url.includes('cdn.jsdelivr.net')) {
    event.respondWith(staleWhileRevalidate(event.request, event));
    return;
  }
  if (!event.request.url.startsWith(self.location.origin)) return;
  // WebSocket-Upgrades nicht anfassen
  if (event.request.headers.get('upgrade') === 'websocket') return;

  const url = new URL(event.request.url);

  if (url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    // HTML: Network-first → bei Änderungen sofort sichtbar
    event.respondWith(networkFirst(event.request));
  } else if (url.pathname.includes('/libs/')) {
    // Libs: Stale-while-revalidate → schnell laden, im Hintergrund updaten
    event.respondWith(staleWhileRevalidate(event.request, event));
  } else {
    // Alles andere: Cache-first
    event.respondWith(cacheFirst(event.request));
  }
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline-Fallback
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('./app.html');
    }
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      caches.open(CACHE_NAME).then(cache => cache.put(request, response));
    }
    return response.clone();
  }).catch(() => null);

  if (cached) {
    // Im Hintergrund updaten
    event.waitUntil(fetchPromise);
    return cached;
  }
  // Kein Cache → auf Netzwerk warten
  const response = await fetchPromise;
  return response || new Response('Offline', { status: 503 });
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Messages vom Main-Thread
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME).then(() => console.log('[SW] Cache cleared'));
  }
});
