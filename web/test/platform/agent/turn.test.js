import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { TurnRunner, HostUnavailable } from '../../../src/platform/agent/turn.js';
import { AiClient } from '../../../src/platform/ai/client.js';
import { TransportFailure } from '../../../src/platform/ai/wire.js';

test('a tool goes to the AI service strict as the profile says, and unsaid where the profile is silent', async () => {
  const story = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/agent/turns/text.json', import.meta.url), 'utf8'));
  const [read, write] = story.profile.tools;
  const profile = { ...story.profile, tools: [{ ...read, strict: false }, write] };
  const requests = [];
  const runner = new TurnRunner({
    ai: { clearPass() {}, connected: () => true, text: async ({ request }) => {
      requests.push(request);
      return { event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [{ text: 'Hi' }], carry: 'c' } } };
    } },
    telemetry: { failure() {}, turn() {}, ability() {} },
    runtime: { now: () => 0, newId: () => story.runtime.callIds[0], withLock: (_, options, body) => body(true) },
    host: { open: async () => ({ ...story.host.open, lease: 'lease' }), beginRound: async () => {}, text: async () => {}, end: async () => {} },
  });
  assert.equal((await runner.run(story.input, profile)).state, 'completed');
  assert.deepEqual(requests.map((request) => request.tools), [[
    { name: read.name, description: read.description, input: read.input, strict: false },
    { name: write.name, description: write.description, input: write.input },
  ]]);
  await assert.rejects(runner.run(story.input, { ...profile, tools: [{ ...read, strict: 'yes' }] }), /invalid profile tool/);
});

test('the seat barrier resolves when the active record has disappeared', async () => {
  const story = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/agent/turns/text.json', import.meta.url), 'utf8'));
  const events = [];
  let release;
  let enter;
  const dispatched = new Promise((resolve) => { enter = resolve; });
  const runner = new TurnRunner({
    ai: { clearPass() {}, connected: () => true, text: async () => { enter(); await new Promise((resolve) => { release = resolve; }); return { failure: { code: null } }; } },
    telemetry: { failure: (operation) => events.push({ failure: operation }), turn: (event) => events.push(event) },
    runtime: { now: () => 0, newId: () => story.runtime.callIds[0], withLock: (_, options, body) => body(true) },
    host: { open: async () => ({ ...story.host.open, lease: 'lease' }), beginRound: async () => {}, end: async () => { throw new HostUnavailable(); } },
  });
  const turn = runner.run(story.input, story.profile);
  await dispatched;
  try { await assert.doesNotReject(runner.seatWillChange()); }
  finally { release(); }
  assert.equal(await turn, null);
  assert.equal(runner.active, null);
  assert.deepEqual(events, [{ state: 'interrupted', seat: 'bound', code: null, rounds: 1, abilityCalls: 0, refusals: 0, answerBytes: 0, durationMs: 0 }]);
});

test('an unexpected seat-barrier write failure reports immediately and once before the provider returns', async () => {
  const story = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/agent/turns/text.json', import.meta.url), 'utf8'));
  const reports = [];
  let release; let enter;
  const dispatched = new Promise((resolve) => { enter = resolve; });
  const runner = new TurnRunner({
    ai: { clearPass() {}, connected: () => true, text: async () => { enter(); await new Promise((resolve) => { release = resolve; }); return { failure: { code: null } }; } },
    telemetry: { failure: (operation) => reports.push(operation) },
    runtime: { now: () => 0, newId: () => story.runtime.callIds[0], withLock: (_, options, body) => body(true) },
    host: { open: async () => ({ ...story.host.open, lease: 'lease' }), beginRound: async () => {}, end: async () => { throw new Error('storage failure'); } },
  });
  const task = runner.run(story.input, story.profile);
  const settled = assert.rejects(task, /storage failure/);
  await dispatched;
  try {
    await assert.rejects(runner.seatWillChange(), /storage failure/);
    assert.deepEqual(reports, ['agent-host']);
  } finally { release(); await settled; }
  assert.deepEqual(reports, ['agent-host']);
});

test('the awaited seat barrier permits a new turn while the old provider finishes without late writes', async () => {
  const story = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/agent/turns/text.json', import.meta.url), 'utf8'));
  const writes = [];
  let release;
  let admit;
  const admitted = new Promise((resolve) => { admit = resolve; });
  let calls = 0;
  let ids = 0;
  const telemetry = { failure: () => assert.fail('unexpected failure'), turn() {}, ability() {} };
  const ai = new AiClient({ telemetry, transport: {
    pass: async () => ({ status: 200, body: { pass: 'private', expiresIn: 600000 } }),
    request: async () => {
      const first = calls++ === 0;
      return { status: 200, events: (async function* () {
        if (first) { admit(); await new Promise((resolve) => { release = resolve; }); }
        yield { id: 1, event: 'text', data: { delta: first ? 'old' : 'new' } };
        yield { id: 2, event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [], carry: '' }, charged: '0', allowance: null } };
      })() };
    },
  } });
  const runner = new TurnRunner({ ai, telemetry, runtime: { now: () => 0, newId: () => story.runtime.callIds[ids++], withLock: (_, options, body) => body(true) }, host: {
    open: async (input) => ({ lease: input.seat.key, history: '', context: [], pictures: [] }),
    beginRound: async () => {},
    text: async (lease, text) => writes.push({ lease, text }),
    end: async (lease, end) => writes.push({ lease, end }),
  } });
  const old = runner.run(story.input, story.profile);
  await admitted;
  await runner.seatWillChange();
  assert.equal((await runner.run({ ...story.input, turnId: 'second', seat: { kind: 'bound', key: 'seat-2' } }, story.profile)).state, 'completed');
  release();
  assert.equal((await old).state, 'interrupted');
  assert.deepEqual(writes, [
    { lease: 'seat-1', end: { state: 'interrupted', text: '', truncated: false, code: null } },
    { lease: 'seat-2', text: 'new' },
    { lease: 'seat-2', end: { state: 'completed', text: 'new', truncated: false, code: null } },
  ]);
});

for (const file of readdirSync(new URL('../../../../packages/api-contract/agent/turns/', import.meta.url)).filter((name) => name.endsWith('.json')).sort()) {
  test(`Coach shared story: ${file}`, async () => {
    const story = JSON.parse(readFileSync(new URL(`../../../../packages/api-contract/agent/turns/${file}`, import.meta.url), 'utf8'));
    const refusals = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/ai/wire/fixtures.json', import.meta.url))).refusals;
    const trace = { requests: [], hostCalls: [], gateRefusals: [], marks: [], waitsMs: [], telemetry: [], end: null };
    let now = story.runtime.nowMs;
    let generation = 0;
    let exists = Boolean(story.host.recovery);
    let writer;
    let state = story.host.recovery?.state ?? null;
    let passIndex = 0;
    let exchangeIndex = 0;
    let repeat = 0;
    let pictureIndex = 0;
    let idIndex = 0;
    let barrier;
    let engine;
    let connected = story.runtime.connected;
    const controls = structuredClone(story.controls);
    const control = (at) => {
      const index = controls.findIndex((item) => item.at === at);
      if (index < 0) return;
      const [{ action }] = controls.splice(index, 1);
      if (action === 'stop') engine.stop();
      if (action === 'seat') barrier = engine.seatWillChange().then(() => { generation++; });
      if (action === 'delete') exists = false;
      if (action === 'stale') state = 'interrupted';
      if (action === 'disconnect') connected = false;
    };
    const guard = (lease) => { if (!exists || lease !== writer || lease.generation !== generation) throw new HostUnavailable(); };
    const host = {
      refused: (value) => trace.gateRefusals.push(value),
      async open(input) {
        control('open:beforeCommit');
        writer = { generation }; exists = true; state = 'running';
        trace.hostCalls.push({ op: 'open', input: structuredClone(input) });
        trace.marks.push({ turnId: input.turnId, callId: null, textBytesBeforeRound: 0 });
        return { ...story.host.open, lease: writer };
      },
      async recover(turnId) {
        writer = { generation }; trace.hostCalls.push({ op: 'recover', turnId });
        return { ...story.host.recovery, lease: writer };
      },
      async beginRound(lease, text, mark) { control('beginRound:beforeCommit'); guard(lease); trace.hostCalls.push({ op: 'beginRound', text, mark }); trace.marks.push(mark); },
      async text(lease, text) { control('text:beforeCommit'); guard(lease); trace.hostCalls.push({ op: 'text', text }); },
      async check(lease, rule, call) { control(`check:${call.id}:${rule}`); guard(lease); trace.hostCalls.push({ op: 'check', rule, call }); return story.host.checks[call.id]?.[rule] ?? null; },
      async execute(lease, identity, call) {
        control(`execute:${call.id}:beforeCommit`); guard(lease);
        trace.hostCalls.push({ op: 'execute', callId: identity.callId, call });
        return story.host.executions[call.id] ?? { ok: true, content: String(call.input.value) };
      },
      async end(lease, end) { guard(lease); state = end.state; trace.hostCalls.push({ op: 'end', end }); trace.marks.push(null); },
      async withdraw(lease) { guard(lease); exists = false; trace.hostCalls.push({ op: 'withdraw' }); trace.marks.push(null); },
    };
    const telemetry = {
      failure: (operation) => trace.telemetry.push({ kind: 'failure', operation }),
      turn: (event) => trace.telemetry.push({ kind: 'turn', ...event }),
      ability: (event) => trace.telemetry.push({ kind: 'ability', ...event }),
    };
    const transport = {
      async pass() {
        const value = story.service.passes[Math.min(passIndex++, story.service.passes.length - 1)];
        now += value.elapsedMs ?? 0;
        if (value.transport) throw new TransportFailure(value.transport);
        return value.pass ? { status: 200, body: value } : { status: value.status, body: { code: value.code, error: 'AI access could not be started.' } };
      },
      async request({ method, path, body, bytes }) {
        trace.requests.push({ method, path, body: bytes ? Array.from(bytes) : body ? JSON.parse(body) : null });
        if (path.startsWith('/v1/pictures/')) return { status: story.service.pictures[pictureIndex++] ?? 204 };
        const current = exchangeIndex;
        const value = story.service.exchanges[exchangeIndex];
        assert.ok(value, `unexpected service request ${path}`);
        if (++repeat >= value.repeat) { exchangeIndex++; repeat = 0; }
        if (value.http) throw new TransportFailure('lost');
        if (value.transport) throw new TransportFailure(value.transport);
        if (value.refusal) {
          const fixture = refusals.find(({ body }) => body.code === value.refusal.code);
          assert.ok(fixture, `missing refusal status for ${value.refusal.code}`);
          return { status: fixture.status, body: value.refusal };
        }
        return { status: 200, events: (async function* () {
          for (const event of value.events) { control(`event:${current}:${event.id}`); yield event; }
          if (value.broken) throw new TransportFailure('lost');
        })() };
      },
    };
    const ai = new AiClient({ transport, telemetry, now: () => now, connected: () => connected, wait: async (ms, signal) => {
      const index = trace.waitsMs.length; trace.waitsMs.push(ms); control(`wait:${index}`);
      if (signal.aborted) return false;
      now += ms; return true;
    } });
    engine = new TurnRunner({ host, ai, telemetry, runtime: { now: () => now, newId: () => story.runtime.callIds[idIndex++],
      withLock: (_, options, body) => body(story.runtime.lockAvailable) } });
    trace.end = await engine.run(story.input, story.profile, { recover: Boolean(story.host.recovery) });
    await barrier;
    assert.deepEqual(trace, story.expected);
    assert.equal(controls.length, 0, 'all scripted controls ran');
    if (trace.end && exists) assert.equal(state, trace.end.state);
  });
}
