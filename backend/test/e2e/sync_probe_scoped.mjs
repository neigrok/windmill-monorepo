#!/usr/bin/env node
// Scoped predictions and their receipts (engine.md §6.4, §7.4) end to end: the production browser engine over HTTP
// against windmill_server_probe on :$PORT and a THROWAWAY Postgres. This script wipes every sync_* and probe_* row of
// $WM_E2E_DB.
// - probe.branch: a lost reply retried by the same replica answers the exact saved receipt; a lost reply replayed by a
//   new replica resolves by the branch receipt, creating nothing and changing no row.
// - probe.capture, probe.captureTree and probe.captureOverlay answer the versions they committed, and a write guarded
//   on a captured register is admitted.
// - Everything converges: no entry stays pending, no notice is written, and every scope's confirmed rows match the
//   server's digest. The live socket stays closed, so the HTTP puller alone covers each projection.
// The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql -f db/probe.sql, and the probe server running on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8089 ./build/windmill_server_probe
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8089 node test/e2e/sync_probe_scoped.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';
import { reidentify, renewActor } from '../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { scopeDigest } from '../../../packages/api-contract/sync/reference/core/digest.js';
import { Registry } from '../../../packages/api-contract/sync/reference/core/registry.js';

const DEADLINE_MS = 180_000;
const REQUEST_MS = 10_000;
const DB = process.env.WM_E2E_DB;
const PORT = Number(process.env.PORT);
if (!DB || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || process.argv.length > 2) {
  console.error('set WM_E2E_DB to a throwaway database (name or postgresql:// URL) and PORT to the server\'s port; the script takes no arguments');
  process.exit(2);
}
setTimeout(() => {
  console.log(`Deadline exceeded after ${DEADLINE_MS / 1000} s`);
  process.exit(1);
}, DEADLINE_MS).unref();

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { IDBFactory, IDBKeyRange } = createRequire(`${repo}web/package.json`)('fake-indexeddb');
const registry = new Registry(JSON.parse(readFileSync(`${repo}packages/api-contract/sync/probe.registry.json`, 'utf8')));
const base = `http://127.0.0.1:${PORT}`;
const results = { pass: 0, fail: 0 };
const check = (ok, label, detail) => {
  if (ok) results.pass++;
  else results.fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── a clean engine and a session ───────────────────────────────────────────────────────────────────────────────────
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();
for (const table of ['probe_marks_revisions', 'probe_start_receipts', 'probe_copy_receipts', 'probe_branch_receipts', 'probe_marks',
  'probe_links', 'probe_tags', 'probe_metas', 'probe_facts', 'probe_days', 'probe_laps', 'probe_runs', 'probe_cards', 'probe_boards',
  'sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
const email = 'sync-probe-scoped-e2e@example.com';
psql(`insert into users (id, email, name) values (gen_random_uuid(), '${email}', 'Probe') on conflict (email) do nothing`);
const account = psql(`select id from users where email = '${email}'`);
const secret = randomBytes(24).toString('hex');
psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);

// ── the engine, its pushes recorded and a reply lost on demand ─────────────────────────────────────────────────────
const timers = new FakeTimers();
timers.time = Date.now();
const pushes = [];
const failures = [];
let loseReply = false;
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'sync-probe-scoped' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: async (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
    const response = await fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${secret}` } });
    if (!url.endsWith('/push')) return response;
    const text = await response.text();
    pushes.push({ request: JSON.parse(options.body), body: text ? JSON.parse(text) : null });
    if (loseReply) {
      loseReply = false;
      throw new Error('the reply is lost after admission');
    }
    return new Response(text, { status: response.status, headers: response.headers });
  } });
// Backoffs draw zero and the device clock follows the wall clock, so every round may send and no stamp runs ahead of
// the server's skew bound.
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'sync-probe-scoped', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { event() {}, failure(operation) { failures.push(operation); } } });
const leading = async () => {
  for (let turn = 0; !engine.leader; turn++) {
    if (turn === 1000) throw new Error('the engine never became the leader');
    await new Promise((done) => setImmediate(done));
  }
};
try {
  await engine.signIn(account);
  await engine.start();
  const replica = () => engine.device.activeReplica;
  const pending = () => replica().outbox.filter((entry) => ['ready', 'sent'].includes(entry.state));
  const round = async () => {
    await leading();
    timers.time = Math.max(timers.time + 1, Date.now());
    engine.kick();
    await engine.send();
    engine.kickPull();
    await engine.pull();
  };
  const settle = async () => {
    for (let turn = 0; turn < 30 && pending().length; turn++) await round();
    for (let turn = 0; turn < 5; turn++) await round();
  };
  // Every answer the server gave an intent; a push that continues before the intent answers nothing for it.
  const resultsOf = (match) => pushes.flatMap(({ request, body }) => {
    const intent = request.intents.find(match);
    const result = intent && body?.results?.find(({ n }) => n === intent.n);
    return result ? [result] : [];
  });

  const parent = 'b_5c0e0001', child = 'b_5c0e0002', replayed = 'b_5c0e0003', card = 'cardScopedE2E001';
  await engine.commit('self/probe', [{ op: 'create', t: 'board', id: parent }]);
  await engine.commit('self/probe', [{ op: 'create', t: 'card', id: card, f: { title: 'Before' } }]);
  await settle();
  check(replica().outbox.length === 0, 'a board and a card are confirmed before the scoped commands', `${replica().outbox.length} entries remain`);

  const branch = (id) => ({ cmd: { name: 'probe.branch', args: { parent, child: id, title: 'Branch' } }, scopedPredict: [
    { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id }] },
    ...[parent, id].map((tree) => ({ scope: `tree/${tree}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] })),
  ] });
  const ofBranch = (id) => (intent) => intent.cmd?.name === 'probe.branch' && intent.cmd.args.child === id;

  await engine.commit('self/probe', [], branch(child));
  loseReply = true;
  await round();
  await settle();
  const retried = resultsOf(ofBranch(child));
  check(retried.length === 2 && same(retried[0], retried[1]), 'a lost probe.branch reply retried by its replica answers the exact saved receipt',
    `${retried.length} answers`);
  check(retried[0]?.s === 'ok' && same(retried[0].detail.command, { created: true }), 'the saved receipt keeps the command\'s own detail',
    `outcome ${retried[0]?.s}`);

  await engine.commit('self/probe', [], branch(replayed));
  loseReply = true;
  await round();
  const before = replica().id;
  await engine.write(null, (device, ctx) => { reidentify(device.activeReplica, ctx); renewActor(ctx); });
  await settle();
  const answers = resultsOf(ofBranch(replayed));
  const replicas = pushes.filter(({ request }) => request.intents.some(ofBranch(replayed))).map(({ request }) => request.replica);
  const [first, replay] = answers;
  check(answers.length === 2 && replicas[0] === before && replicas[1] !== before && replay?.s === 'ok',
    'a lost probe.branch reply replayed by a new replica resolves by its receipt', `${answers.length} answers, outcome ${replay?.s} ${replay?.code ?? ''}`);
  check(replay?.s === 'ok' && same(replay.write, first?.write), 'the replay maps the same board as the admission', 'another write map');
  check(replay?.s === 'ok' && same(replay.detail.command, { created: false })
    && same(replay.detail.windmillKit.effects.map(({ scope, beforeSeq, seq, rows }) => [scope, beforeSeq === seq, rows.length]),
      [['self/probe', true, 0], [`tree/${parent}`, true, 0], [`tree/${replayed}`, true, 0]]),
  'the replay creates nothing and changes no row in any of its three scopes', 'another receipt');

  const capture = (scope, changes, name) => engine.commit(scope, changes, { cmd: { name, args: {} } });
  await capture('self/probe', [{ op: 'update', t: 'card', id: card, f: { title: 'Captured' } }], 'probe.capture');
  await engine.commit('self/probe', [{ op: 'update', t: 'card', id: card, f: { body: 'Guarded' } }], { guard: [{ t: 'card', id: card, field: 'title' }] });
  await capture(`tree/${child}`, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Tree' } }], 'probe.captureTree');
  await capture(`self/overlay/${child}`, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'Overlay' } }], 'probe.captureOverlay');
  await settle();
  const [product] = resultsOf((intent) => intent.cmd?.name === 'probe.capture');
  const [tree] = resultsOf((intent) => intent.cmd?.name === 'probe.captureTree');
  const [overlay] = resultsOf((intent) => intent.cmd?.name === 'probe.captureOverlay');
  const [guarded] = resultsOf((intent) => intent.guard !== undefined);
  check(product?.s === 'ok' && same(product.detail.windmillKit.effects.map(({ scope, rows }) => [scope, rows.map(({ slots }) => slots.map(({ slot }) => slot))]),
    [['self/probe', [[{ kind: 'field', name: 'title' }]]]]), 'probe.capture\'s receipt versions the captured field alone', `outcome ${product?.s}`);
  check(tree?.s === 'ok' && same(tree.detail.windmillKit.effects.map(({ scope }) => scope), [`tree/${child}`]),
    'probe.captureTree\'s receipt names its tree alone', `outcome ${tree?.s}`);
  check(overlay?.s === 'ok' && overlay.detail.windmillKit.effects[0].rows[0].slots.at(-1).version.kind === 'text',
    'probe.captureOverlay\'s receipt versions the merged text revision', `outcome ${overlay?.s}`);
  check(guarded?.s === 'ok', 'a write guarded on the captured register is admitted', `outcome ${guarded?.s} ${guarded?.code ?? ''}`);

  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every entry settles and no notice is written',
    `${replica().outbox.length} entries, ${replica().notices.length} notices`);
  const scopes = ['self/probe', `tree/${parent}`, `tree/${child}`, `tree/${replayed}`, `self/overlay/${child}`];
  const matching = [];
  for (const scope of scopes) {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    const page = response.body?.pages?.[0];
    matching.push(page?.kind === 'rows' && !page.more && scopeDigest(replica().confirmedRows(scope)) === page.digest);
  }
  check(matching.every(Boolean), 'every scope\'s confirmed rows match the server\'s digest', `${matching.filter(Boolean).length} of ${scopes.length} match`);
  check(same([...new Set(failures)], ['transport']), 'only the two lost replies report a failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
