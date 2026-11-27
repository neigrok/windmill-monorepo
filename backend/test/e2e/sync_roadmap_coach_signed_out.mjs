#!/usr/bin/env node
// A signed-out person's Roadmap Coach records at sign-in (roadmap-coach.md §11, engine.md §7.10), against windmill_server
// serving roadmap's scopes on :$PORT and a THROWAWAY Postgres. This script wipes every sync_* row of $WM_E2E_DB, and
// roadmap's engine rows with them.
// - Every request carries the registry's schema, 15, and hello answers it.
// - The account's own browser makes a roadmap, so a sign-in with signed-out work is asked about it.
// - A browser with no account makes a roadmap, a conversation about it whose turn ended, and a pending proposal about it;
//   the server holds none of it while it is signed out.
// - It signs in: the roadmap decision is due and counts the conversation and the proposal. Add sends them, and the
//   account's own browser draws the roadmap, the conversation and its answer, and the proposal still pending on that
//   roadmap's id.
// - Another browser with no account does the same and answers Discard: neither the server nor the account's browser
//   holds anything of it, and the browser itself draws none of it.
// The output names checks only, never a record id, a question or an answer.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql, and the server serving roadmap on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8298 ROADMAP_ENGINE_ENABLED=1 ./build/windmill_server
// Run:  WM_E2E_DB=<database> PORT=8298 node test/e2e/sync_roadmap_coach_signed_out.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { ActionRunner, EngineReplica } from '../../../web/src/platform/domain-kit/runner.js';
import { Id } from '../../../web/src/platform/domain-kit/entities.js';
import { Plan } from '../../../web/src/platform/domain-kit/plans.js';
import { FixedZone } from '../../../web/src/platform/domain-kit/time.js';
import { Valid } from '../../../web/src/platform/domain-kit/validation.js';
import { CreateRoadmap, Roadmap } from '../../../web/src/products/roadmap/domain/roadmaps.js';
import { CoachMessage, CoachProposal, CoachThread, Conversation, EndTurn, OpenTurn } from '../../../web/src/products/roadmap/domain/conversation.js';
import { RoadmapScopes, writeIn } from '../../../web/src/products/roadmap/domain/roadmapRules.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';

const DEADLINE_MS = 180_000;
const REQUEST_MS = 10_000;
const DB = process.env.WM_E2E_DB;
const PORT = Number(process.env.PORT);
if (!DB || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || process.argv.length > 2) {
  console.error('set WM_E2E_DB to a throwaway database and PORT to the server\'s port; the script takes no arguments');
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

// ── a clean engine, the account and its sessions ───────────────────────────────────────────────────────────────────
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();
for (const table of ['sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
const ACCOUNT = randomUUID();
psql(`insert into users (id, email, name) values ('${ACCOUNT}', 'sync-roadmap-coach-signed-out-${ACCOUNT}@example.com', 'Coach')`);
const sessionOf = (account) => {
  const secret = randomBytes(24).toString('hex');
  psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
  return secret;
};
const count = (sql) => Number(psql(sql));
const ACCOUNT_SCOPE = `acct:${ACCOUNT}/roadmap`;
const held = () => ({
  threads: count(`select count(*) from roadmap_coach_threads where scope_key = '${ACCOUNT_SCOPE}' and life_stamp is not null`),
  messages: count(`select count(*) from roadmap_coach_messages where scope_key = '${ACCOUNT_SCOPE}' and life_stamp is not null`),
  proposals: count(`select count(*) from roadmap_coach_proposals where scope_key = '${ACCOUNT_SCOPE}' and life_stamp is not null`),
});

// ── a browser: its engine over HTTP, signed out until it signs in, and the kit's runner over it ──────────────────────
const failures = [];
const timers = new FakeTimers();
timers.time = Date.now();
const sent = [];
async function browser(name, account = null) {
  let secret = account ? sessionOf(account) : null;
  const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
    reading: () => ({ wall: timers.time, mono: timers.time, boot: name }),
    scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
    socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
    fetch: (url, options) => {
      sent.push(options.headers?.['Sync-Schema'] ?? null);
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
      return fetch(url, { ...options, signal, headers: { ...options.headers, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } });
    } });
  // The engine draws as a browser does, since the domain mints ids from it, and the device clock follows the wall clock,
  // so no stamp runs ahead of the server's skew bound.
  const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name, registry, transport, timers,
    draw: (bound) => randomInt(bound), now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
    document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
  if (account) await engine.signIn(account);
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
  const runner = new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0));
  return {
    engine,
    runner,
    async settle() {
      for (let turn = 0; turn < 30 && pending().length; turn++) await round();
      for (let turn = 0; turn < 5; turn++) await round();
    },
    // Signs in as `account` with a session of its own, the roadmap decision answered `answer`: the question it was asked.
    async signIn(signingIn, answer) {
      secret = sessionOf(signingIn);
      const asked = (await engine.signIn(signingIn)).due?.find((question) => question.product === 'roadmap') ?? null;
      const answered = asked ? await engine.signIn(signingIn, { decisions: { roadmap: answer }, counted: { roadmap: asked.counted } }) : null;
      return { asked, complete: answered?.complete === true };
    },
    // What the browser draws of Coach: each conversation with the roadmap it is about and its messages, and each proposal.
    coach: () => runner.read(RoadmapScopes.account, (read) => ({
      conversations: read.repository(CoachThread).all('drawn').map((thread) => ({ about: thread.treeId, messages: Conversation.read(read, thread.id).messages })),
      proposals: read.repository(CoachProposal).all('drawn').map((proposal) => ({ about: proposal.treeId, state: proposal.state })),
    })),
    roadmaps: () => runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').map((roadmap) => roadmap.id.record)),
  };
}

// A pending proposal about `tree` on Coach's answer, written raw: minting one is the propose ability's
// (m4-model-proposals), so the run writes the record's fields as the registry admits them.
class PendingProposal {
  constructor(tree, turn) {
    this.tree = tree;
    this.turn = turn;
  }

  load(read) { return read.inScope(RoadmapScopes.account, (account) => ({ moment: account.moment })); }

  decide({ moment }, ids) {
    const id = ids.mint(CoachProposal);
    const fields = () => ({ treeId: this.tree, threadId: this.turn.thread, messageId: this.turn.coach, base: { steps: {} },
      changes: [{ op: 'rename', nodeId: 'wind', label: 'Read the wind well' }], state: 'pending' });
    const plan = new Plan();
    plan.create(new Valid({ id, fields }, moment));
    return writeIn(RoadmapScopes.account, plan, id.record);
  }
}

// Signed out, on `phone`: a roadmap, a conversation about it whose turn Coach ended, and a pending proposal about it.
async function signedOutWork(phone) {
  const made = await phone.runner.runAct(new CreateRoadmap('A signed-out roadmap', { steps: [{ key: 'wind', label: 'A step' }], links: [] }));
  const tree = String(made.result?.tree);
  const asked = await phone.runner.runAct(new OpenTurn({ about: { treeId: tree }, question: 'What should I do first?' }));
  const ended = await phone.runner.runAct(new EndTurn(new Id(asked.result?.coach, CoachMessage), { state: 'completed', text: 'Start with the first step.' }));
  const proposed = await phone.runner.runAct(new PendingProposal(tree, asked.result));
  return { tree, made: [made, asked, ended, proposed].every((outcome) => outcome.kind === 'committed') };
}

const hello = await (await fetch(`${base}/v1/sync/hello`, { headers: { 'Sync-Schema': String(registry.version) }, signal: AbortSignal.timeout(REQUEST_MS) })).json();
check(registry.version === 15 && hello.schema === 15 && hello.minSchema === 15, 'the clients speak schema 15, the registry\'s, and hello answers 15 / minimum 15',
  `client ${registry.version}, server ${hello.schema}/${hello.minSchema}`);

const own = await browser('coach-own', ACCOUNT);
const adding = await browser('coach-adding');
const discarding = await browser('coach-discarding');
try {
  const kept = await own.runner.runAct(new CreateRoadmap('The account\'s roadmap'));
  await own.settle();
  check(kept.kind === 'committed' && count(`select count(*) from roadmap_trees where scope_key = '${ACCOUNT_SCOPE}'`) === 1,
    'the account\'s own browser makes a roadmap, which the server keeps', kept.kind);

  const work = await signedOutWork(adding);
  await adding.settle();
  check(work.made && adding.engine.device.activeReplica.meta.state === 'anon',
    'a browser with no account makes a roadmap, a conversation about it with Coach\'s answer, and a pending proposal', 'not all of it');
  check(JSON.stringify(held()) === JSON.stringify({ threads: 0, messages: 0, proposals: 0 }), 'the server holds none of it while the browser is signed out',
    JSON.stringify(held()));

  const added = await adding.signIn(ACCOUNT, 'add');
  check(added.asked?.count?.coachThread === 1 && added.asked?.count?.coachMessage === 2 && added.asked?.count?.coachProposal === 1 && added.asked?.count?.tree === 1,
    'at sign-in the roadmap decision is due, counting the roadmap, the conversation, its two messages and the proposal',
    JSON.stringify(added.asked?.count ?? null));
  check(added.complete, 'Add completes the sign-in', 'it did not complete');
  await adding.settle();
  check(JSON.stringify(held()) === JSON.stringify({ threads: 1, messages: 2, proposals: 1 }), 'the server stores the conversation, its two messages and the proposal',
    JSON.stringify(held()));

  await own.settle();
  const drawn = own.coach();
  const conversation = drawn.conversations.find((each) => each.about === work.tree);
  check(own.roadmaps().includes(work.tree), 'the account\'s own browser lists the roadmap made signed out, under its id', `${own.roadmaps().length} roadmaps`);
  check(conversation?.messages.length === 2 && conversation.messages[1]?.state === 'completed' && conversation.messages[1]?.text === 'Start with the first step.',
    'and draws the conversation about it, with Coach\'s answer ended', conversation ? `${conversation.messages.length} messages` : 'none');
  check(JSON.stringify(drawn.proposals) === JSON.stringify([{ about: work.tree, state: 'pending' }]), 'and the proposal, still pending on that roadmap',
    `${drawn.proposals.length} proposals`);

  const dropped = await signedOutWork(discarding);
  await discarding.settle();
  const discarded = await discarding.signIn(ACCOUNT, 'discard');
  check(dropped.made && discarded.asked?.count?.coachThread === 1 && discarded.complete, 'another browser with no account makes the same, and its sign-in answered Discard completes',
    JSON.stringify(discarded.asked?.count ?? null));
  await discarding.settle();
  await own.settle();
  check(JSON.stringify(held()) === JSON.stringify({ threads: 1, messages: 2, proposals: 1 }) && count(`select count(*) from roadmap_trees where scope_key = '${ACCOUNT_SCOPE}'`) === 2,
    'the server holds nothing of the discarded work', JSON.stringify(held()));
  const after = discarding.coach();
  check(!own.roadmaps().includes(dropped.tree) && own.coach().conversations.length === 1 && own.coach().proposals.length === 1,
    'the account\'s own browser draws nothing of it', `${own.coach().conversations.length} conversations`);
  check(!discarding.roadmaps().includes(dropped.tree) && after.conversations.every((each) => each.about !== dropped.tree) && after.proposals.every((each) => each.about !== dropped.tree),
    'and the browser that discarded it draws none of it', 'it still draws some');

  check(sent.length > 0 && sent.every((schema) => schema === '15'), 'every request the browsers sent carried Sync-Schema 15', `${new Set(sent).size} carriers`);
  check(failures.length === 0, 'the engines report no failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  for (const phone of [own, adding, discarding]) phone.engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
