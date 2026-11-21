import { readFile, writeFile, rename } from 'node:fs/promises';
import { TurnRunner, HostUnavailable } from '../../../src/platform/agent/turn.js';
import { AiClient } from '../../../src/platform/ai/client.js';
import { HttpAiTransport } from '../../../src/platform/ai/wire.js';

const configPath = process.env.WM_COACH_PROBE_CONFIG;
const outPath = process.env.WM_COACH_PROBE_OUT;
if (!configPath || !outPath) throw new Error('probe paths required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const statePath = process.env.WM_COACH_PROBE_STATE;
let durable = { mark: null, text: '', state: null, values: [], executions: [] };
if (statePath) {
  try { durable = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('probe state unreadable'); }
}
const output = { end: null, abilityCalls: [], marks: [], requests: [], telemetry: [] };
const save = async () => {
  if (!statePath) return;
  await writeFile(`${statePath}.next`, JSON.stringify(durable));
  await rename(`${statePath}.next`, statePath);
};
const lease = {};
let exists = Boolean(durable.state);
let engine;
const guard = (candidate) => { if (!exists || candidate !== lease) throw new HostUnavailable(); };
const host = {
  async open(input) {
    exists = true;
    durable = { mark: { turnId: input.turnId, callId: null, textBytesBeforeRound: 0 }, text: '', state: 'running', values: [], executions: [] };
    output.marks.push(durable.mark); await save();
    return { lease, history: config.history ?? '', context: config.context ?? [], pictures: input.pictures ?? [] };
  },
  async recover() {
    const record = config.recovery ?? durable;
    exists = true;
    durable.mark = record.mark; durable.text = record.text; durable.state = record.state ?? 'running';
    return { lease, ...record, state: record.state ?? 'running' };
  },
  async beginRound(candidate, text, mark) { guard(candidate); durable.text = text; durable.mark = mark; output.marks.push(mark); await save(); },
  async text(candidate, text) {
    guard(candidate); durable.text = text; await save();
    if (config.scenario === 'stop' || config.stopOnFirstText) engine.stop();
  },
  async check(candidate, rule, call) { guard(candidate); return config.checks?.[call.id]?.[rule] ?? null; },
  async execute(candidate, identity, call) {
    guard(candidate);
    const key = `${identity.turnId}:${identity.callId}:${identity.toolCallId}`;
    if (durable.executions.includes(key)) throw new Error('duplicate probe execution');
    durable.executions.push(key); durable.values.push(call.input); output.abilityCalls.push({ name: call.name, input: call.input });
    await save();
    return config.executions?.[call.name] ?? { ok: true, content: 'saved' };
  },
  async end(candidate, end) { guard(candidate); durable.text = end.text; durable.state = end.state; durable.mark = null; output.marks.push(null); await save(); },
  async withdraw(candidate) { guard(candidate); exists = false; durable.mark = null; durable.state = null; durable.text = ''; output.marks.push(null); await save(); },
};
const telemetry = { failure: (operation) => output.telemetry.push({ operation }),
  turn: (value) => output.telemetry.push({ kind: 'turn', ...value }), ability: (value) => output.telemetry.push({ kind: 'ability', ...value }) };
const transport = new HttpAiTransport({ base: config.origin, installation: () => config.installation ?? null,
  fetch: (url, options) => {
    const path = new URL(url).pathname;
    output.requests.push({ method: options.method, path: new URL(url).pathname + new URL(url).search });
    const headers = { ...options.headers };
    if (path === '/v1/ai/passes' && config.session) headers.Cookie = config.session.includes('=') ? config.session : `wm_session=${config.session}`;
    if (path === '/v1/ai/passes') headers.Origin = config.origin;
    return fetch(url, { ...options, headers });
  } });
let index = 0;
engine = new TurnRunner({ host, ai: new AiClient({ transport, telemetry }), telemetry,
  runtime: { now: () => performance.now(), newId: () => config.runtime.callIds[index++], withLock: (_, options, body) => body(true) } });
try {
  output.end = await engine.run(config.input, config.profile, { recover: config.scenario.startsWith('recover') });
  await writeFile(outPath, JSON.stringify(output));
} catch {
  await writeFile(outPath, JSON.stringify({ ...output, failure: 'probe-failed' }));
  process.exitCode = 1;
}
