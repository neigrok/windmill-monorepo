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

test('lost pass, picture and allowance fetches remain offline without reporting a defect', async () => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const onLine of [false, true]) for (const boundary of ['pass', 'picture', 'allowance']) {
      Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true });
      const reports = [];
      const transport = new HttpAiTransport({ fetch: async (url) => {
        if (boundary !== 'pass' && url.endsWith('/v1/ai/passes'))
          return { status: 200, json: async () => ({ pass: 'private', expiresIn: 600000 }) };
        throw new TypeError('offline');
      } });
      const client = new AiClient({ transport, telemetry: { failure: (operation) => reports.push(operation) } });
      const result = boundary === 'allowance' ? await client.allowance({ use: 'vector.coach', version: 1 }) : await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1,
        pictures: boundary === 'picture' ? [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10] }] : [], onText() {} });
      assert.deepEqual(result, { failure: { source: 'transport', code: null, admission: 'none', allowance: null } });
      assert.deepEqual(reports, []);
    }
  } finally {
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    else delete globalThis.navigator;
  }
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
  let now = 0;
  const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (name) => reports.push(name) }, transport: {
    pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }), request: async () => ({ status: 400, body: { code: 'private-user-content', allowance: null } }),
  } });
  assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: fixtures.textRequest, label: 'other', use: 'vector.coach', version: 1, onText: () => {} }),
    { failure: { source: 'result', code: 'answer-timeout', admission: 'possible', allowance: null } });
  assert.deepEqual(reports, []);
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

test('unvalidated allowance and picture HTTP errors are quiet transport loss before text dispatch', async () => {
  for (const boundary of ['allowance', 'picture']) for (const body of [{ code: 'private-user-content', allowance: null }, { code: ['subject_exhausted'], allowance: null }, { code: 'subject_exhausted', allowance: { bogus: true } }]) {
    const reports = [];
    const client = new AiClient({ telemetry: { failure: (operation) => reports.push(operation) }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
      request: async () => ({ status: 429, body }),
    } });
    const result = boundary === 'allowance' ? await client.allowance({ use: 'vector.coach', version: 1 }) : await client.text({
      callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1,
      pictures: [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10] }], onText() {},
    });
    assert.deepEqual(result,
      { failure: { source: 'transport', code: null, admission: 'none', allowance: null } });
    assert.deepEqual(reports, []);
  }
});

test('temporary refresh failures preserve the uncertain call and its original deadline', async () => {
  for (const boundary of ['transport', 'rate_limited', 'unavailable']) for (const resumes of [true, false]) {
    let now = 0; let passes = 0; const requests = []; const reports = [];
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (operation) => reports.push(operation) }, transport: {
      pass: async () => {
        passes++;
        if (passes === 1 || (resumes && passes === 3)) return { status: 200, body: { pass: 'private', expiresIn: 60001 } };
        if (boundary === 'transport') throw new TransportFailure('offline');
        return { status: boundary === 'rate_limited' ? 429 : 503, body: { code: boundary, error: 'AI access could not be started.' } };
      },
      request: async (request) => {
        requests.push({ method: request.method, path: request.path, body: request.body });
        if (requests.length === 1) throw new TransportFailure('lost');
        return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
      },
    } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: { messages: [] }, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    if (resumes) {
      assert.equal(result.event, 'ended', boundary);
      assert.deepEqual(requests, Array(2).fill({ method: 'PUT', path: '/v1/calls/AAAAAAAAAAAAAAAAAAAAAA/text?label=other', body: '{"messages":[]}' }));
      assert.equal(now, 3000);
    } else {
      assert.deepEqual(result, { failure: { source: 'result', code: 'answer-timeout', admission: 'possible', allowance: null } }, boundary);
      assert.equal(now, 1200000);
      assert.equal(requests.length, 1);
    }
    assert.deepEqual(reports, []);
  }
});

test('raw HTTP failures retain admission and retry quietly through the real adapter', async () => {
  for (const status of [502, 503, 504]) for (const prior of ['none', 'event']) for (const raw of ['html', 'unknown', 'naked-code', 'bad-allowance', 'wrong-status', 'body-loss']) {
    let count = 0; let now = 0; const requests = []; const reports = [];
    const terminal = 'id: 2\nevent: ended\ndata: {"stop":"completed","message":{"role":"assistant","parts":[],"carry":""},"charged":"0","allowance":null}\n\n';
    const transport = new HttpAiTransport({ fetch: async (url, options) => {
      if (url.endsWith('/v1/ai/passes')) return new Response('{"pass":"private","expiresIn":600000}');
      requests.push({ method: options.method, body: options.body ?? null, url });
      if (prior === 'event' && count++ === 0) return new Response('id: 1\nevent: text\ndata: {"delta":"hi"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      if (requests.length === (prior === 'event' ? 2 : 1)) {
        if (raw === 'body-loss') return { status, json: async () => { throw new TypeError('body unavailable'); } };
        return new Response(raw === 'html' ? '<html>Bad gateway</html>' : JSON.stringify(raw === 'unknown' ? { code: 'private-content', allowance: null } : raw === 'naked-code' ? { code: 'subject_exhausted' } : raw === 'wrong-status' ? { code: 'subject_exhausted', allowance: null } : { code: 'subject_exhausted', allowance: { bogus: true } }), { status, headers: { 'Content-Type': raw === 'html' ? 'text/html' : 'application/json' } });
      }
      return new Response(terminal, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const client = new AiClient({ transport, now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (operation) => reports.push(operation) } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    assert.equal(result.event, 'ended', `${status}/${prior}/${raw}`);
    assert.deepEqual(requests.map(({ method, body }) => ({ method, body })), prior === 'event' ? [{ method: 'PUT', body: '{}' }, { method: 'GET', body: null }, { method: 'GET', body: null }] : [{ method: 'PUT', body: '{}' }, { method: 'PUT', body: '{}' }]);
    if (prior === 'event') assert.ok(requests.slice(1).every(({ url }) => url.endsWith('/result?after=1')));
    assert.deepEqual(reports, []);
  }
});

test('malformed successful events keep possible admission and report their wire defect', async () => {
  const reports = [];
  const client = new AiClient({ telemetry: { failure: (operation) => reports.push(operation) }, transport: {
    pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
    request: async () => ({ status: 200, events: (async function* () { yield { id: 1, event: 'text', data: { delta: 3 } }; })() }),
  } });
  assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} }), { failure: { source: 'wire', code: 'invalid-answer', admission: 'possible', allowance: null } });
  assert.deepEqual(reports, ['ai-call']);
});

test('a cached pass reaches uncertain offline dispatch while preparation failures do not', async () => {
  for (const boundary of ['pass', 'picture', 'cached-pass']) {
    let now = 0; let dispatches = 0; const reports = [];
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (operation) => reports.push(operation) }, transport: {
      pass: async () => { throw new TransportFailure('offline'); },
      request: async () => { dispatches++; throw new TransportFailure('offline'); },
    } });
    if (boundary !== 'pass') client.pass = { use: 'vector.coach', version: 1, value: 'private', until: 2000000 };
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, pictures: boundary === 'picture' ? [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [1] }] : [], label: 'other', use: 'vector.coach', version: 1, onText() {} });
    assert.deepEqual(result, { failure: boundary === 'cached-pass' ? { source: 'result', code: 'answer-timeout', admission: 'possible', allowance: null } : { source: 'transport', code: null, admission: 'none', allowance: null } });
    assert.equal(now, boundary === 'cached-pass' ? 1200000 : 0);
    if (boundary === 'cached-pass') assert.ok(dispatches > 1);
    else assert.equal(dispatches, boundary === 'picture' ? 1 : 0);
    assert.deepEqual(reports, []);
  }
});

test('recovery call_unknown is quiet while the live equivalent remains a defect', async () => {
  for (const recover of [false, true]) {
    const reports = [];
    const client = new AiClient({ telemetry: { failure: (operation) => reports.push(operation) }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
      request: async () => ({ status: 404, body: { code: 'call_unknown', allowance: null } }),
    } });
    const result = await client[recover ? 'result' : 'text']({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    assert.deepEqual(result, { failure: { source: recover ? 'result' : 'text', code: 'call_unknown', admission: recover ? 'admitted' : 'none', allowance: null } });
    assert.deepEqual(reports, recover ? [] : ['ai-call']);
  }
});

test('resent PUT keeps thirty seconds for paused, concurrency and provider refusals', async () => {
  for (const code of ['paused', 'concurrency_exhausted', 'provider_unavailable']) for (const resumes of [false, true]) {
    let now = 0; const requests = [];
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
      request: async (request) => {
        requests.push({ method: request.method, body: request.body });
        if (requests.length === 1) throw new TransportFailure('lost');
        if (resumes && requests.length === 3) return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
        return { status: code === 'concurrency_exhausted' ? 429 : 503, body: { code, allowance: null } };
      },
    } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    if (resumes) assert.equal(result.event, 'ended', code);
    else assert.deepEqual(result, { failure: { source: 'text', code, admission: 'possible', allowance: null } });
    assert.equal(now, resumes ? 3000 : 30000);
    assert.deepEqual(requests, Array(resumes ? 3 : 6).fill({ method: 'PUT', body: '{}' }));
  }
});

test('pass proxy errors are quiet preparation failures and retry after uncertain dispatch', async () => {
  for (const prior of ['none', 'lost']) for (const body of ['<html>Bad gateway</html>', '{"code":"unknown"}']) {
    let now = 0; let passes = 0; let calls = 0; const reports = [];
    const transport = new HttpAiTransport({ fetch: async (url) => {
      if (url.endsWith('/v1/ai/passes')) {
        passes++;
        if (passes === (prior === 'lost' ? 2 : 1)) return new Response(body, { status: 503 });
        return new Response('{"pass":"private","expiresIn":60001}');
      }
      if (++calls === 1) throw new TypeError('response lost');
      return new Response('id: 1\nevent: ended\ndata: {"stop":"completed","message":{"role":"assistant","parts":[],"carry":""},"charged":"0","allowance":null}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const client = new AiClient({ transport, now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (operation) => reports.push(operation) } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    if (prior === 'lost') { assert.equal(result.event, 'ended'); assert.equal(calls, 2); assert.equal(now, 3000); }
    else { assert.deepEqual(result, { failure: { source: 'transport', code: null, admission: 'none', allowance: null } }); assert.equal(calls, 0); }
    assert.deepEqual(reports, []);
  }
});

test('a pass refresh that finishes at the asking deadline cannot dispatch again', async () => {
  let now = 0; let passes = 0; let calls = 0;
  const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected failure') }, transport: {
    pass: async () => { if (++passes === 2) now = 1200000; return { status: 200, body: { pass: 'private', expiresIn: 60001 } }; },
    request: async () => { calls++; throw new TransportFailure('lost'); },
  } });
  assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} }), { failure: { source: 'result', code: 'answer-timeout', admission: 'possible', allowance: null } });
  assert.equal(passes, 2);
  assert.equal(calls, 1);
});

test('pass refusals require their status, known code and string error with exact fields', async () => {
  for (const { status, body, code } of [
    { status: 401, body: { code: 'unauthenticated', error: 'Access unavailable.' }, code: 'unauthenticated' },
    { status: 401, body: { code: 'unauthenticated' }, code: null },
    { status: 401, body: { code: 'unauthenticated', error: 'Access unavailable.', extra: true }, code: null },
    { status: 401, body: { code: 'unauthenticated', error: 3 }, code: null },
    { status: 401, body: { code: 'unauthenticated', error: null }, code: null },
    { status: 401, body: { code: 'unknown', error: 'Access unavailable.' }, code: null },
    { status: 401, body: ['unauthenticated'], code: null },
    { status: 401, body: { code: ['unauthenticated'], error: 'Access unavailable.' }, code: null },
    { status: 502, body: { code: 'unauthenticated', error: 'Access unavailable.' }, code: null },
  ]) {
    const reports = [];
    const client = new AiClient({ telemetry: { failure: (operation) => reports.push(operation) }, transport: { pass: async () => ({ status, body }) } });
    assert.deepEqual(await client.credential('vector.coach', 1, 0), { failure: { source: code ? 'pass' : 'transport', code, admission: 'none', allowance: null } }, JSON.stringify({ status, body }));
    assert.deepEqual(reports, []);
  }
});

test('a picture repair cannot dispatch text after its active retry deadline', async () => {
  for (const deadline of [30000, 1200000]) for (const failure of [false, true]) {
    let now = 0; let uploads = 0; let calls = 0;
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 2000000 } }),
      request: async ({ path }) => {
        if (path.startsWith('/v1/pictures/')) {
          if (++uploads === 2) { now = deadline; if (failure) throw new TransportFailure('offline'); }
          return { status: 204 };
        }
        calls++;
        if (calls === 1) {
          if (deadline === 1200000) throw new TransportFailure('lost');
          return { status: 503, body: { code: 'paused', allowance: null } };
        }
        if (calls === 2) return { status: 410, body: { code: 'picture_gone', allowance: null } };
        return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
      },
    } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, pictures: [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [1] }], label: 'other', use: 'vector.coach', version: 1, onText() {} });
    assert.deepEqual(result, { failure: deadline === 30000 ? { source: 'text', code: 'paused', admission: 'none', allowance: null } : { source: 'result', code: 'answer-timeout', admission: 'possible', allowance: null } });
    assert.equal(calls, 2);
    assert.equal(uploads, 2);
  }
});

test('picture repair transport loss follows admission and does not spend another repair', async () => {
  for (const prior of ['none', 'lost']) {
    let now = 0; let uploads = 0; let calls = 0; const requests = [];
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: {
      pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 2000000 } }),
      request: async ({ path, method, body }) => {
        if (path.startsWith('/v1/pictures/')) { if (++uploads === 2) throw new TransportFailure('offline'); return { status: 204 }; }
        requests.push({ method, body }); calls++;
        if (prior === 'lost' && calls === 1) throw new TransportFailure('lost');
        if (calls === (prior === 'lost' ? 2 : 1)) return { status: 410, body: { code: 'picture_gone', allowance: null } };
        return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
      },
    } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, pictures: [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [1] }], label: 'other', use: 'vector.coach', version: 1, onText() {} });
    if (prior === 'none') {
      assert.deepEqual(result, { failure: { source: 'transport', code: null, admission: 'none', allowance: null } });
      assert.equal(now, 0); assert.equal(uploads, 2);
    } else { assert.equal(result.event, 'ended'); assert.equal(now, 3000); assert.equal(uploads, 3); }
    assert.deepEqual(requests, Array(prior === 'none' ? 1 : 3).fill({ method: 'PUT', body: '{}' }));
  }
});

test('Stop cancels asking-again preparation, headers and error bodies without waiting for the network', async () => {
  for (const boundary of ['pass', 'picture', 'headers', 'error-body']) {
    let now = 0; let passes = 0; let uploads = 0; let calls = 0; let release; let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    const stop = new AbortController(); const reports = [];
    const terminal = () => new Response('id: 1\nevent: ended\ndata: {"stop":"completed","message":{"role":"assistant","parts":[],"carry":""},"charged":"0","allowance":null}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const transport = new HttpAiTransport({ fetch: async (url, options) => {
      const pending = (value) => new Promise((resolve, reject) => {
        release = () => resolve(value);
        options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        enter();
      });
      if (url.endsWith('/v1/ai/passes')) {
        if (++passes === 2 && boundary === 'pass') return pending(new Response('{"pass":"private","expiresIn":60001}'));
        return new Response('{"pass":"private","expiresIn":60001}');
      }
      if (url.includes('/v1/pictures/')) {
        if (++uploads === 2 && boundary === 'picture') return pending(new Response(null, { status: 204 }));
        return new Response(null, { status: 204 });
      }
      if (++calls === 1) throw new TypeError('Lost response');
      if (boundary === 'headers') return pending(terminal());
      if (boundary === 'error-body') return { status: 503, json: () => pending({ code: 'busy', allowance: null }) };
      if (boundary === 'picture' && calls === 2) return new Response('{"code":"picture_gone","allowance":null}', { status: 410 });
      return terminal();
    } });
    const client = new AiClient({ transport, now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: (operation) => reports.push(operation) } });
    const task = client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, pictures: boundary === 'picture' ? [{ pictureId: 'PPPPPPPPPPPPPPPPPPPPPP', mediaType: 'image/png', bytes: [1] }] : [], label: 'other', use: 'vector.coach', version: 1, signal: stop.signal, onText() {} });
    await entered;
    stop.abort();
    let timeout;
    try {
      const result = await Promise.race([task, new Promise((resolve) => { timeout = setTimeout(() => resolve('still waiting'), 50); })]);
      assert.deepEqual(result, { failure: { source: 'result', code: 'stopped', admission: 'possible', allowance: null } }, boundary);
      assert.deepEqual(reports, []);
    } finally { clearTimeout(timeout); release(); await task; }
  }
});

test('Stop drains the initial in-flight text and successful replay streams through host callbacks', async () => {
  for (const boundary of ['initial-headers', 'replay-stream']) {
    let now = 0; let calls = 0; let release; let enter; let requestSignal;
    const entered = new Promise((resolve) => { enter = resolve; });
    const stop = new AbortController(); const text = [];
    const terminal = () => new Response('id: 1\nevent: text\ndata: {"delta":"Hello"}\n\nid: 2\nevent: ended\ndata: {"stop":"completed","message":{"role":"assistant","parts":[],"carry":""},"charged":"0","allowance":null}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: new HttpAiTransport({ fetch: async (url, options) => {
      if (url.endsWith('/v1/ai/passes')) return new Response('{"pass":"private","expiresIn":600000}');
      if (boundary === 'replay-stream' && ++calls === 1) throw new TypeError('Lost response');
      requestSignal = options.signal;
      if (boundary === 'initial-headers') return new Promise((resolve) => { release = () => resolve(terminal()); enter(); });
      return terminal();
    } }) });
    const task = client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, signal: stop.signal, onText: async (delta) => {
      if (boundary === 'replay-stream') await new Promise((resolve) => { release = resolve; enter(); });
      text.push(delta);
    } });
    await entered;
    stop.abort();
    let settled = false; task.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(requestSignal.aborted, false);
    release();
    assert.equal((await task).event, 'ended');
    assert.deepEqual(text, ['Hello']);
  }
});


test('a late pass refresh failure cannot extend an expired transient-refusal window', async () => {
  for (const code of ['busy', 'accounting_unavailable']) for (const failure of [false, true]) {
    let now = 0; let passes = 0; let calls = 0;
    const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: {
      pass: async () => {
        if (++passes === 2) { now = 31000; if (failure) throw new TransportFailure('offline'); }
        return { status: 200, body: { pass: 'private', expiresIn: 60001 } };
      },
      request: async () => {
        if (++calls === 1) return { status: 503, body: { code, allowance: null } };
        return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
      },
    } });
    assert.deepEqual(await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} }), { failure: { source: 'text', code, admission: 'possible', allowance: null } });
    assert.equal(calls, 1);
    assert.equal(now, 31000);
  }
});

test('a dispatched retry that loses its answer after thirty seconds still enters recovery', async () => {
  let now = 0; let calls = 0;
  const client = new AiClient({ now: () => now, wait: async (ms) => { now += ms; return true; }, telemetry: { failure: () => assert.fail('unexpected issue') }, transport: {
    pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
    request: async () => {
      if (++calls === 1) return { status: 503, body: { code: 'busy', allowance: null } };
      if (calls === 2) { now = 31000; throw new TransportFailure('lost'); }
      return { status: 200, events: (async function* () { yield { id: 1, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } }; })() };
    },
  } });
  assert.equal((await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} })).event, 'ended');
  assert.equal(calls, 3);
  assert.equal(now, 33000);
});

test('seat changes and rejected response headers release unread HTTP bodies and deadlines', async () => {
  for (const boundary of ['seat', 'content-type', 'redirect']) {
    const timers = new Set(); const reports = [];
    let canceled = false; let requestSignal; let client;
    const transport = new HttpAiTransport({ timers: {
      setTimeout(callback, duration) { const timer = { callback, duration }; timers.add(timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
    }, fetch: async (url, options) => {
      if (url.endsWith('/v1/ai/passes')) return new Response('{"pass":"private","expiresIn":600000}');
      requestSignal = options.signal;
      const body = new ReadableStream({ cancel() { canceled = true; } });
      if (boundary === 'seat') client.clearPass();
      return new Response(body, { status: boundary === 'redirect' ? 302 : 200, headers: { 'Content-Type': boundary === 'seat' ? 'text/event-stream' : 'text/plain' } });
    } });
    client = new AiClient({ transport, telemetry: { failure: (operation) => reports.push(operation) } });
    const result = await client.text({ callId: 'AAAAAAAAAAAAAAAAAAAAAA', request: {}, label: 'other', use: 'vector.coach', version: 1, onText() {} });
    assert.deepEqual(result, { failure: { source: boundary === 'seat' ? 'pass' : boundary === 'redirect' ? 'transport' : 'wire', code: boundary === 'seat' ? null : 'invalid-answer', admission: boundary === 'seat' ? 'none' : 'possible', allowance: null } });
    assert.deepEqual(reports, boundary === 'seat' ? [] : ['ai-call']);
    assert.equal(timers.size, 0, boundary);
    assert.equal(canceled, true, boundary);
    assert.equal(requestSignal.aborted, true, boundary);
  }
});

test('an event response can be disposed before reading or after its reader closes', async () => {
  for (const read of [false, true]) {
    const timers = new Set(); const events = [];
    let cancels = 0; let requestSignal;
    const transport = new HttpAiTransport({ timers: {
      setTimeout(callback, duration) { const timer = { callback, duration }; timers.add(timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
    }, fetch: async (url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('id: 1\nevent: text\ndata: {"delta":"Hello"}\n\n')); },
        cancel() { cancels++; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const response = await transport.request({ method: 'GET', path: '/v1/calls/AAAAAAAAAAAAAAAAAAAAAA/result', pass: 'private' });
    assert.equal(timers.size, 1);
    if (read) for await (const event of response.events) { events.push(event); break; }
    await response.dispose();
    await response.dispose();
    assert.deepEqual(events, read ? [{ id: 1, event: 'text', data: { delta: 'Hello' } }] : []);
    assert.equal(timers.size, 0);
    assert.equal(cancels, 1);
    assert.equal(requestSignal.aborted, true);
  }
});
