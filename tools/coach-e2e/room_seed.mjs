#!/usr/bin/env node
// A browser of the stack's account (room_stack.py) plants *Learn to sail* and begins a conversation about it, a question
// and Coach's answer ended, through roadmap's domain on the browser's sync engine, so the phone signed in to the same account
// reads both by sync: a roadmap to ask about, and a conversation begun in a browser. It prints checks only, never an id, a
// question or an answer.
// Run: PORT=<the backend's port> WM_COACH_E2E_SESSION=<a file holding {account, token, email}> node tools/coach-e2e/room_seed.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../web/src/platform/sync/engine.js';
import { registry } from '../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../web/src/platform/sync/transport.js';
import { ActionRunner, EngineReplica } from '../../web/src/platform/domain-kit/runner.js';
import { FixedZone } from '../../web/src/platform/domain-kit/time.js';
import { Id } from '../../web/src/platform/domain-kit/entities.js';
import { CreateRoadmap } from '../../web/src/products/roadmap/domain/roadmaps.js';
import { CoachMessage, EndTurn, OpenTurn } from '../../web/src/products/roadmap/domain/conversation.js';
import { RoadmapScopes } from '../../web/src/products/roadmap/domain/roadmapRules.js';
import { FakeLocks, FakeTimers } from '../../web/test/platform/sync/fakes.js';

const PORT = Number(process.env.PORT);
const { account, token } = JSON.parse(readFileSync(process.env.WM_COACH_E2E_SESSION ?? '', 'utf8'));
setTimeout(() => { console.log('Deadline exceeded after 120 s'); process.exit(1); }, 120_000).unref();

const repo = fileURLToPath(new URL('../../', import.meta.url));
const { IDBFactory, IDBKeyRange } = createRequire(`${repo}web/package.json`)('fake-indexeddb');
const base = `http://127.0.0.1:${PORT}`;
const timers = new FakeTimers();
timers.time = Date.now();
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'seed' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000), headers: { ...options.headers, Authorization: `Bearer ${token}` } }) });
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'seed', registry, transport, timers,
  draw: (bound) => randomInt(bound), now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { limit: 100, event() {}, failure() {} } });
await engine.signIn(account);
await engine.start();
engine.observe(RoadmapScopes.account);
const runner = new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0));
// An act run as the browser runs it, its gesture let go at once so the engine sends it.
const run = async (act) => {
  const outcome = await runner.runAct(act);
  if (outcome.kind === 'committed') await runner.release(outcome.receipt.gestureId);
  return outcome;
};
const settle = async () => {
  for (let turn = 0; turn < 40; turn++) {
    for (let wait = 0; !engine.leader && wait < 1000; wait++) await new Promise((done) => setImmediate(done));
    timers.time = Math.max(timers.time + 1, Date.now());
    engine.kick();
    await engine.send();
    engine.kickPull();
    await engine.pull();
  }
};

const steps = [['choose', 'Choose a sailing course', []], ['parts', 'Name the boat parts', ['choose']], ['rig', 'Rig the boat', ['parts']],
  ['read', 'Read the wind', ['parts']], ['tie', 'Tie a bowline', ['parts']], ['leave', 'Leave the dock', ['rig', 'read']]];
const planted = await run(new CreateRoadmap('Learn to sail', {
  steps: steps.map(([key, label]) => ({ key, label })), links: steps.flatMap(([key, , follows]) => follows.map((from) => [from, key])) }));
console.log(`  ${planted.kind === 'committed' ? 'ok  ' : 'FAIL'} the browser planted Learn to sail`);
const opened = await run(new OpenTurn({ about: { treeId: String(planted.result.tree) }, question: 'Which step is first?' }));
const ended = opened.kind === 'committed'
  ? await run(new EndTurn(new Id(opened.result.coach, CoachMessage), { state: 'completed', text: 'Choose a sailing course comes first.' })) : opened;
console.log(`  ${ended.kind === 'committed' ? 'ok  ' : 'FAIL'} the browser began a conversation about it, its turn ended`);
await settle();
const left = engine.device.activeReplica.outbox.filter((entry) => ['ready', 'sent', 'held'].includes(entry.state)).length;
console.log(`  ${left === 0 ? 'ok  ' : 'FAIL'} the server took every write`);
process.exit(planted.kind === 'committed' && ended.kind === 'committed' && left === 0 ? 0 : 1);
