// The Windmill app-shell service worker — hand-rolled, no workbox. Navigations stay
// network-first so the /t/:id unfurl rewrite, the /roadmap generated head, and the static
// marketing pages are always server-fresh; the cached '/' shell is only ever an offline
// fallback. /v1/* is never intercepted (API + websocket upgrades), and neither is /models/**
// — the 33 MB transformers.js weights live better in the plain HTTP cache than in a
// quota-evictable SW cache that would double their storage.
//
// Every cache touch is best-effort and goes through keep()/kept(): storage can be full,
// evicted or refused, and none of that is a reason to fail a request the network answered.
// A worker that can take the page down when the network is fine is worse than no worker.

const VERSION = 'v1';
const SHELL_CACHE = `windmill-shell-${VERSION}`;
const ASSET_CACHE = `windmill-assets-${VERSION}`;
const ICON_CACHE = `windmill-icons-${VERSION}`;
const LIVE_CACHES = [SHELL_CACHE, ASSET_CACHE, ICON_CACHE];

const ICON_PATHS = [
  '/site.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-32.png',
];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

async function activate() {
  const names = await caches.keys().catch(() => []);
  const stale = names.filter((name) => name.startsWith('windmill-') && !LIVE_CACHES.includes(name));
  await Promise.all(stale.map((name) => caches.delete(name).catch(() => {})));
  // Activation may run offline; the shell primes again on the next online navigation to '/'.
  await primeShell().catch(() => {});
  await self.clients.claim();
}

async function keep(cacheName, key, response) {
  const cache = await caches.open(cacheName).catch(() => null);
  if (!cache) return;
  await cache.put(key, response).catch(() => {});
}

async function kept(cacheName, key) {
  const cache = await caches.open(cacheName).catch(() => null);
  if (!cache) return null;
  const found = await cache.match(key).catch(() => null);
  return found ?? null;
}

async function primeShell() {
  const response = await fetch('/');
  if (!response.ok || response.redirected) return;
  await keep(SHELL_CACHE, '/', response);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/')) return;
  if (url.pathname.startsWith('/models/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request, url.pathname));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(hashedAsset(request));
    return;
  }
  if (ICON_PATHS.includes(url.pathname)) {
    event.respondWith(icon(request));
  }
});

async function navigation(request, pathname) {
  try {
    const response = await fetch(request);
    // A redirected response replayed to a later navigation is a NetworkError in Chrome —
    // only a clean 200 for '/' becomes the offline shell.
    if (pathname === '/' && response.ok && !response.redirected) {
      await keep(SHELL_CACHE, '/', response.clone());
    }
    return response;
  } catch (error) {
    const shell = await kept(SHELL_CACHE, '/');
    if (shell) return shell;
    throw error;
  }
}

async function hashedAsset(request) {
  const cached = await kept(ASSET_CACHE, request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await keep(ASSET_CACHE, request, response.clone());
  return response;
}

async function icon(request) {
  const cached = await kept(ICON_CACHE, request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await keep(ICON_CACHE, request, response.clone());
    return response;
  });
  if (cached) {
    refresh.catch(() => {});
    return cached;
  }
  return refresh;
}
