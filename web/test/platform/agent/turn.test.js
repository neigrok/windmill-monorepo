import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { TurnRunner, HostUnavailable } from '../../../src/platform/agent/turn.js';
import { AiClient } from '../../../src/platform/ai/client.js';
import { TransportFailure } from '../../../src/platform/ai/wire.js';

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
    const controls = structuredClone(story.controls);
    const control = (at) => {
      const index = controls.findIndex((item) => item.at === at);
      if (index < 0) return;
      const [{ action }] = controls.splice(index, 1);
      if (action === 'stop') engine.stop();
      if (action === 'seat') barrier = engine.seatWillChange().then(() => { generation++; });
      if (action === 'delete') exists = false;
      if (action === 'stale') state = 'interrupted';
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
      async beginRound(lease, text, mark) { guard(lease); trace.hostCalls.push({ op: 'beginRound', text, mark }); trace.marks.push(mark); },
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
        return value.pass ? { status: 200, body: value } : { status: value.status, body: { code: value.code } };
      },
      async request({ method, path, body, bytes }) {
        trace.requests.push({ method, path, body: bytes ? Array.from(bytes) : body ? JSON.parse(body) : null });
        if (path.startsWith('/v1/pictures/')) return { status: story.service.pictures[pictureIndex++] ?? 204 };
        const current = exchangeIndex;
        const value = story.service.exchanges[exchangeIndex];
        assert.ok(value, `unexpected service request ${path}`);
        if (++repeat >= value.repeat) { exchangeIndex++; repeat = 0; }
        if (value.refusal) return { status: 429, body: value.refusal };
        return { status: 200, events: (async function* () {
          for (const event of value.events) { control(`event:${current}:${event.id}`); yield event; }
          if (value.broken) throw new TransportFailure('lost');
        })() };
      },
    };
    const ai = new AiClient({ transport, telemetry, now: () => now, wait: async (ms, signal) => {
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
