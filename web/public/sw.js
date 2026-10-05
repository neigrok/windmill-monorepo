// A shell is promoted only after every required room asset is durable in the same generation.
// API calls and model weights keep their own network doors. Cache refusal never fails a network reply.

const SHELL_CACHE = 'windmill-shell-v2';
const ASSET_CACHE = 'windmill-assets-v2';
const ICON_CACHE = 'windmill-icons-v2';
const GENERATION_PREFIX = 'windmill-generation-';
const POINTER = '/offline-generation';
const ICON_PATHS = [
  '/brand-logo.svg', '/brand-mark.svg', '/site.webmanifest', '/icon-192.png', '/icon-512.png',
  '/apple-touch-icon.png', '/favicon.ico', '/favicon.svg', '/favicon-32.png',
];
let priming;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await primeShell().catch(() => {});
    await self.clients.claim();
  })());
});

async function keep(cacheName, key, response) {
  const cache = await caches.open(cacheName).catch(() => null);
  if (cache) await cache.put(key, response).catch(() => {});
}

async function kept(cacheName, key) {
  const cache = await caches.open(cacheName).catch(() => null);
  return cache ? await cache.match(key, { ignoreVary: true }).catch(() => null) : null;
}

async function generations() {
  return await kept(SHELL_CACHE, POINTER).then((response) => response?.json()).catch(() => null) ?? {};
}

async function shell() {
  const { current } = await generations();
  return current ? kept(current, '/') : kept(SHELL_CACHE, '/');
}

function localAsset(raw) {
  const url = new URL(raw, self.location.origin);
  return url.origin === self.location.origin && !url.pathname.startsWith('/v1/')
    && !url.pathname.startsWith('/models/') ? url.pathname + url.search : null;
}

function primeShell(urls = []) {
  if (priming) return priming;
  const stage = () => stageShell(urls);
  priming = (self.navigator?.locks ? self.navigator.locks.request('windmill-offline-shell', stage) : stage())
    .finally(() => { priming = null; });
  return priming;
}

async function stageShell(urls) {
  const response = await network('/', true, true);
  if (!response.ok || response.redirected) throw new Error('offline-shell-response');
  const html = await response.clone().text();
  const development = html.includes('/@vite/client');
  const manifestResponse = development ? null : await network('/offline-assets.json', true, true);
  if (manifestResponse && (!manifestResponse.ok || manifestResponse.redirected)) throw new Error('offline-shell-manifest');
  const manifest = development ? urls.map(localAsset).filter(Boolean) : await manifestResponse.json();
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.some((url) => typeof url !== 'string' || localAsset(url) !== url)) {
    throw new Error('offline-shell-manifest');
  }
  const required = [...new Set(manifest)];
  const references = [...html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)].map((match) => match[1])
    .filter((url) => /^(\/assets\/|\/@|\/src\/)/.test(url));
  if (references.some((url) => !required.includes(url))) throw new Error('offline-shell-generation-mismatch');

  const previous = await generations();
  if (previous.current && await kept(previous.current, '/').then((cached) => cached?.text()) === html
    && (await Promise.all(required.map((url) => kept(previous.current, url)))).every((asset) => asset?.ok)) return true;

  const name = `${GENERATION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const cache = await caches.open(name);
    const writes = await Promise.allSettled(required.map(async (url) => {
      const asset = await network(url, true, true);
      if (!asset.ok || asset.redirected) throw new Error('offline-shell-asset');
      await cache.put(url, asset);
    }));
    if (writes.some((write) => write.status === 'rejected')) throw new Error('offline-shell-assets');
    const verified = await Promise.all(required.map((url) => cache.match(url, { ignoreVary: true })));
    if (verified.some((asset) => !asset?.ok)) throw new Error('offline-shell-incomplete');
    await cache.put('/', response);
    if (!(await cache.match('/'))?.ok) throw new Error('offline-shell-incomplete');
    const pointerCache = await caches.open(SHELL_CACHE);
    await pointerCache.put(POINTER, new Response(JSON.stringify({ current: name, previous: previous.current })));
    // Preserve the immediately previous complete generation for pages still using its chunks.
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((entry) => entry.startsWith('windmill-')
      && ![SHELL_CACHE, ASSET_CACHE, ICON_CACHE, name, previous.current].includes(entry))
      .map((entry) => caches.delete(entry).catch(() => {})));
    return true;
  } catch (error) {
    await caches.delete(name).catch(() => {});
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/models/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || ['script', 'style', 'font', 'worker'].includes(request.destination)
    || url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) {
    event.respondWith(hashedAsset(request));
    return;
  }
  if (ICON_PATHS.includes(url.pathname)) event.respondWith(icon(request));
});

async function navigation(request) {
  try { return await network(request, true); }
  catch (error) {
    const cached = await shell();
    if (cached) return cached;
    throw error;
  }
}

async function hashedAsset(request) {
  const url = new URL(typeof request === 'string' ? request : request.url, self.location.origin);
  const mutable = /^\/(src|@|node_modules)\//.test(url.pathname);
  const { current, previous } = await generations();
  let cached = mutable ? await kept(ASSET_CACHE, request) : null;
  if (!cached && current) cached = await kept(current, request);
  if (!cached && previous) cached = await kept(previous, request);
  if (!cached) cached = await kept(ASSET_CACHE, request);
  if (cached && !mutable) return cached;
  try {
    const response = await network(request);
    if (response.ok) await keep(ASSET_CACHE, request, response.clone());
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function icon(request) {
  const cached = await kept(ICON_CACHE, request);
  const refresh = network(request).then(async (response) => {
    if (response.ok) await keep(ICON_CACHE, request, response.clone());
    return response;
  });
  if (cached) { refresh.catch(() => {}); return cached; }
  return refresh;
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'refresh-shell') {
    event.waitUntil(primeShell().then(() => event.ports?.[0]?.postMessage({ ok: true }),
      () => event.ports?.[0]?.postMessage({ ok: false })));
    return;
  }
  if (event.data?.type !== 'warm' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(Promise.all([primeShell(event.data.urls).catch(() => {}), ...event.data.urls.map(localAsset)
    .filter(Boolean).map((url) => hashedAsset(url).catch(() => {}))]));
});

async function network(request, reload = false, complete = false) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(request, { signal: controller.signal, ...(reload ? { cache: 'reload' } : {}) }).then(async (response) => {
        if (complete) await response.clone().arrayBuffer();
        return response;
      }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new Error('offline-shell-timeout'));
      }, 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
