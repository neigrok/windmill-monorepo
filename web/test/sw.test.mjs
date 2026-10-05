import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { offlineShell, PRECACHE_BUDGET } from '../scripts/offlineShell.js';

const SW = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://windmill.works';
const SHELL_CACHE = 'windmill-shell-v2';
const ASSET_CACHE = 'windmill-assets-v2';
const ICON_CACHE = 'windmill-icons-v2';
const POINTER = '/offline-generation';

function reply(body, { ok = true, status = 200, redirected = false } = {}) {
  return { body, ok, status, redirected, text: async () => body, arrayBuffer: async () => Buffer.from(body), json: async () => JSON.parse(body),
    clone: () => reply(body, { ok, status, redirected }) };
}
function quota() { return Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); }
function boot({ fetches, openFails = false, putFails = false, matchFails = false, cached = {}, timeout = 5000 } = {}) {
  const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const stores = new Map(Object.entries(cached).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
  const fails = (option, name, key) => typeof option === 'function' ? option(name, key) : option;
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (request) => { const key = keyOf(request); if (fails(matchFails, name, key)) throw quota(); return store.get(key); },
      put: async (request, value) => { const key = keyOf(request); if (fails(putFails, name, key)) throw quota(); store.set(key, value); },
    };
  };
  const caches = { open: async (name) => { if (fails(openFails, name)) throw quota(); return cacheFor(name); },
    keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) };
  const listeners = new Map(), network = [], claimed = { count: 0 };
  const self = { addEventListener: (type, listener) => listeners.set(type, listener), skipWaiting: () => {},
    clients: { claim: async () => { claimed.count++; } }, location: { origin: ORIGIN } };
  const fetchImpl = async (request, options) => {
    const key = keyOf(request); network.push({ key, options });
    return fetches ? fetches(key, options) : reply(key === '/offline-assets.json' ? '["/assets/app.js"]' : key);
  };
  vm.runInContext(SW, vm.createContext({ self, caches, fetch: fetchImpl, URL, AbortController,
    Response: class { constructor(body) { return reply(body); } },
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, timeout)), clearTimeout }), { filename: 'sw.js' });
  return {
    network, claimed, stores,
    entries(name) { return [...(stores.get(name) ?? [])].map(([key, value]) => [key, value.body]); },
    async pointer() { return (await cacheFor(SHELL_CACHE).match(POINTER))?.json() ?? {}; },
    handle(url, { mode = 'no-cors', method = 'GET', destination = '' } = {}) {
      let answer = null;
      listeners.get('fetch')({ request: { url, method, mode, destination }, respondWith: (value) => { answer = Promise.resolve(value); } });
      return answer;
    },
    activate() { let waited; listeners.get('activate')({ waitUntil: (value) => { waited = value; } }); return waited; },
    warm(urls = []) { let waited; listeners.get('message')({ data: { type: 'warm', urls }, waitUntil: (value) => { waited = value; } }); return waited; },
    async refresh() {
      let waited, answer;
      listeners.get('message')({ data: { type: 'refresh-shell' }, ports: [{ postMessage: (value) => { answer = value; } }], waitUntil: (value) => { waited = value; } });
      await waited;
      return JSON.parse(JSON.stringify(answer));
    },
  };
}
function deployment(version, failure) {
  return (url) => {
    if (url === '/') return reply(`<script src="/assets/${version}.js"></script>`);
    if (url === '/offline-assets.json') return reply(JSON.stringify([`/assets/${version}.js`, `/assets/${version}.css`]));
    if (failure) return failure(url);
    return reply(`${version}:${url}`);
  };
}
function oldGeneration() {
  return { [SHELL_CACHE]: { [POINTER]: reply(JSON.stringify({ current: 'windmill-generation-old' })) },
    'windmill-generation-old': { '/': reply('OLD-SHELL'), '/assets/old.js': reply('OLD-ASSET') } };
}

test('the worker declines API, model, foreign-origin and non-GET requests', () => {
  const worker = boot();
  for (const url of ['/v1/gym/sessions', '/v1/socket', '/models/model.onnx']) assert.equal(worker.handle(`${ORIGIN}${url}`), null);
  assert.equal(worker.handle(`${ORIGIN}/`, { mode: 'navigate', method: 'POST' }), null);
  assert.equal(worker.handle('https://windmill.works.evil.example/assets/app.js'), null);
  assert.equal(worker.handle('https://fonts.example/font.woff2'), null);
  assert.deepEqual(worker.network, []);
});

test('navigations return network responses without promoting unverified HTML', async () => {
  const worker = boot({ fetches: (url) => reply(`SERVER:${url}`), cached: oldGeneration() });
  for (const url of ['/t/tree', '/roadmap', '/app/gym', '/']) {
    assert.equal((await worker.handle(`${ORIGIN}${url}`, { mode: 'navigate' })).body, `SERVER:${url}`);
  }
  assert.deepEqual(await worker.pointer(), { current: 'windmill-generation-old' });
  assert.ok(worker.network.every(({ options }) => options.cache === 'reload'));
});

test('redirected and failed shell responses cannot be promoted', async () => {
  for (const options of [{ redirected: true, status: 301 }, { ok: false, status: 500 }]) {
    const worker = boot({ fetches: () => reply('FAILED', options), cached: oldGeneration() });
    assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, 'FAILED');
    assert.deepEqual(await worker.refresh(), { ok: false });
    assert.deepEqual(await worker.pointer(), { current: 'windmill-generation-old' });
  }
});

test('offline and stalled navigations use the current complete generation', async () => {
  for (const fetches of [() => { throw new TypeError('offline'); }, () => new Promise(() => {})]) {
    const worker = boot({ fetches, cached: oldGeneration(), timeout: 10 });
    assert.equal((await worker.handle(`${ORIGIN}/app/journal`, { mode: 'navigate' })).body, 'OLD-SHELL');
  }
});

test('legacy shell remains available when activation is offline', async () => {
  const worker = boot({ fetches: () => { throw new TypeError('offline'); }, cached: { [SHELL_CACHE]: { '/': reply('LEGACY') } } });
  await worker.activate();
  assert.equal((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, 'LEGACY');
  assert.equal(worker.claimed.count, 1);
});

test('offline with no readable shell retains the network failure', async () => {
  for (const openFails of [false, true]) {
    const worker = boot({ fetches: () => { throw new TypeError('offline'); }, cached: oldGeneration(), openFails });
    if (openFails) await assert.rejects(worker.handle(`${ORIGIN}/`, { mode: 'navigate' }), { name: 'TypeError', message: 'offline' });
  }
  const empty = boot({ fetches: () => { throw new TypeError('offline'); } });
  await assert.rejects(empty.handle(`${ORIGIN}/`, { mode: 'navigate' }), { name: 'TypeError', message: 'offline' });
});

test('hashed assets use complete generations before touching the network', async () => {
  const worker = boot({ cached: oldGeneration() });
  assert.equal((await worker.handle(`${ORIGIN}/assets/old.js`)).body, 'OLD-ASSET');
  assert.deepEqual(worker.network, []);
  assert.equal((await worker.handle(`${ORIGIN}/assets/new.js`)).body, '/assets/new.js');
  assert.deepEqual(worker.entries(ASSET_CACHE), [['/assets/new.js', '/assets/new.js']]);
});

test('icons use their cache while refreshing behind it', async () => {
  const worker = boot({ cached: { [ICON_CACHE]: { '/favicon.svg': reply('CACHED') } } });
  assert.equal((await worker.handle(`${ORIGIN}/favicon.svg`)).body, 'CACHED');
  assert.equal((await worker.handle(`${ORIGIN}/site.webmanifest`)).body, '/site.webmanifest');
  assert.deepEqual(worker.network.map(({ key }) => key), ['/favicon.svg', '/site.webmanifest']);
});

test('cache open, write and read failures never cost the network response', async () => {
  for (const failures of [{ openFails: true }, { putFails: true }, { matchFails: true }]) {
    const worker = boot({ ...failures, fetches: (url) => reply(`NETWORK:${url}`), cached: oldGeneration() });
    for (const [url, mode] of [['/', 'navigate'], ['/assets/new.js', 'no-cors'], ['/favicon.svg', 'no-cors']]) {
      assert.equal((await worker.handle(`${ORIGIN}${url}`, { mode })).body, `NETWORK:${url}`);
    }
  }
});

test('activation stages all required assets before publishing one atomic shell pointer', async () => {
  const worker = boot({ fetches: deployment('new'), cached: { ...oldGeneration(), 'unrelated-cache': { '/': reply('OTHER') } } });
  await worker.activate();
  const pointer = await worker.pointer();
  assert.deepEqual(pointer, { current: pointer.current, previous: 'windmill-generation-old' });
  assert.deepEqual(worker.entries(pointer.current).sort(), [
    ['/', '<script src="/assets/new.js"></script>'], ['/assets/new.css', 'new:/assets/new.css'], ['/assets/new.js', 'new:/assets/new.js'],
  ]);
  assert.deepEqual(worker.entries('windmill-generation-old'), [['/', 'OLD-SHELL'], ['/assets/old.js', 'OLD-ASSET']]);
  assert.deepEqual(worker.entries('unrelated-cache'), [['/', 'OTHER']]);
  assert.equal(worker.claimed.count, 1);
});

test('missing, crashed, stalled and refused asset writes retain the previous complete shell', async () => {
  for (const failure of [() => reply('missing', { ok: false, status: 404 }), () => { throw new TypeError('crash'); },
    () => new Promise(() => {}), () => ({ ...reply('stalled-body'), clone: () => ({ arrayBuffer: () => new Promise(() => {}) }) })]) {
    const worker = boot({ fetches: deployment('new', failure), cached: oldGeneration(), timeout: 10 });
    assert.deepEqual(await worker.refresh(), { ok: false });
    assert.deepEqual(await worker.pointer(), { current: 'windmill-generation-old' });
    assert.deepEqual([...worker.stores.keys()].filter((name) => name.startsWith('windmill-generation-')), ['windmill-generation-old']);
    assert.equal(worker.entries('windmill-generation-old')[0][1], 'OLD-SHELL');
  }
  for (const failures of [
    { putFails: (name) => name.startsWith('windmill-generation-') },
    { putFails: (_name, key) => key === POINTER },
    { matchFails: (name) => name.startsWith('windmill-generation-') && name !== 'windmill-generation-old' },
  ]) {
    const worker = boot({ ...failures, fetches: deployment('new'), cached: oldGeneration() });
    assert.deepEqual(await worker.refresh(), { ok: false });
    assert.deepEqual(await worker.pointer(), { current: 'windmill-generation-old' });
  }
});

test('an invalid manifest or a deploy mismatch cannot replace a complete shell', async () => {
  for (const body of ['broken-json', '[]', '["/assets/other.js"]', '["https://evil.example/asset.js"]', '[42]']) {
    const worker = boot({ cached: oldGeneration(), fetches: (url) => url === '/offline-assets.json' ? reply(body) : deployment('new')(url) });
    assert.deepEqual(await worker.refresh(), { ok: false });
    assert.deepEqual(await worker.pointer(), { current: 'windmill-generation-old' });
  }
});

test('same-deploy warming verifies and reuses its complete generation', async () => {
  const worker = boot({ fetches: deployment('new') });
  await worker.activate();
  const pointer = await worker.pointer();
  worker.network.length = 0;
  await worker.warm();
  assert.deepEqual(await worker.pointer(), pointer);
  assert.deepEqual(worker.network.map(({ key }) => key), ['/', '/offline-assets.json']);
});

test('simultaneous warm and explicit refresh share one staged deployment', async () => {
  const worker = boot({ fetches: deployment('new') });
  const [_, answer] = await Promise.all([worker.warm(), worker.refresh()]);
  assert.deepEqual(answer, { ok: true });
  assert.equal(worker.network.filter(({ key }) => key === '/').length, 1);
  assert.equal(worker.stores.size, 2);
});

test('activation claims the page even when storage refuses staging', async () => {
  const worker = boot({ openFails: true, putFails: true });
  await worker.activate();
  assert.equal(worker.claimed.count, 1);
});

test('development modules refresh online and survive offline with the warmed shell', async () => {
  let online = true, moduleVersion = 'OLD';
  const worker = boot({ fetches: (url) => {
    if (!online) throw new TypeError('offline');
    return reply(url === '/' ? '<script src="/@vite/client"></script><script src="/src/main.jsx"></script>' : `${moduleVersion}:${url}`);
  } });
  await worker.warm(['/src/main.jsx', '/@vite/client', '/src/products/gym/GymApp.jsx']);
  moduleVersion = 'NEW';
  assert.equal((await worker.handle(`${ORIGIN}/src/main.jsx`)).body, 'NEW:/src/main.jsx');
  online = false;
  assert.equal((await worker.handle(`${ORIGIN}/src/main.jsx`)).body, 'NEW:/src/main.jsx');
  assert.match((await worker.handle(`${ORIGIN}/`, { mode: 'navigate' })).body, /\/src\/main.jsx/);
});

function chunk(modules, imports = [], dynamicImports = [], assets = [], css = []) {
  return { type: 'chunk', modules: Object.fromEntries(modules.map((name) => [`/web/src/${name}`, {}])), code: 'code', imports, dynamicImports,
    viteMetadata: { importedAssets: new Set(assets), importedCss: new Set(css) } };
}
test('precache follows the shell and room graph, excluding neural runtime and unrelated assets', () => {
  const bundle = {
    'assets/main.js': { ...chunk(['main.jsx'], [], ['assets/gym.js', 'assets/journal.js', 'assets/showcase.js']), isEntry: true },
    'assets/gym.js': chunk(['products/gym/GymApp.jsx'], [], [], [], ['assets/gym.css']),
    'assets/journal.js': chunk(['products/journal/JournalApp.jsx'], [], ['assets/neural.js']),
    'assets/neural.js': chunk(['products/journal/search/neural/neuralEmbedder.js'], [], [], ['assets/worker.js']),
    'assets/showcase.js': chunk(['showcase/Showcase.jsx']),
    'assets/gym.css': { type: 'asset', source: 'style' }, 'assets/worker.js': { type: 'asset', source: 'runtime' },
    'assets/runtime.wasm': { type: 'asset', source: new Uint8Array(25 * 1024 * 1024) },
    'assets/unrelated.png': { type: 'asset', source: 'image' }, 'fonts.css': { type: 'asset', source: 'fonts' },
    'fonts/a.woff2': { type: 'asset', source: 'font' }, 'index.html': { type: 'asset', source: 'shell' },
  };
  let manifest;
  offlineShell().generateBundle.call({ emitFile: (file) => { manifest = JSON.parse(file.source); } }, {}, bundle);
  assert.deepEqual(manifest, ['/assets/gym.css', '/assets/gym.js', '/assets/journal.js', '/assets/main.js']);
});

test('the build refuses a shell and room graph over the fixed precache budget', () => {
  const bundle = { 'assets/main.js': { ...chunk(['main.jsx']), isEntry: true, code: 'x'.repeat(PRECACHE_BUDGET) },
    'index.html': { type: 'asset', source: 'shell' } };
  assert.throws(() => offlineShell().generateBundle.call({ emitFile() { assert.fail('must refuse oversized manifest'); } }, {}, bundle),
    /precache 4194309 bytes exceeds 4194304-byte budget/);
});
