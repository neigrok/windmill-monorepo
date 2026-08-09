// The journal's reads, from the client's side. Two of them answer on the same endpoint and mean
// different things — `range` is a window of the canvas, `allPages` is the whole corpus — and the
// corpus read is the one three separate features depend on: search indexes it, the zoom draws a
// year out of it, the nudge reads a rhythm from it. Until this file, each of those three wrote the
// zero cursor and the ceiling out by hand, so "how much history does the journal have" had three
// answers that only happened to agree. It is one answer now, and this is what pins it.
//
// `range` carries the canvas's floor too: the walk back past the sixty-day window ends on a read
// with no floor under it, and that read is this same window read from the first day a date column
// will parse (pageStore.js BEGINNING).

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

// A write door's reply: a status and no body at all, which is what a 204 is.
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

// NO CURSOR AND NO CEILING, and that is the point. This rode the delta feed from the zero HLC with
// `limit=5000` until 2026-08-07, and the server clamps any `since` limit to 1000 — so past ~2.7
// years of daily pages a writer was searching and zooming an incomplete journal, missing an
// arbitrary scatter of days rather than the oldest ones, because that feed is ordered by stamp.
// `/pages` with no parameters is the backend's own whole-shelf read: every page, ascending by day.
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

// The envelope is the wire's, the array is the caller's — every consumer of this method wants the
// pages and none of them wants to know the reply had a shape.
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

// A day nobody wrote is not an error — the canvas draws a placeholder for it, so the absence has
// to arrive as a value the caller can hold.
test('page — a day never written comes back null, and a written one comes back whole', async () => {
  serve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) });
  assert.equal(await journalApi.page('2026-01-01'), null);
  assert.equal(wireOf(calls[0]).path, '/v1/journal/page/2026-01-01');

  const written = { day: '2026-08-04', body: 'better', mood: 3, energy: 2 };
  serve(ok(written));
  assert.deepEqual(await journalApi.page('2026-08-04'), written);
});

// THE PAGE DOOR IS ONE REQUEST. It was nine — the surface looped the pair door once per match, so a
// nine-match page cost nine round trips that could each fail alone and leave the page half faded on
// the next read. There is a route for the set; this is the test that it is the one being called.
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

// These four have nothing to read back, so until 2026-08-09 they awaited the response and returned
// whatever came — which means a 500 resolved exactly like a 204 and no caller could tell. The
// surface hides an echo the moment it is dismissed and puts it back if the server refused, and that
// decision is only implementable if the refusal actually arrives.
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
