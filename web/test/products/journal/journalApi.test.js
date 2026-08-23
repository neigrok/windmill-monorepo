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

test('allPages — the whole shelf, with no ceiling to be wrong about', async () => {
  const pages = [{ day: '2026-08-03', body: 'slept badly' }, { day: '2026-08-04', body: 'better' }];
  serve(ok({ pages }));

  assert.deepEqual(await journalApi.allPages(), pages);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_BASE}/v1/journal/pages`);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/journal/pages',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('allPages — an empty corpus is an empty array, not an absent one', async () => {
  serve(ok({ pages: [] }));
  assert.deepEqual(await journalApi.allPages(), []);
});

test('range — the same endpoint, a window of the canvas rather than the whole of it', async () => {
  const pages = [{ day: '2026-07-01', body: 'a' }];
  serve(ok({ pages }));

  assert.deepEqual(await journalApi.range('2026-07-01', '2026-07-31'), pages);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/journal/pages?from=2026-07-01&to=2026-07-31',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('page — a day never written comes back null, and a written one comes back whole', async () => {
  serve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) });
  assert.equal(await journalApi.page('2026-01-01'), null);
  assert.equal(wireOf(calls[0]).path, '/v1/journal/page/2026-01-01');

  const written = { day: '2026-08-04', body: 'better', mood: 3, energy: 2 };
  serve(ok(written));
  assert.deepEqual(await journalApi.page('2026-08-04'), written);
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
