// The app-shell service worker (public/sw.js), driven for real. A bad worker is sticky — it
// survives the deploy that fixed it — so the two rules that keep it safe are pinned here: what
// it must never intercept, and that a storage failure can never cost the user the network's
// answer. The worker is run in a vm with a hand-rolled Cache API whose failures are switchable,
// because that is the whole point: quota is full, eviction happened, the page must still open.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');
const ORIGIN = 'https://windmill.works';
const SHELL_CACHE = 'windmill-shell-v1';
const ASSET_CACHE = 'windmill-assets-v1';
const ICON_CACHE = 'windmill-icons-v1';

function quota() {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

function reply(body, { ok = true, status = 200, redirected = false } = {}) {
  return { body, ok, status, redirected, clone: () => reply(body, { ok, status, redirected }) };
}

// One worker, booted over a cache whose open/put/match fail on demand and a network the test owns.
function boot({ fetches = () => reply('NETWORK'), openFails = false, putFails = false, matchFails = false, cached = {} } = {}) {
  const stores = new Map(Object.entries(cached).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
  const keyOf = (request) => (typeof request === 'string' ? request : request.url);
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (request) => { if (matchFails) throw quota(); return store.get(keyOf(request)); },
      put: async (request, value) => { if (putFails) throw quota(); store.set(keyOf(request), value); },
    };
  };
  const caches = {
    open: async (name) => { if (openFails) throw quota(); return cacheFor(name); },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (request, options) => cacheFor(options.cacheName).match(request),
  };

  const listeners = new Map();
  const claimed = { count: 0 };
  const network = [];
  const self = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: async () => { claimed.count += 1; } },
    location: { origin: ORIGIN },
  };
  const fetchImpl = async (request) => {
    network.push(keyOf(request));
    return fetches(keyOf(request));
  };
  vm.runInContext(SW, vm.createContext({ self, caches, fetch: fetchImpl, URL, console }), { filename: 'sw.js' });

  return {
    network,
    claimed,
    bodiesIn(name) {
      return [...(stores.get(name) ?? new Map())].map(([key, value]) => [key, value.body]);
    },
    // The worker's answer, or null when it declined to intercept — that null IS the bypass rule.
    handle(url, { mode = 'no-cors', method = 'GET' } = {}) {
      let answered = null;
      listeners.get('fetch')({
        request: { url, method, mode },
        respondWith: (value) => { answered = Promise.resolve(value); },
      });
      return answered;
    },
    activate() {
      let waited = null;
      listeners.get('activate')({ waitUntil: (value) => { waited = value; } });
      return waited;
    },
  };
}

test('the worker declines everything it must never own', () => {
  const worker = boot();
  assert.equal(worker.handle(`${ORIGIN}/v1/gym/sessions`), null);
  assert.equal(worker.handle(`${ORIGIN}/v1/socket`, { mode: 'websocket' }), null);
  assert.equal(worker.handle(`${ORIGIN}/models/bge-small/model_quantized.onnx`), null);
  assert.equal(worker.handle(`${ORIGIN}/v1/gym/sessions`, { method: 'POST' }), null);
  assert.equal(worker.handle(`${ORIGIN}/`, { mode: 'navigate', method: 'POST' }), null);
  assert.equal(worker.handle('https://fonts.example/inter.woff2'), null);
  assert.equal(worker.handle('https://windmill.works.evil.example/assets/app.js'), null);
  assert.deepEqual(worker.network, []);
});

test('navigations are network-first, and only the bare shell is ever kept', async () => {
  const worker = boot({ fetches: (url) => reply(`SERVER:${url}`) });
  assert.equal((await worker.handle(`${ORIGIN}/t/t_9362d9bc883e0a1e`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/t/t_9362d9bc883e0a1e`);
  assert.equal((await worker.handle(`${ORIGIN}/roadmap`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/roadmap`);
  assert.equal((await worker.handle(`${ORIGIN}/app/gym`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/app/gym`);
  assert.deepEqual(worker.bodiesIn(SHELL_CACHE), []);

  assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/`);
  assert.deepEqual(worker.bodiesIn(SHELL_CACHE), [['/', `SERVER:${ORIGIN}/`]]);
  assert.deepEqual(worker.network, [
    `${ORIGIN}/t/t_9362d9bc883e0a1e`, `${ORIGIN}/roadmap`, `${ORIGIN}/app/gym`, `${ORIGIN}/`,
  ]);
});

test('a redirected or failed shell response is served but never cached', async () => {
  const redirected = boot({ fetches: () => reply('LOGIN-PAGE', { status: 301, redirected: true }) });
  assert.equal((await redirected.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, 'LOGIN-PAGE');
  assert.deepEqual(redirected.bodiesIn(SHELL_CACHE), []);

  const failed = boot({ fetches: () => reply('OOPS', { ok: false, status: 500 }) });
  assert.equal((await failed.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, 'OOPS');
  assert.deepEqual(failed.bodiesIn(SHELL_CACHE), []);
});

test('offline, a navigation anywhere in the app falls back to the cached shell', async () => {
  const worker = boot({
    fetches: () => { throw new TypeError('Failed to fetch'); },
    cached: { [SHELL_CACHE]: { '/': reply('CACHED-SHELL') } },
  });
  assert.equal((await worker.handle(`${ORIGIN}/roadmap`, { mode: 'navigate' })).body, 'CACHED-SHELL');
  assert.equal((await worker.handle(`${ORIGIN}/app/gym`, { mode: 'navigate' })).body, 'CACHED-SHELL');
});

test('offline with nothing cached, the navigation fails as the network failed', async () => {
  const worker = boot({ fetches: () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => worker.handle(`${ORIGIN}/`, { mode: 'navigate' }), { name: 'TypeError', message: 'Failed to fetch' });
});

test('hashed assets are cache-first — a cached chunk never touches the network', async () => {
  const worker = boot({
    fetches: () => reply('FRESH-CHUNK'),
    cached: { [ASSET_CACHE]: { [`${ORIGIN}/assets/Shell-DbwZbYqo.js`]: reply('CACHED-CHUNK') } },
  });
  assert.equal((await worker.handle(`${ORIGIN}/assets/Shell-DbwZbYqo.js`)).body, 'CACHED-CHUNK');
  assert.deepEqual(worker.network, []);

  assert.equal((await worker.handle(`${ORIGIN}/assets/index-9f3a1c22.css`)).body, 'FRESH-CHUNK');
  assert.deepEqual(worker.network, [`${ORIGIN}/assets/index-9f3a1c22.css`]);
  assert.deepEqual(worker.bodiesIn(ASSET_CACHE), [
    [`${ORIGIN}/assets/Shell-DbwZbYqo.js`, 'CACHED-CHUNK'],
    [`${ORIGIN}/assets/index-9f3a1c22.css`, 'FRESH-CHUNK'],
  ]);
});

test('icons answer from cache and refresh behind it', async () => {
  const worker = boot({
    fetches: () => reply('FRESH-ICON'),
    cached: { [ICON_CACHE]: { [`${ORIGIN}/favicon.svg`]: reply('CACHED-ICON') } },
  });
  assert.equal((await worker.handle(`${ORIGIN}/favicon.svg`)).body, 'CACHED-ICON');
  assert.equal((await worker.handle(`${ORIGIN}/site.webmanifest`)).body, 'FRESH-ICON');
  assert.deepEqual(worker.network, [`${ORIGIN}/favicon.svg`, `${ORIGIN}/site.webmanifest`]);
});

// F17: cache.put rejecting used to reject respondWith — an online user got Chrome's network-error
// page for a 200, and a failed chunk load, until they cleared storage by hand.
test('a full cache never costs the user the network — puts that throw are swallowed', async () => {
  const worker = boot({ fetches: (url) => reply(`SERVER:${url}`), putFails: true });
  assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/`);
  assert.equal((await worker.handle(`${ORIGIN}/assets/Shell-DbwZbYqo.js`)).body, `SERVER:${ORIGIN}/assets/Shell-DbwZbYqo.js`);
  assert.equal((await worker.handle(`${ORIGIN}/favicon.svg`)).body, `SERVER:${ORIGIN}/favicon.svg`);
  assert.deepEqual(worker.bodiesIn(SHELL_CACHE), []);
});

test('a cache that will not open never costs the user the network either', async () => {
  const worker = boot({ fetches: (url) => reply(`SERVER:${url}`), openFails: true });
  assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, `SERVER:${ORIGIN}/`);
  assert.equal((await worker.handle(`${ORIGIN}/assets/Shell-DbwZbYqo.js`)).body, `SERVER:${ORIGIN}/assets/Shell-DbwZbYqo.js`);
  assert.equal((await worker.handle(`${ORIGIN}/favicon.svg`)).body, `SERVER:${ORIGIN}/favicon.svg`);
});

test('a cache that will not read falls through to the network, not to a failure', async () => {
  const worker = boot({
    fetches: () => reply('FRESH-CHUNK'),
    matchFails: true,
    cached: { [ASSET_CACHE]: { [`${ORIGIN}/assets/Shell-DbwZbYqo.js`]: reply('CACHED-CHUNK') } },
  });
  assert.equal((await worker.handle(`${ORIGIN}/assets/Shell-DbwZbYqo.js`)).body, 'FRESH-CHUNK');
});

// The stale half of F17: the fresh 200 was discarded and last deploy's shell served to an online
// user, because the failing put threw into the offline fallback.
test('an online navigation never serves the stale shell because the cache is full', async () => {
  const worker = boot({
    fetches: () => reply('NEW-DEPLOY-SHELL'),
    putFails: true,
    cached: { [SHELL_CACHE]: { '/': reply('OLD-DEPLOY-SHELL') } },
  });
  assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, 'NEW-DEPLOY-SHELL');
});

test('offline with a cache that will not open, the navigation fails as the network failed', async () => {
  const worker = boot({
    fetches: () => { throw new TypeError('Failed to fetch'); },
    openFails: true,
    cached: { [SHELL_CACHE]: { '/': reply('CACHED-SHELL') } },
  });
  await assert.rejects(() => worker.handle(`${ORIGIN}/roadmap`, { mode: 'navigate' }), { name: 'TypeError', message: 'Failed to fetch' });
});

test('activation drops last version’s caches, primes the shell, and claims the page', async () => {
  const worker = boot({
    fetches: () => reply('PRIMED-SHELL'),
    cached: { 'windmill-shell-v0': { '/': reply('ANCIENT') }, 'unrelated-cache': { '/': reply('NOT OURS') } },
  });
  await worker.activate();
  assert.deepEqual(worker.bodiesIn('windmill-shell-v0'), []);
  assert.deepEqual(worker.bodiesIn('unrelated-cache'), [['/', 'NOT OURS']]);
  assert.deepEqual(worker.bodiesIn(SHELL_CACHE), [['/', 'PRIMED-SHELL']]);
  assert.equal(worker.claimed.count, 1);
});

test('activation still claims the page when storage is refusing everything', async () => {
  const worker = boot({ fetches: () => reply('PRIMED-SHELL'), openFails: true, putFails: true });
  await worker.activate();
  assert.equal(worker.claimed.count, 1);
});
