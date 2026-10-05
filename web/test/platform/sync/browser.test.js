import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server, browser, origin;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryPath = fileURLToPath(new URL('../../../../packages/api-contract/sync/probe.registry.json', import.meta.url));
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-sync-test`, plugins: [{ name: 'sync-test-page', configureServer(server) {
    server.middlewares.use('/sync-test', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Sync engine test</title>'); });
  } }], optimizeDeps: { include: ['@noble/hashes/sha256', '@noble/hashes/utils'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

async function open(context, name) {
  const page = await context.newPage();
  await page.goto(`${origin}/sync-test`);
  await page.evaluate(async ({ name, registryPath }) => {
    const { BrowserSyncEngine } = await import('/src/platform/sync/engine.js');
    const { Registry } = await import('/src/platform/sync/core/registry.js');
    const probe = await (await fetch(`/@fs${registryPath}`)).json();
    window.requests = 0; window.failures = []; window.events = [];
    window.engine = await BrowserSyncEngine.open({ name, registry: new Registry(probe),
      transport: { request() { window.requests++; throw new Error('offline'); }, openLive() { throw new Error('offline'); } },
      telemetry: { failure: (name) => window.failures.push(name), event: () => {} } });
    engine.onEvent((event) => events.push(event));
    window.observation = engine.observe('self/probe');
    await engine.start();
  }, { name, registryPath });
  return page;
}
async function leader(pages) {
  for (let i = 0; i < 100; i++) {
    const states = await Promise.all(pages.map((page) => page.evaluate(() => !!engine.leader)));
    if (states.filter(Boolean).length === 1) return states.indexOf(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('exactly one leader was not elected');
}

const gesture = (page, id) => page.evaluate((id) => engine.commit('self/probe', [{ op: 'create', t: 'card', id, f: { title: 'private' } }], { hold: true }), id);

async function accountTransport(page) {
  await page.evaluate(() => {
    engine.setOnline(false);
    window.sentRequests = [];
    window.retryAfterMs = 0;
    window.answer = (response) => {
      const wall = Date.now(), mono = Math.floor(performance.now());
      return { response, timing: { send: { wall, mono, boot: 'browser' }, recv: { wall, mono, boot: 'browser' } } };
    };
    window.hello = () => answer({ status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: Date.now(), schema: 1,
      minSchema: 1, holdsRecords: { probe: false } } });
    engine.transport.request = async (endpoint, request) => {
      sentRequests.push({ endpoint, at: Date.now(), intents: request?.intents });
      if (endpoint === 'hello') return hello();
      if (endpoint === 'push') {
        if (retryAfterMs) return answer({ status: 503, body: { retryAfterMs } });
        return answer({ status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: Date.now(), lastN: request.intents.at(-1).n,
          results: request.intents.map((intent) => ({ n: intent.n, s: 'ok', seq: 1 })) } });
      }
      throw new Error('pull unavailable');
    };
  });
}

async function signedTabs(context, name) {
  const pages = await Promise.all([open(context, name), open(context, name)]);
  await Promise.all(pages.map(accountTransport));
  assert.equal((await pages[0].evaluate(() => engine.signIn('A'))).complete, true);
  await pages[1].waitForFunction(() => engine.getSnapshot().state === 'bound');
  await leader(pages);
  return pages;
}

test('Chromium: two real tabs elect one leader, fan out durable observations, hand off on close and renderer crash', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const pages = await Promise.all([open(context, 'tabs'), open(context, 'tabs')]);
    const first = await leader(pages), second = 1 - first;
    await gesture(pages[second], 'card0001');
    await pages[first].waitForFunction(() => observation.getSnapshot().drawn.length === 1);
    assert.equal(await pages[first].evaluate(() => engine.device.activeReplica.outbox[0].state), 'held');
    const held = await pages[first].evaluate(() => navigator.locks.query());
    assert.equal(held.held.filter((lock) => lock.name.startsWith('wm-sync:')).length, 1);
    await pages[first].close();
    await pages[second].waitForFunction(() => engine.leader);
    const replacement = await open(context, 'tabs');
    await replacement.waitForFunction(() => !engine.leader);
    const cdp = await context.newCDPSession(pages[second]);
    const crash = pages[second].waitForEvent('crash');
    cdp.send('Page.crash').catch(() => {}); await crash;
    await replacement.waitForFunction(() => engine.leader);
    assert.equal(await replacement.evaluate(() => observation.getSnapshot().drawn.length), 1);
    assert.equal(await replacement.evaluate(() => requests), 0);
    await pages[second].close();
  } finally { await context.close(); }
});

test('Chromium: killing a tab inside an IndexedDB commit preserves the previous pointer, rows, clock and outbox', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const writer = await open(context, 'atomic');
    await gesture(writer, 'card0001');
    const reader = await open(context, 'atomic');
    const before = await reader.evaluate(async () => (await engine.store.read()).device.toJSON());
    await writer.evaluate(() => {
      window.stalled = false;
      engine.store.transact((device) => {
        device.activeReplica.meta.hlc.ms = 999999;
        device.activeReplica.deviceRows('probe').rack = 'uncommitted';
        device.activeReplica.putConfirmed('self/probe', { t: 'card', id: 'card0002', seq: 1, rc: 1, ru: 1, born: '1:0:srv', life: ['alive', '1:0:srv'] });
        device.activeReplica.outbox = [];
      }, { beforeCommit: ({ transaction }) => {
        window.stalled = true;
        const table = transaction.objectStore('records');
        const keepAlive = () => { table.get('["head"]').onsuccess = keepAlive; };
        keepAlive();
      } }).catch(() => {});
    });
    await writer.waitForFunction(() => stalled);
    const cdp = await context.newCDPSession(writer);
    const crash = writer.waitForEvent('crash');
    cdp.send('Page.crash').catch(() => {}); await crash;
    assert.deepEqual(await reader.evaluate(async () => (await engine.store.read()).device.toJSON()), before);
    await writer.close();
    await reader.evaluate(() => engine.close());
    const reloaded = await open(context, 'atomic');
    assert.equal(await reloaded.evaluate(() => observation.getSnapshot().drawn.length), 1);
    assert.equal(await reloaded.evaluate(() => requests), 0);
  } finally { await context.close(); }
});

test('Chromium: scoped writer latency and pointer swaps stay independent of cached row count', async (t) => {
  const context = await browser.newContext();
  try {
    const page = await open(context, 'latency');
    const measurements = await page.evaluate(async () => {
      const store = engine.store;
      await store.transact((device) => {
        for (let n = 0; n < 4096; n++) device.activeReplica.putConfirmed('tree/b_00000001', { t: 'tag', id: `tag${n}`, seq: 1 });
      });
      const control = await store.transact((device) => { device.activeReplica.meta.authPaused = true; });
      const scoped = await store.transact((device) => { device.activeReplica.confirmedRows('tree/b_00000001')[0].seq = 2; },
        { scopes: [{ scope: 'tree/b_00000001', keys: ['["tag","tag0"]'] }] });
      await store.transact((device) => { device.activeReplica.staging['tree/b_00000001'] = { digest: 'replacement', rows: { replacement: { t: 'tag', id: 'replacement', seq: 3 } } }; });
      const swap = await store.transact((device) => {
        device.activeReplica.confirmed['tree/b_00000001'] = device.activeReplica.staging['tree/b_00000001'].rows;
        delete device.activeReplica.staging['tree/b_00000001'];
      });
      const read = await store.read(['tree/b_00000001']);
      return { control: control.measurement, scoped: scoped.measurement, swap: swap.measurement, rows: read.device.activeReplica.confirmedRows('tree/b_00000001') };
    });
    assert.equal(measurements.control.rowReads, 0);
    assert.equal(measurements.control.rowWrites, 0);
    assert.equal(measurements.scoped.rowReads, 1);
    assert.equal(measurements.scoped.rowWrites, 1);
    assert.equal(measurements.swap.rowReads, 0);
    assert.equal(measurements.swap.rowWrites, 0);
    assert.deepEqual(measurements.rows, [{ t: 'tag', id: 'replacement', seq: 3 }]);
    for (const measurement of [measurements.control, measurements.scoped, measurements.swap]) assert.ok(Number.isFinite(measurement.writerMs));
    t.diagnostic(JSON.stringify({ cacheRows: 4096, ...measurements, rows: 1 }));
  } finally { await context.close(); }
});

test('Chromium: the engine reopens IndexedDB while the browser is offline without a network request', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'offline-browser');
    await gesture(page, 'card0001');
    const before = await page.evaluate(() => observation.getSnapshot().drawn);
    await context.setOffline(true);
    const after = await page.evaluate(async () => {
      const Constructor = engine.constructor, registry = engine.registry, transport = engine.transport;
      engine.close();
      window.engine = await Constructor.open({ name: 'offline-browser', registry, transport, telemetry: { event() {}, failure() {} } });
      window.observation = engine.observe('self/probe');
      await engine.start();
      return { rows: observation.getSnapshot().drawn, online: engine.online, requests };
    });
    assert.deepEqual(after.rows, before);
    assert.equal(after.online, false);
    assert.equal(after.requests, 0);
  } finally { await context.close(); }
});

test('Chromium: a real bfcache restore reopens the engine and keeps existing observations writable', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'bfcache-restore');
    const cdp = await context.newCDPSession(page), reasons = [];
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (event) => reasons.push(event));
    await gesture(page, 'card0001');
    await page.evaluate(() => {
      window.originalEngine = engine;
      window.originalObservation = observation;
      window.restoredFromCache = false;
      window.observed = [];
      observation.subscribe(() => observed.push(observation.getSnapshot().drawn.map((row) => row.id)));
      window.addEventListener('pageshow', (event) => { restoredFromCache = event.persisted; });
    });
    await page.goto(`${origin}/sync-test/away`, { waitUntil: 'commit', timeout: 5000 });
    await page.goBack({ waitUntil: 'commit', timeout: 5000 });
    try { await page.waitForFunction(() => window.restoredFromCache && !engine.closed && events.some(({ event }) => event === 'restored'), null, { timeout: 6000 }); }
    catch (error) {
      assert.fail(JSON.stringify(reasons) + JSON.stringify(await page.evaluate(() => ({ persisted: window.restoredFromCache,
        closed: window.engine?.closed, events: window.events,
        reason: performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON() }))) + ': ' + error.message);
    }
    assert.equal(await page.evaluate(() => engine === originalEngine && observation === originalObservation), true);
    assert.deepEqual(await page.evaluate(() => observation.getSnapshot().drawn.map((row) => row.id)), ['card0001']);
    const held = await page.evaluate(() => navigator.locks.query());
    assert.equal(held.held.filter((lock) => lock.name.startsWith('wm-sync:')).length, 1);
    await gesture(page, 'card0002');
    assert.deepEqual(await page.evaluate(() => observed.at(-1)), ['card0001', 'card0002']);
    assert.equal(await page.evaluate(() => engine.store.closed), false);
  } finally { await context.close(); }
});

test('Chromium: persisted lifecycle events close and reopen real Web Locks and IndexedDB', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'persisted-lifecycle');
    await gesture(page, 'card0001');
    const result = await page.evaluate(async () => {
      const store = engine.store, coordination = engine.coordination;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      const stopped = engine.closed && store.closed && coordination.closed;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await engine.restoring;
      return { stopped, closed: engine.closed, storageOpen: !engine.store.closed,
        coordinationOpen: !engine.coordination.closed, rows: observation.getSnapshot().drawn.map((row) => row.id), events };
    });
    assert.deepEqual(result, { stopped: true, closed: false, storageOpen: true, coordinationOpen: true,
      rows: ['card0001'], events: [{ event: 'suspended' }, { event: 'restored' }] });
    await gesture(page, 'card0002');
    assert.equal(await page.evaluate(() => observation.getSnapshot().drawn.length), 2);
  } finally { await context.close(); }
});

test('Chromium: default telemetry beacons use intake-compatible names and bounded content-free properties', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'beacon');
    let delivered;
    const delivery = new Promise((resolve) => { delivered = resolve; });
    await page.route('**/v1/events', async (route) => {
      delivered(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":20}' });
    });
    await page.evaluate(async () => {
      const { syncTelemetry } = await import('/src/platform/sync/telemetry.js');
      const telemetry = syncTelemetry();
      for (let i = 0; i < 20; i++) telemetry.event('sync-writer', { durationMs: 80000, queueMs: 1, body: 'private', account: 'private' });
    });
    const batch = await Promise.race([delivery, new Promise((_, reject) => setTimeout(() => reject(new Error('beacon delivery stalled')), 5000).unref())]);
    assert.equal(batch.events.length, 20);
    for (const event of batch.events) {
      assert.equal(event.name, 'sync_writer');
      assert.deepEqual(event.props, { durationMs: 60000, queueMs: 1 });
    }
  } finally { await context.close(); }
});

test('Chromium: a replica transition committed before a leader crash is announced once by the surviving tab', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const pages = await Promise.all([open(context, 'transition-crash'), open(context, 'transition-crash')]);
    const owner = await leader(pages), survivor = 1 - owner;
    const previous = await pages[survivor].evaluate(() => engine.activeReplica());
    const replica = 'rp_99999999999999999999999999999999';
    await pages[owner].evaluate((replica) => engine.store.transact((device) => { device.activeReplica.meta.replica = replica; }), replica);
    const cdp = await context.newCDPSession(pages[owner]);
    const crash = pages[owner].waitForEvent('crash');
    cdp.send('Page.crash').catch(() => {}); await crash;
    await pages[survivor].waitForFunction((replica) => engine.leader && engine.activeReplica() === replica, replica);
    assert.deepEqual(await pages[survivor].evaluate(() => events), [{ event: 'activeReplicaChanged', previous, replica }]);
    assert.equal(await pages[survivor].evaluate(() => engine.getSnapshot().replica), replica);
    await pages[owner].close();
  } finally { await context.close(); }
});

test('Chromium: a delayed hello cannot reverse a completed sign-out in another tab', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const [delayed, owner] = await signedTabs(context, 'peer-auth-generation');
    await delayed.evaluate(() => {
      engine.transport.request = () => new Promise((resolve) => { window.resolveHello = resolve; });
      window.pendingSignIn = engine.signIn('A');
    });
    await delayed.waitForFunction(() => Boolean(window.resolveHello));
    const question = await owner.evaluate(() => engine.beginSignOut());
    assert.equal((await owner.evaluate((counted) => engine.finishSignOut({ choice: 'keep', counted }), question.counted)).complete, true);
    const result = await delayed.evaluate(async () => { resolveHello(hello()); return pendingSignIn; });
    assert.deepEqual(result, { complete: false, superseded: true });
    assert.equal(await delayed.evaluate(async () => (await engine.store.read()).device.activeReplica.meta.state), 'anon');
    await owner.evaluate(() => engine.close());
    const reloaded = await open(context, 'peer-auth-generation');
    assert.equal(await reloaded.evaluate(() => engine.getSnapshot().state), 'anon');
  } finally { await context.close(); }
});

test('Chromium: a follower sign-out pauses numbering across leader handoff, Cancel resumes and owner crash releases it', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const pages = await signedTabs(context, 'shared-signout');
    const first = await leader(pages), owner = 1 - first;
    await pages[owner].evaluate(() => engine.beginSignOut());
    await pages[first].waitForFunction(() => engine.signingOut);
    await pages[owner].evaluate(() => engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private' } }]));
    await pages[first].evaluate(async () => { engine.setOnline(true); await engine.send(); });
    assert.equal(await pages[first].evaluate(() => sentRequests.filter((request) => request.endpoint === 'push').length), 0);
    await pages[first].close();
    await pages[owner].waitForFunction(() => engine.leader);
    await pages[owner].evaluate(async () => { engine.setOnline(true); await engine.send(); });
    assert.equal(await pages[owner].evaluate(() => sentRequests.filter((request) => request.endpoint === 'push').length), 0);
    assert.equal(await pages[owner].evaluate(() => engine.device.activeReplica.outbox[0].n), undefined);
    await pages[owner].evaluate(() => engine.cancelSignOut());
    await pages[owner].waitForFunction(() => sentRequests.some((request) => request.endpoint === 'push'));

    const follower = await open(context, 'shared-signout');
    await accountTransport(follower);
    await follower.waitForFunction(() => !engine.leader && engine.getSnapshot().state === 'bound');
    await follower.evaluate(() => engine.beginSignOut());
    await pages[owner].waitForFunction(() => engine.signingOut);
    await follower.evaluate(() => engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0002', f: { title: 'private' } }]));
    const before = await pages[owner].evaluate(() => sentRequests.filter((request) => request.endpoint === 'push').length);
    const cdp = await context.newCDPSession(follower);
    const crash = follower.waitForEvent('crash');
    cdp.send('Page.crash').catch(() => {}); await crash;
    await pages[owner].waitForFunction((before) => !engine.signingOut && sentRequests.filter((request) => request.endpoint === 'push').length > before, before);
    assert.equal(await pages[owner].evaluate(async () => (await engine.store.read()).device.meta.signOut), undefined);
    await follower.close();
  } finally { await context.close(); }
});

test('Chromium: an idle leader recovers a committed outbox after writer crash without broadcasts and respects retry floors', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const pages = await signedTabs(context, 'durable-outbox-reconcile');
    const first = await leader(pages), writer = 1 - first;
    await pages[first].evaluate(async () => { engine.setOnline(true); await engine.send(); });
    await pages[first].waitForFunction(() => !engine.sending);
    const floor = await pages[writer].evaluate(async () => {
      const floor = Date.now() + 2200;
      engine.coordination.post = () => {};
      await engine.write(null, (device) => { device.activeReplica.meta.pushRetryAt = floor; });
      await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private' } }]);
      return floor;
    });
    const cdp = await context.newCDPSession(pages[writer]);
    const crash = pages[writer].waitForEvent('crash');
    cdp.send('Page.crash').catch(() => {}); await crash;
    await pages[first].waitForFunction(() => sentRequests.some((request) => request.endpoint === 'push'));
    const pushes = await pages[first].evaluate(() => sentRequests.filter((request) => request.endpoint === 'push'));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].at >= floor, `push ${pushes[0].at} preceded retry floor ${floor}`);
    assert.equal(pushes[0].intents[0].d[0].id, 'card0001');
    await pages[writer].close();
  } finally { await context.close(); }
});

test('Chromium: a durable commit resolves when versionchange closes IndexedDB before publication', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const writer = await open(context, 'commit-versionchange');
    const result = await writer.evaluate(async () => {
      const refresh = engine.refresh.bind(engine);
      engine.refresh = async (...args) => {
        engine.store.database.onversionchange();
        return refresh(...args);
      };
      return engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private' } }], { hold: true });
    });
    assert.equal(result.localIds.length, 1);
    assert.equal(await writer.evaluate(() => failures.includes('storage')), true);
    await writer.evaluate(() => engine.close());
    const reader = await open(context, 'commit-versionchange');
    assert.equal(await reader.evaluate(() => observation.getSnapshot().drawn[0].id), 'card0001');
    assert.equal(await reader.evaluate(() => engine.device.activeReplica.outbox[0].localId), result.localIds[0]);
  } finally { await context.close(); }
});

test('Chromium: a persisted 426 blocks hello after a missed broadcast and reload, and a new build may retry', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const [source, peer] = await Promise.all([open(context, 'persisted-upgrade'), open(context, 'persisted-upgrade')]);
    await Promise.all([accountTransport(source), accountTransport(peer)]);
    await source.evaluate(() => {
      engine.coordination.post = () => {};
      engine.transport.request = async () => answer({ status: 426 });
    });
    assert.deepEqual(await source.evaluate(() => engine.signIn('A')), { complete: false, upgradeRequired: true });
    const peerResult = await peer.evaluate(() => engine.signIn('A'));
    assert.deepEqual(peerResult, { complete: false, upgradeRequired: true });
    assert.equal(await peer.evaluate(() => sentRequests.length), 0);
    await peer.evaluate(() => engine.close());
    const reloaded = await open(context, 'persisted-upgrade');
    assert.equal(await reloaded.evaluate(() => engine.getSnapshot().upgradeRequired), true);
    await accountTransport(reloaded);
    assert.deepEqual(await reloaded.evaluate(() => engine.signIn('A')), { complete: false, upgradeRequired: true });
    assert.equal(await reloaded.evaluate(() => sentRequests.length), 0);
    const upgraded = await reloaded.evaluate(async () => {
      const Constructor = engine.constructor, registry = engine.registry, transport = engine.transport;
      engine.close();
      window.engine = await Constructor.open({ name: 'persisted-upgrade', appVersion: '2', registry, transport,
        telemetry: { event() {}, failure() {} } });
      return engine.signIn('A');
    });
    assert.equal(upgraded.complete, true);
    assert.equal(await reloaded.evaluate(() => sentRequests.filter((request) => request.endpoint === 'hello').length), 1);
  } finally { await context.close(); }
});

for (const order of ['pull-before-result', 'result-before-pull']) test(`Chromium: journal claim preserves the newer edit through ${order}`, async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const name = `journal-claim-${order}`;
    const page = await open(context, name);
    await page.evaluate(async ({ name, order }) => {
      const Constructor = engine.constructor;
      engine.close();
      const { registry } = await import('/src/platform/sync/schema.js');
      const { savePage, watchClaims, onSyncResult } = await import('/src/products/journal/pages.js');
      const { pendingClaimWork } = await import('/src/platform/sync/journal/client.js');
      const { nextPush } = await import('/src/platform/sync/client/sender.js');
      const { Cursor } = await import('/src/platform/sync/core/wire.js');
      const { scopeDigest } = await import('/src/platform/sync/core/digest.js');
      const scope = 'self/journal', day = '2026-10-01';
      const doc = (body) => ({ day, body, mood: 0, energy: null, source: 'typed' });
      const timing = () => {
        const wall = Date.now(), mono = Math.floor(performance.now());
        return { send: { wall, mono, boot: 'journal-browser' }, recv: { wall, mono, boot: 'journal-browser' } };
      };
      window.sentSaves = [];
      const transport = { async request(endpoint, request) {
        if (endpoint === 'hello') return { response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: Date.now(),
          schema: registry.version, minSchema: registry.version, holdsRecords: { gym: false, journal: false } } }, timing: timing() };
        if (endpoint === 'push') {
          sentSaves.push(...request.intents.filter((intent) => intent.cmd?.name === 'journal.savePage').map((intent) => intent.cmd.args));
          return { response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: Date.now(),
            lastN: request.intents.at(-1).n, results: request.intents.map((intent) => ({ n: intent.n, s: 'ok', seq: 2 })) } }, timing: timing() };
        }
        throw new Error('pull unavailable');
      }, openLive() { throw new Error('offline live'); } };
      const options = { name, registry, transport, pendingDeviceWork: pendingClaimWork, onPushResult: onSyncResult,
        telemetry: { failure: (name) => failures.push(name), event() {} } };
      window.engine = await Constructor.open(options);
      engine.setOnline(false);
      watchClaims(engine);
      await engine.start();
      await savePage(engine, doc('frozen contribution'));
      await engine.signIn('A');
      const request = await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
      await savePage(engine, doc('newer edit'));
      const row = { t: 'page', id: day, seq: 1, rc: 1000, ru: 1000, f: {
        mood: [0, '1000:0:srv'], energy: [null, '1000:0:srv'], source: ['typed', '1000:0:srv'],
        documentStamp: [{ ms: 1000, counter: 0, actor: 'srv' }, '1000:0:srv'],
      }, x: { body: { text: 'frozen contribution', rev: 1, merged: false } } };
      const pull = () => engine.storePage(engine.device.activeReplica.storageHandle, null, { scope, kind: 'rows', rows: [row],
        seq: 1, more: false, cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 1 }), digest: scopeDigest([row]) });
      const result = () => engine.pushResults(engine.device.activeReplica.storageHandle, request, { status: 200, body: { as: 'A',
        epoch: 'ep-1', serverTime: Date.now(), lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }] } }, timing());
      if (order === 'pull-before-result') {
        await pull();
        window.receiptBeforeResult = Object.values(engine.device.activeReplica.deviceRows('journal')).find((row) => row?.claimId).claimResult;
        await result();
      } else {
        await result();
        const pending = Object.values((await engine.store.read()).device.activeReplica.deviceRows('journal')).find((row) => row?.claimId);
        window.persistedReceipt = pending.claimResult;
        engine.close();
        window.engine = await Constructor.open(options);
        engine.setOnline(false);
        watchClaims(engine);
        await engine.start();
        await pull();
      }
    }, { name, order });
    await page.waitForFunction(() => engine.device.activeReplica.entries('self/journal').some((entry) => entry.intent.cmd?.name === 'journal.savePage'));
    if (order === 'pull-before-result') assert.equal(await page.evaluate(() => receiptBeforeResult), null);
    else assert.deepEqual(await page.evaluate(() => persistedReceipt), { seq: 1, epoch: 'ep-1' });
    assert.equal(await page.evaluate(() => engine.device.activeReplica.entries('self/journal').find((entry) => entry.intent.cmd?.name === 'journal.savePage').intent.cmd.args.body), 'newer edit');
    await page.waitForFunction(() => engine.leader);
    await page.evaluate(async () => { engine.setOnline(true); await engine.send(); });
    await page.waitForFunction(() => sentSaves.length > 0);
    assert.equal(await page.evaluate(() => sentSaves[0].body), 'newer edit');
    assert.equal(await page.evaluate(() => Object.values(engine.device.activeReplica.deviceRows('journal')).some((row) => row?.claimId)), false);
  } finally { await context.close(); }
});
