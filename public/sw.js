// Vircle Halo service worker — network-first for API, cache-first for static assets.
const CACHE = 'halo-static-v1';
const STATIC_EXT = ['.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2'];

const isApi = (url) => new URL(url).pathname.startsWith('/api/');
const isStatic = (url) => STATIC_EXT.some((e) => new URL(url).pathname.endsWith(e));

async function networkFirst(req) {
  try { return await fetch(req); }
  catch { return (await caches.match(req)) || Response.error(); }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch { return Response.error(); }
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (!url.startsWith('http')) return;
  if (isApi(url)) e.respondWith(networkFirst(e.request));
  else if (isStatic(url)) e.respondWith(cacheFirst(e.request));
  // Navigation requests pass through unintercepted.
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch {}
  const title = data.title ?? 'New Sembang message';
  const options = {
    body: data.body ?? '',
    icon: '/brand/mascot-icon.png',
    badge: '/brand/mascot-icon.png',
    tag: data.messageId ?? 'sembang-message',
    renotify: true,
    data: { url: data.url ?? '/sembang' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url ?? '/sembang';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
