#!/usr/bin/env node
// Roadmap Coach's records end to end (roadmap-coach.md §9): two browser engines of one account and one of another,
// driven by roadmap's domain on the kit, against windmill_server serving roadmap's scopes on :$PORT, its MCP's shared
// bearer acting as the account $WM_E2E_MCP_USER names, and a THROWAWAY Postgres. This script wipes every sync_* row of
// $WM_E2E_DB, and roadmap's engine rows with them.
// - Every request carries the registry's schema, 15, and hello answers it.
// - The first browser makes a roadmap, opens a conversation about it and ends its turn, and opens one about every roadmap.
// - The account's second browser, which never runs a gesture on the roadmap, draws both conversations by sync; the other
//   account draws neither.
// - MCP's delete_tree deletes the roadmap: the second browser no longer draws the conversation about it, the server
//   holds none of its messages, and the conversation about every roadmap stays.
// The output names checks only, never a record id, a question or an answer.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql, and the server serving roadmap on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8295 ROADMAP_ENGINE_ENABLED=1 \
//     WINDMILL_MCP_TOKEN=<token> WINDMILL_MCP_USER=<uuid> ./build/windmill_server
// Run:  WM_E2E_DB=<database> PORT=8295 WM_E2E_MCP_TOKEN=<token> WM_E2E_MCP_USER=<uuid> node test/e2e/sync_roadmap_coach.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { ActionRunner, EngineReplica } from '../../../web/src/platform/domain-kit/runner.js';
import { Id } from '../../../web/src/platform/domain-kit/entities.js';
import { FixedZone } from '../../../web/src/platform/domain-kit/time.js';
import { CreateRoadmap } from '../../../web/src/products/roadmap/domain/roadmaps.js';
import { CoachMessage, CoachThread, Conversation, EndTurn, OpenTurn } from '../../../web/src/products/roadmap/domain/conversation.js';
import { RoadmapScopes } from '../../../web/src/products/roadmap/domain/roadmapRules.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';

const DEADLINE_MS = 180_000;
const REQUEST_MS = 10_000;
const DB = process.env.WM_E2E_DB;
const PORT = Number(process.env.PORT);
const MCP_TOKEN = process.env.WM_E2E_MCP_TOKEN;
const ACCOUNT = process.env.WM_E2E_MCP_USER;
if (!DB || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !MCP_TOKEN || !/^[0-9a-f-]{36}$/.test(ACCOUNT ?? '') || process.argv.length > 2) {
  console.error('set WM_E2E_DB to a throwaway database, PORT to the server\'s port, and WM_E2E_MCP_TOKEN and WM_E2E_MCP_USER '
    + 'to the server\'s WINDMILL_MCP_TOKEN and WINDMILL_MCP_USER (a uuid); the script takes no arguments');
  process.exit(2);
}
setTimeout(() => {
  console.log(`Deadline exceeded after ${DEADLINE_MS / 1000} s`);
  process.exit(1);
}, DEADLINE_MS).unref();

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { IDBFactory, IDBKeyRange } = createRequire(`${repo}web/package.json`)('fake-indexeddb');
const base = `http://127.0.0.1:${PORT}`;
const results = { pass: 0, fail: 0 };
const check = (ok, label, detail) => {
  if (ok) results.pass++;
  else results.fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};

// ── a clean engine, the two accounts and a session for each ───────────────────────────────────────────────────────
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();
for (const table of ['sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
const OTHER = randomUUID();
psql(`insert into users (id, email, name) values ('${ACCOUNT}', 'sync-roadmap-coach-e2e@example.com', 'Coach') on conflict (id) do nothing`);
psql(`insert into users (id, email, name) values ('${OTHER}', 'sync-roadmap-coach-other-${OTHER}@example.com', 'Other')`);
const sessionOf = (account) => {
  const secret = randomBytes(24).toString('hex');
  psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
  return secret;
};
const count = (sql) => Number(psql(sql));

// ── MCP over HTTP, as the server's shared bearer ───────────────────────────────────────────────────────────────────
let mcpSession = null;
let serial = 0;
const rpc = async (method, params) => {
  const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
  mcpSession ??= response.headers.get('Mcp-Session-Id');
  return (await response.json()).result;
};
const tool = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args });
  return { error: result?.isError === true, body: result?.isError ? null : JSON.parse(result?.content?.[0]?.text ?? 'null') };
};

// ── a browser: its engine over HTTP, signed in as an account, and the kit's runner over it ───────────────────────
const failures = [];
const timers = new FakeTimers();
timers.time = Date.now();
const sent = [];
async function browser(name, account) {
  const secret = sessionOf(account);
  const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
    reading: () => ({ wall: timers.time, mono: timers.time, boot: name }),
    scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
    socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
    fetch: (url, options) => {
      sent.push(options.headers?.['Sync-Schema'] ?? null);
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
      return fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${secret}` } });
    } });
  // The engine draws as a browser does, since the domain mints ids from it, and the device clock follows the wall clock,
  // so no stamp runs ahead of the server's skew bound.
  const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name, registry, transport, timers,
    draw: (bound) => randomInt(bound), now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
    document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
  await engine.signIn(account);
  await engine.start();
  engine.observe(RoadmapScopes.account);
  const pending = () => engine.device.activeReplica.outbox.filter((entry) => ['ready', 'sent', 'held'].includes(entry.state));
  const round = async () => {
    for (let turn = 0; !engine.leader; turn++) {
      if (turn === 1000) throw new Error('the engine never became the leader');
      await new Promise((done) => setImmediate(done));
    }
    timers.time = Math.max(timers.time + 1, Date.now());
    engine.kick();
    await engine.send();
    engine.kickPull();
    await engine.pull();
  };
  return {
    engine,
    runner: new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0)),
    async settle() {
      for (let turn = 0; turn < 30 && pending().length; turn++) await round();
      for (let turn = 0; turn < 5; turn++) await round();
    },
    rows: (t) => engine.device.activeReplica.confirmedRows(RoadmapScopes.account).filter((row) => row.t === t && row.life?.[0] !== 'dead'),
  };
}

const hello = await (await fetch(`${base}/v1/sync/hello`, { headers: { 'Sync-Schema': String(registry.version) }, signal: AbortSignal.timeout(REQUEST_MS) })).json();
check(registry.version === 15 && hello.schema === 15 && hello.minSchema === 15, 'the clients speak schema 15, the registry\'s, and hello answers 15 / minimum 15',
  `client ${registry.version}, server ${hello.schema}/${hello.minSchema}`);

const first = await browser('coach-first', ACCOUNT);
const second = await browser('coach-second', ACCOUNT);
const other = await browser('coach-other', OTHER);
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sync-roadmap-coach', version: '1' } });
  const made = await first.runner.runAct(new CreateRoadmap('A coach roadmap'));
  const tree = String(made.result?.tree);
  const asked = await first.runner.runAct(new OpenTurn({ about: { treeId: tree }, question: 'What should I do next?' }));
  const turn = asked.result;
  const ended = await first.runner.runAct(new EndTurn(new Id(turn.coach, CoachMessage), { state: 'completed', text: 'Start with the basics.' }));
  const everything = await first.runner.runAct(new OpenTurn({ about: { treeId: null }, question: 'Which roadmap next?' }));
  await first.settle();
  check([made, asked, ended, everything].every((outcome) => outcome.kind === 'committed'), 'the first browser makes a roadmap and two conversations, and ends a turn',
    [made, asked, ended, everything].map((outcome) => outcome.kind).join(','));
  check(count(`select count(*) from roadmap_coach_messages where scope_key = 'acct:${ACCOUNT}/roadmap' and life_stamp is not null`) === 4,
    'the server stores the four messages', 'another count');

  await second.settle();
  const conversationOn = (phone, thread) => phone.runner.read(RoadmapScopes.account, (read) => Conversation.read(read, new Id(thread, CoachThread)));
  const drawn = conversationOn(second, turn.thread);
  check(drawn !== null && drawn.thread.treeId === tree && drawn.messages.length === 2 && drawn.messages[1]?.state === 'completed'
    && drawn.messages[1]?.text === 'Start with the basics.', 'the account\'s second browser draws the conversation, its answer ended, by sync',
  drawn === null ? 'none' : `${drawn.messages.length} messages`);
  check(conversationOn(second, everything.result.thread)?.thread.treeId === null, 'and the conversation about every roadmap', 'none');

  await other.settle();
  check(['coachThread', 'coachMessage'].every((t) => other.rows(t).length === 0) && conversationOn(other, turn.thread) === null,
    'the other account draws no conversation of this one', `${other.rows('coachThread').length} conversations`);

  const deleted = await tool('roadmap_delete_tree', { treeId: tree, requestId: 'e2e-coach-delete' });
  check(!deleted.error, 'MCP deletes the roadmap', 'the tool refused');
  await second.settle();
  check(conversationOn(second, turn.thread) === null && second.rows('coachMessage').every((row) => row.f?.threadId?.[0] !== turn.thread),
    'the second browser, which never touched the roadmap, no longer draws its conversation or its messages', 'it still draws them');
  check(conversationOn(second, everything.result.thread) !== null, 'the conversation about every roadmap stays', 'it went');
  check(count(`select count(*) from roadmap_coach_messages where thread_id = '${turn.thread}'`) === 0
    && count(`select count(*) from roadmap_coach_threads where scope_key = 'acct:${ACCOUNT}/roadmap'`) === 1,
  'the server holds no message of the deleted conversation, and one conversation stays', 'rows remain');

  check(sent.length > 0 && sent.every((schema) => schema === '15'), 'every request the browsers sent carried Sync-Schema 15', `${new Set(sent).size} carriers`);
  check(failures.length === 0, 'the engines report no failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  for (const phone of [first, second, other]) phone.engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
