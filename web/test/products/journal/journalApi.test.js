import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { JournalError, journalApi } from '../../../src/products/journal/journalApi.js';

const realFetch = global.fetch;
let calls = [];

function serve(answer) {
  calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return answer;
  };
}

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

function no(status) {
  return { ok: status < 400, status, json: async () => { throw new Error('no body'); } };
}

function wireOf({ url, options }) {
  const parsed = new URL(url);
  return {
    path: `${parsed.pathname}${parsed.search}`,
    method: options.method ?? 'GET',
    credentials: options.credentials,
    contentType: options.headers['content-type'],
    body: options.body,
  };
}

test.afterEach(() => { global.fetch = realFetch; calls = []; });

test('page and whole-corpus reads use the engine and make no REST request', async () => {
  const { syncSession } = await import('../../../src/platform/sync/session.js');
  const previous = syncSession.getSnapshot();
  const previousEngine = syncSession.engine;
  const snapshot = { drawn: [{ t: 'page', id: '2026-08-04', x: { body: 'better' }, f: { mood: [0], energy: [null], source: ['typed'] } }], notices: [], firstPullComplete: true };
  const engine = { observe: () => ({ getSnapshot: () => snapshot }), device: { activeReplica: {
    meta: { state: 'bound', account: 'A' }, deviceRows: () => ({}), confirmedRow: () => null,
  } } };
  syncSession.engine = engine; syncSession.publish({ engine, ready: true });
  global.fetch = () => assert.fail('local pages used REST');
  try {
    const pages = await journalApi.allPages();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].body, 'better');
    assert.equal(pages[0].mood, 0);
    assert.deepEqual(await journalApi.page('2026-08-04'), pages[0]);
    assert.equal(await journalApi.page('2026-01-01'), null);
  } finally { syncSession.engine = previousEngine; syncSession.publish(previous); }
});

test('dismissEchoPage — the whole page retires on one call, not one per match', async () => {
  serve(no(204));
  await journalApi.dismissEchoPage('2026-08-09');

  assert.equal(calls.length, 1);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/journal/echoes/2026-08-09/dismiss',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('dismissEcho — one pairing, keyed on both days so it survives re-derivation', async () => {
  serve(no(204));
  await journalApi.dismissEcho('2026-08-09', '2024-01-01');
  assert.equal(wireOf(calls[0]).path, '/v1/journal/echoes/2026-08-09/2024-01-01/dismiss');
  assert.equal(wireOf(calls[0]).method, 'POST');
});

test('echoUseful — the positive answer, on the pair the reader gave it about', async () => {
  serve(no(204));
  await journalApi.echoUseful('2026-08-09', '2024-01-01');
  assert.equal(wireOf(calls[0]).path, '/v1/journal/echoes/2026-08-09/2024-01-01/useful');
  assert.equal(wireOf(calls[0]).method, 'POST');
});

test('the echo write doors reject when the server refused, rather than resolving on a 500', async () => {
  const doors = [
    () => journalApi.dismissEcho('2026-08-09', '2024-01-01'),
    () => journalApi.dismissEchoPage('2026-08-09'),
    () => journalApi.echoUseful('2026-08-09', '2024-01-01'),
    () => journalApi.dismissEchoOffer('2026-08-09'),
    () => journalApi.echoOpened('2026-08-09', '2024-01-01'),
  ];
  for (const door of doors) {
    serve(no(500));
    await assert.rejects(door, (error) => error instanceof JournalError && error.status === 500);
  }
});
