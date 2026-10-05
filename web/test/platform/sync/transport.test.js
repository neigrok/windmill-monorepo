import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpTransport, LiveChannel } from '../../../src/platform/sync/transport.js';
import { syncTelemetry } from '../../../src/platform/sync/telemetry.js';
import { FakeTimers, tick } from './fakes.js';

test('HTTP carriers use schema v4, credentials, canonical JSON and bounded timeout', async () => {
  const timers = new FakeTimers(), requests = [];
  const transport = new HttpTransport({ schema: 4, base: 'https://example.test', timers,
    reading: () => ({ wall: timers.time, mono: timers.time, boot: '1' }),
    fetch: async (url, options) => { requests.push({ url, options }); return new Response('{"serverTime":1000,"epoch":"e","as":null}', { status: 200 }); } });
  const out = await transport.request('pull', { z: 1, a: 'secret' });
  assert.equal(requests[0].url, 'https://example.test/v1/sync/pull');
  assert.equal(requests[0].options.headers['Sync-Schema'], '4');
  assert.equal(requests[0].options.body, '{"a":"secret","z":1}');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(out.response.status, 200);
  assert.deepEqual(out.timing, { send: { wall: 1000, mono: 1000, boot: '1' }, recv: { wall: 1000, mono: 1000, boot: '1' } });
  assert.equal(timers.tasks.size, 0);
});

test('timeout and leadership cancellation abort HTTP; raw error messages never reach telemetry', async () => {
  const timers = new FakeTimers(); let aborted = 0;
  const transport = new HttpTransport({ schema: 4, timers, reading: () => ({ wall: 0, mono: 0, boot: '1' }),
    fetch: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted++; reject(new DOMException('secret token', 'AbortError'));
    })) });
  const request = transport.request('hello');
  timers.advance(60_000);
  await assert.rejects(request, { name: 'AbortError' });
  const controller = new AbortController();
  const second = transport.request('hello', undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(aborted, 2);
  assert.equal(timers.tasks.size, 0);
});

test('live schema query, subscription deltas, ping/pong timeout and reopen use a separate backoff', async () => {
  const timers = new FakeTimers(), sockets = [], urls = [], frames = [], failures = [];
  const transport = new HttpTransport({ schema: 4, base: '', origin: 'https://example.test',
    socket: (url) => {
      urls.push(url);
      const socket = { readyState: 0, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.readyState = 3; } };
      sockets.push(socket); return socket;
    } });
  let reconnects = 0;
  const live = new LiveChannel({ transport, timers, now: () => timers.time, draw: () => 100,
    onFrame: (frame) => frames.push(frame), onReconnect: () => reconnects++, onFailure: (failure) => failures.push(failure) });
  live.setScopes(['self/journal']); live.start();
  assert.equal(urls[0], 'wss://example.test/v1/sync/live?schema=4');
  sockets[0].readyState = 1; sockets[0].onopen();
  assert.deepEqual(sockets[0].sent, [{ op: 'sub', scopes: ['self/journal'] }]);
  live.setScopes(['self/gym']);
  assert.deepEqual(sockets[0].sent.slice(-2), [{ op: 'unsub', scopes: ['self/journal'] }, { op: 'sub', scopes: ['self/gym'] }]);
  sockets[0].onmessage({ data: '{"op":"change","scope":"self/gym"}' });
  await tick();
  assert.equal(frames.length, 1);
  timers.advance(25_000);
  assert.deepEqual(sockets[0].sent.at(-1), { op: 'ping' });
  timers.advance(10_000);
  assert.equal(reconnects, 1); assert.deepEqual(failures, ['live']);
  timers.advance(100);
  assert.equal(sockets.length, 2);
  live.stop();
  assert.equal(timers.tasks.size, 0);
});

for (const bound of ['count', 'bytes']) test(`live ${bound} overflow closes immediately while frame handling is stalled and bounds reconnects`, async () => {
  const timers = new FakeTimers(), sockets = [], failures = [];
  let finish, received = 0, pulls = 0;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const live = new LiveChannel({ timers, now: () => timers.time, draw: () => 100,
    transport: { openLive() {
      const socket = { readyState: 1, send() {}, close() { this.readyState = 3; } };
      sockets.push(socket); return socket;
    } }, onFrame: async () => { received++; await blocked; },
    onReconnect: () => pulls++, onFailure: (failure) => failures.push(failure) });
  live.start(); sockets[0].onopen();
  const data = JSON.stringify({ op: 'change', padding: bound === 'bytes' ? 'é'.repeat(30_000) : '' });
  const accepted = bound === 'count' ? 64 : Math.floor(1_048_576 / new TextEncoder().encode(data).length);
  for (let i = 0; i < accepted; i++) sockets[0].onmessage({ data });
  assert.equal(received, 1);
  assert.equal(live.frames.length, accepted - 1);
  assert.ok(live.queuedBytes + live.activeBytes <= 1_048_576);
  sockets[0].onmessage({ data });
  assert.equal(sockets[0].readyState, 3);
  assert.equal(live.frames.length, 0);
  assert.equal(live.queuedBytes, 0);
  assert.equal(pulls, 1);
  assert.deepEqual(failures, ['live']);
  timers.advance(100); sockets[1].onopen();
  for (let i = 0; i < accepted; i++) sockets[1].onmessage({ data });
  assert.equal(sockets[1].readyState, 3);
  assert.equal(received, 1);
  assert.equal(pulls, 2);
  live.stop(); finish(); await tick();
  assert.equal(live.frames.length, 0);
  assert.equal(live.activeBytes, 0);
  assert.equal(timers.tasks.size, 0);
});

for (const data of [new Uint8Array([1]), 'é'.repeat(70_000), '{'])
  test('invalid or oversized live frames close before reaching the consumer', async () => {
    const timers = new FakeTimers(); let received = 0, recoveries = 0;
    const socket = { readyState: 1, send() {}, close() { this.readyState = 3; } };
    const live = new LiveChannel({ timers, transport: { openLive: () => socket },
      onFrame: () => received++, onReconnect: () => recoveries++, onFailure() {} });
    live.start(); socket.onopen(); socket.onmessage({ data }); await tick();
    assert.equal(received, 0);
    assert.equal(socket.readyState, 3);
    assert.equal(recoveries, 1);
    assert.equal(live.frames.length, 0);
    assert.equal(live.queuedBytes, 0);
    live.stop(); assert.equal(timers.tasks.size, 0);
  });

test('telemetry drops content, ids, unknown labels and exceptions, and enforces its per-minute bound', () => {
  const events = [], failures = []; let time = 0;
  const telemetry = syncTelemetry({ limit: 3, now: () => time,
    event: (name, props) => events.push({ name, props }), failure: (operation) => failures.push(operation) });
  telemetry.event('sync-digest-mismatch', { scopeKind: 'product', seq: 42, body: 'secret', account: 'A', token: 'secret' });
  telemetry.failure('storage');
  telemetry.event('sync-persist', { outcome: 'denied', scope: 'tree/secret' });
  telemetry.failure('transport');
  telemetry.failure('secret');
  telemetry.event('secret', { token: 'secret' });
  assert.deepEqual(events, [{ name: 'sync-digest-mismatch', props: { scopeKind: 'product', seq: 42 } }, { name: 'sync-persist', props: { outcome: 'denied' } }]);
  assert.deepEqual(failures, ['storage']);
  time = 60_000; telemetry.failure('transport');
  assert.deepEqual(failures, ['storage', 'transport']);
});

test('writer measurements are bounded numeric labels and never forward content or non-finite values', () => {
  const events = [];
  const telemetry = syncTelemetry({ event: (name, props) => events.push({ name, props }) });
  telemetry.event('sync-writer', { durationMs: 90000, queueMs: 12, body: 'secret', scope: 'private' });
  telemetry.event('sync-writer', { durationMs: Infinity, queueMs: -1, account: 'private' });
  assert.deepEqual(events, [{ name: 'sync-writer', props: { durationMs: 60000, queueMs: 12 } }, { name: 'sync-writer', props: {} }]);
});

test('the default browser fetch preserves its global receiver', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return new Response('{"serverTime":1000,"epoch":"e","as":null}');
  };
  try {
    const transport = new HttpTransport({ schema: 4, reading: () => ({ wall: 1000, mono: 1000, boot: 'test' }) });
    assert.equal((await transport.request('hello')).response.status, 200);
  } finally { globalThis.fetch = original; }
});

test('a captured browser fetch preserves its global receiver', async () => {
  const transport = new HttpTransport({ schema: 4, reading: () => ({ wall: 1000, mono: 1000, boot: 'test' }),
    fetch: async function () {
      assert.equal(this, globalThis);
      return new Response('{"serverTime":1000,"epoch":"e","as":null}');
    } });
  assert.equal((await transport.request('hello')).response.status, 200);
});
