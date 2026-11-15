import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiClient } from '../../../src/platform/ai/client.js';
import { decodeEvents, validateAllowance, validateEvent, HttpAiTransport, TransportFailure } from '../../../src/platform/ai/wire.js';

test('every AI terminal and allowance fixture is accepted without projecting away fields', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/ai/wire/fixtures.json', import.meta.url)));
  for (const [index, event] of [...fixtures.textEvents, ...Object.values(fixtures.textTerminals)].entries()) assert.doesNotThrow(() => validateEvent({ id: index + 1, ...event }));
  for (const value of Object.values(fixtures.allowances)) assert.doesNotThrow(() => validateAllowance(value));
});

test('the actual client returns every terminal fixture intact and bounds unexpected service codes', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/ai/wire/fixtures.json', import.meta.url)));
  for (const terminal of Object.values(fixtures.textTerminals)) {
    const failures = [];
    const client = new AiClient({ telemetry: { failure: (name) => failures.push(name) }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
      request: async () => ({ status: 200, events: (async function* () { yield { id: 1, ...terminal }; })() }),
    } });
    assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: fixtures.textRequest, label: 'other', use: 'vector.coach', version: 1, onText: () => {} }), { id: 1, ...terminal });
    assert.deepEqual(failures, terminal.data.code === 'provider_rejected' ? ['ai-call'] : []);
  }
  const reports = [];
  const client = new AiClient({ telemetry: { failure: (name) => reports.push(name) }, transport: {
    pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }), request: async () => ({ status: 400, body: { code: 'private-user-content', allowance: null } }),
  } });
  assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: fixtures.textRequest, label: 'other', use: 'vector.coach', version: 1, onText: () => {} }),
    { failure: { source: 'wire', code: 'invalid-answer', admission: 'none', allowance: null } });
  assert.deepEqual(reports, ['ai-call']);
});

test('all wire refusals before and after a lost stream keep exact codes and monotonic admission', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/ai/wire/fixtures.json', import.meta.url)));
  for (const refusal of fixtures.refusals) for (const prior of ['none', 'lost-put', 'event']) {
    let now = 0; let count = 0; const requests = []; const failures = [];
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (name) => failures.push(name) },
      transport: { pass: async () => ({ status: 200, body: { pass: 'test', expiresIn: 600000 } }), request: async (request) => {
        requests.push({ method: request.method, body: request.body, path: request.path });
        if (count++ === 0 && prior !== 'none') return { status: 200, events: (async function* () {
          if (prior === 'event') yield { id: 1, event: 'started', data: { callId: 'AAAAAAAAAAAAAAAAAAAAAA', served: 'small', maxTokens: 100 } };
          throw new TransportFailure('lost');
        })() };
        return refusal;
      } } });
    const answer = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: fixtures.textRequest, label: 'other', use: 'vector.coach', version: 1, onText: () => {} });
    const code = refusal.body.code;
    assert.equal(answer.failure.code, prior !== 'none' && ['rate_limited', 'busy', 'accounting_unavailable'].includes(code) ? 'answer-timeout' : code, `${code}/${prior}`);
    assert.equal(answer.failure.admission, prior === 'event' ? 'admitted' : prior === 'lost-put' || ['busy', 'accounting_unavailable'].includes(code) ? 'possible' : 'none', `${code}/${prior}`);
    assert.ok(requests.filter((request) => request.method === 'PUT').every((request) => request.body === JSON.stringify(fixtures.textRequest)));
    assert.ok(requests.every((request) => request.path.includes('AAAAAAAAAAAAAAAAAAAAAA')));
    assert.ok(failures.every((operation) => operation === 'ai-call'));
    if (prior === 'event') assert.ok(requests.slice(1).every((request) => request.method === 'GET' && request.path.endsWith('?after=1')));
  }
});

test('pass cache refreshes at less than sixty seconds and fences a late seat response', async () => {
  let now = 0; let passes = 0; let release;
  const client = new AiClient({ now: () => now, telemetry: { failure: () => assert.fail('unexpected failure') }, transport: {
    pass: async () => { passes++; if (passes === 3) return new Promise((resolve) => { release = resolve; }); return { status: 200, body: { pass: `pass-${passes}`, expiresIn: 600000 } }; },
  } });
  assert.equal(await client.credential('vector.coach', 1, 0), 'pass-1');
  now = 540000; assert.equal(await client.credential('vector.coach', 1, 0), 'pass-1');
  now++; assert.equal(await client.credential('vector.coach', 1, 0), 'pass-2');
  const pending = client.credential('vector.coach', 1, 0, true);
  client.clearPass(); release({ status: 200, body: { pass: 'late-private-pass', expiresIn: 600000 } });
  await assert.rejects(pending, (error) => error.code === 'seat-changed');
  assert.equal(client.pass, null);
  assert.equal(await client.credential('vector.coach', 1, 1), 'pass-4');
});

test('SSE parses UTF-8 split at each byte, CRLF, comments, and repeated cursor safely', async () => {
  const value = { id: 4, event: 'text', data: { delta: 'é😀' } };
  const bytes = new TextEncoder().encode(': ping\r\nid: 4\r\nevent: text\r\ndata: {"delta":"é😀"}\r\n\r\n');
  const actual = [];
  for await (const event of decodeEvents((async function* () { for (const byte of bytes) yield new Uint8Array([byte]); })())) actual.push(event);
  assert.deepEqual(actual, [value]);
  for (const raw of ['id: 0\nevent: text\ndata: {"delta":"x"}\n\n', 'id: 1\nevent: text\ndata: {"delta":42}\n\n', 'id: 1\nevent: text\ndata: invalid\n\n']) {
    await assert.rejects(async () => { for await (const event of decodeEvents((async function* () { yield new TextEncoder().encode(raw); })())) assert.fail(JSON.stringify(event)); }, (error) => error.code === 'invalid-answer');
  }
});

test('transport service requests omit cookies and installations and refuse redirects', async () => {
  const requests = [];
  const transport = new HttpAiTransport({ base: 'https://example.invalid', installation: () => 'private-installation', fetch: async (url, options) => {
    requests.push({ url, options }); return { status: url.endsWith('/v1/ai/passes') ? 200 : 204, json: async () => ({ pass: 'private-pass', expiresIn: 600000 }) };
  } });
  await transport.pass({ client: 'web', use: 'vector.coach', version: 1 });
  await transport.request({ method: 'PUT', path: '/v1/pictures/AAAAAAAAAAAAAAAAAAAAAA', bytes: new Uint8Array([1]), mediaType: 'image/png', pass: 'private-pass' });
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[1].options.credentials, 'omit');
  assert.equal(requests[1].options.redirect, 'manual');
  assert.deepEqual(requests[1].options.headers, { Authorization: 'Bearer private-pass', 'Content-Type': 'image/png' });
});

test('allowance uses its complete wire shape and repairs one expired pass', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/ai/wire/fixtures.json', import.meta.url)));
  for (const allowance of Object.values(fixtures.allowances)) {
    let calls = 0; let passes = 0;
    const client = new AiClient({ telemetry: { failure: () => assert.fail('unexpected failure') }, transport: {
      pass: async () => { passes++; return { status: 200, body: { pass: 'private', expiresIn: 600000 } }; },
      request: async () => ++calls === 1 ? { status: 401, body: { code: 'pass_expired', allowance: null } } : { status: 200, body: allowance },
    } });
    assert.deepEqual(await client.allowance({ use: 'vector.coach', version: 1 }), allowance);
    assert.equal(passes, 2);
  }
});
