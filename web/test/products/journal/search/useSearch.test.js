import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook, settle } from '../../gym/harness.mjs';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { savePage } from '../../../../src/products/journal/pages.js';
import { MeaningModel, useSearch } from '../../../../src/products/journal/search/useSearch.js';
import { environment } from '../../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';

const day = '2026-09-27';
const page = (body) => ({ day, body, mood: null, energy: null, source: 'typed' });

// A signed-out browser whose journal is a real engine's, opened as the shell opens it, with a server behind it.
async function journalSeat(t) {
  const env = environment();
  env.timers.time = Date.parse(`${day}T12:00:00Z`);
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: {} } });
  env.options.registry = journalRegistry;
  env.transport.request = async (endpoint, request) => {
    const at = env.timers.time;
    let response;
    if (endpoint === 'hello') response = hello({ state, registry: journalRegistry, account: env.transport.account, serverTime: at });
    else {
      const result = (endpoint === 'push' ? push : pull)({ state, registry: journalRegistry, product: journalProduct,
        account: env.transport.account, request, serverNow: at });
      state = result.state; response = result.response;
    }
    return { response, timing: { send: { wall: at, mono: at, boot: 'test' }, recv: { wall: at, mono: at, boot: 'test' } } };
  };
  const engine = await BrowserSyncEngine.open(env.options);
  await engine.start();
  const shell = { engine: syncSession.engine, snapshot: syncSession.snapshot };
  syncSession.engine = engine;
  syncSession.snapshot = { engine, ready: true, signedIn: false, online: true, error: false };
  t.after(() => { Object.assign(syncSession, shell); engine.close(); });
  return engine;
}

// The browser's Worker, as the model's worker answers: `up()` and `fail()` say how the model came up, `broken()` is a
// worker that never started, and every text is embedded by the meaning its words share.
function modelWorkers(t) {
  const made = [];
  const meanings = [['sea', 'ocean'], ['dusk', 'evening'], ['calm', 'peaceful'], ['deadline', 'anxious']];
  const vector = (text) => meanings.map((words) => (words.some((word) => text.toLowerCase().includes(word)) ? 1 : 0));
  globalThis.Worker = class {
    constructor() { this.terminated = false; made.push(this); }
    postMessage({ id, texts }) { queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, vectors: texts.map(vector) } })); }
    terminate() { this.terminated = true; }
    up() { this.onmessage({ data: { ready: true } }); }
    fail() { this.onmessage({ data: { failed: true, error: 'no model at /models/' } }); }
    broken() { this.onerror({ message: 'the worker script did not load' }); }
  };
  t.after(() => { delete globalThis.Worker; });
  return made;
}

// What one opening's meaning tells: its events, its Sentry reports with whether the stack holds the worker's frames, and
// how often it recorded a first use. It reads the engine's connection unless `connection` says otherwise.
function telling({ connection = null, happened = false, serviceWorker = null } = {}) {
  const told = { events: [], reports: [], recorded: 0 };
  const open = () => new MeaningModel({ ...(connection ? { connection } : {}), serviceWorker,
    firstUse: { happened: () => happened, record: () => { told.recorded += 1; } },
    track: (name, props) => told.events.push([name, props]),
    report: (kind, operation, stack, route, tags) => told.reports.push([kind, operation, /neuralEmbedder\.js:\d+:\d+/.test(stack), route, tags]) });
  return { told, open };
}

test('one opening of search brings meaning up once, however often the pages change while it is open', async (t) => {
  const engine = await journalSeat(t);
  const workers = modelWorkers(t);
  const { told, open } = telling();
  let active = true;
  const run = renderHook(t, () => useSearch(active, null, open));
  await settle(8);
  workers[0].up();
  await settle(8);
  for (const body of ['first words', 'the deadline made me anxious', 'I walked along the sea at dusk and felt calm.']) {
    await savePage(engine, page(body));
    run.redraw();
    await settle(8);
  }
  const hits = await run.log.search('peaceful evening by the ocean');
  const opened = { workers: workers.length, mode: run.log.mode, hits: hits.map(({ day: hit, text }) => [hit, text]), ...structuredClone(told) };

  active = false;
  run.redraw();
  await settle(8);
  active = true;
  run.redraw();
  await settle(8);
  workers[1].up();
  await settle(8);
  assert.deepEqual({ opened, closed: workers[0].terminated, reopened: { workers: workers.length, events: told.events.length } }, {
    opened: { workers: 1, mode: 'neural', hits: [[day, 'I walked along the sea at dusk and felt calm.']],
      events: [['journal_search_meaning', { outcome: 'ready' }]], reports: [], recorded: 1 },
    closed: true,
    reopened: { workers: 2, events: 2 },
  });
});

test('offline is the engine\'s word: a server it cannot reach is no fault, and before a first use search says it needs one', async (t) => {
  const engine = await journalSeat(t);
  engine.answered(false);
  const workers = modelWorkers(t);
  const { told, open } = telling();
  const run = renderHook(t, () => useSearch(true, null, open));
  await settle(8);
  workers[0].broken();
  await settle(8);
  assert.deepEqual({ connection: engine.getSnapshot().connection, needsConnection: run.log.needsConnection, mode: run.log.mode, ...told }, {
    connection: 'unreachable', needsConnection: true, mode: 'lexical',
    events: [['journal_search_meaning', { outcome: 'needs_connection' }]], reports: [], recorded: 0,
  });
});

test('offline, a browser that had meaning and keeps it no longer answers in words, and says nothing of a first time', async (t) => {
  await journalSeat(t);
  const workers = modelWorkers(t);
  const { told, open } = telling({ connection: () => 'offline', happened: true });
  const run = renderHook(t, () => useSearch(true, null, open));
  await settle(8);
  workers[0].broken();
  await settle(8);
  assert.deepEqual({ needsConnection: run.log.needsConnection, mode: run.log.mode, ready: run.log.ready, ...told }, {
    needsConnection: false, mode: 'lexical', ready: true,
    events: [['journal_search_meaning', { outcome: 'unkept' }]], reports: [], recorded: 0,
  });
});

test('online, a model that does not come up is a fault reported with its step and the stack it failed on', async (t) => {
  await journalSeat(t);
  const workers = modelWorkers(t);
  const { told, open } = telling();
  const run = renderHook(t, () => useSearch(true, null, open));
  await settle(8);
  workers[0].fail();
  await settle(8);
  assert.deepEqual({ needsConnection: run.log.needsConnection, mode: run.log.mode, ...told }, {
    needsConnection: false, mode: 'lexical',
    events: [['journal_search_meaning', { outcome: 'failed' }]],
    reports: [['journal', 'journal-search-meaning', true, '/journal', { step: 'model' }]], recorded: 0,
  });
});

test('the service worker\'s word that it could not keep the weights is told once an opening, and not after it closes', async (t) => {
  await journalSeat(t);
  const workers = modelWorkers(t);
  const serviceWorker = new EventTarget();
  const said = () => serviceWorker.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'model-not-kept' } }));
  const { told, open } = telling({ serviceWorker });
  let active = true;
  const run = renderHook(t, () => useSearch(active, null, open));
  await settle(8);
  said();
  workers[0].up();
  said();
  await settle(8);
  active = false;
  run.redraw();
  said();
  await settle(8);
  assert.deepEqual(told.events, [['journal_search_meaning', { outcome: 'cache_refused' }], ['journal_search_meaning', { outcome: 'ready' }]]);
});
