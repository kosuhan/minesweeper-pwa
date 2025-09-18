// Simple cache-first service worker for offline play
const CACHE = 'ms-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cache GET responses for next time
        if (req.method === 'GET' && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(req, clone));
        }
        return resp;
      }).catch(() => {
        // offline fallback: if requesting navigation, serve cached index
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('Offline', {status: 503, statusText: 'Offline'});
      });
    })
  );
});
