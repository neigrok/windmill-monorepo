#!/usr/bin/env node
// Typed references inside values (engine.md §2.4 References, E-8) end to end: the production browser engine over HTTP
// against windmill_server_probe on :$PORT and a THROWAWAY Postgres. This script wipes every sync_* and probe_* row of
// $WM_E2E_DB.
// - Another replica's probe.sprout makes a step own a subtree. This engine's queued sprout of the same step is answered
//   with that subtree, and its queued work follows it: a tag created in the proposed child's tree, a mark in its
//   overlay, and a grandchild sprout whose parent names the proposed child by board and the new tag by step. The
//   server stores the grandchild's parent as {board: the owned subtree, tag: the same step}.
// - probe.adopt answers the tree's tag that already carries the label, and a queued mark keyed by the proposed tag
//   lands on the adopted one.
// - Everything converges: no entry stays pending, no notice is written, and every scope's confirmed rows match the
//   server's digest. The live socket stays closed, so the HTTP puller alone covers each scope.
// The output names checks only, never a record id or a label.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql -f db/probe.sql, and the probe server running on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8089 ./build/windmill_server_probe
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8089 node test/e2e/sync_probe_references.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';
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
const email = 'sync-probe-references-e2e@example.com';
psql(`insert into users (id, email, name) values (gen_random_uuid(), '${email}', 'Probe') on conflict (email) do nothing`);
const account = psql(`select id from users where email = '${email}'`);
const secret = randomBytes(24).toString('hex');
psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
const authorized = (headers = {}) => ({ ...headers, Authorization: `Bearer ${secret}` });

const timers = new FakeTimers();
timers.time = Date.now();
const failures = [];
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'sync-probe-references' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
    return fetch(url, { ...options, signal, headers: authorized(options.headers) });
  } });
// Backoffs draw zero and the device clock follows the wall clock, so every round may send and no stamp runs ahead of
// the server's skew bound.
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'sync-probe-references', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { event() {}, failure(operation) { failures.push(operation); } } });
const leading = async () => {
  for (let turn = 0; !engine.leader; turn++) {
    if (turn === 1000) throw new Error('the engine never became the leader');
    await new Promise((done) => setImmediate(done));
  }
};
// Another replica of the same account, pushing one command intent over HTTP.
const pushAsAnotherReplica = async (cmd) => {
  const response = await fetch(`${base}/v1/sync/push`, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
    headers: authorized({ 'Sync-Schema': String(registry.version), 'content-type': 'application/json' }),
    body: JSON.stringify({ replica: `rp_${randomBytes(16).toString('hex')}`, account, ackThrough: 0,
      intents: [{ n: 1, scope: 'self/probe', cmd, gestureId: 'g-another-replica' }] }) });
  return (await response.json()).results?.[0];
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
  const sprout = (board, tag, child) => ({ cmd: { name: 'probe.sprout', args: { board, tag, child } },
    predict: [{ op: 'create', t: 'board', id: child, f: { parent: { board, tag } } }] });

  const root = 'b_e8e80000', owned = 'b_e8e80001', proposed = 'b_e8e80002', grandchild = 'b_e8e80003';
  await engine.commit('self/probe', [{ op: 'create', t: 'board', id: root }]);
  await settle();
  check(replica().outbox.length === 0, 'a root board is confirmed', `${replica().outbox.length} entries remain`);

  const elsewhere = await pushAsAnotherReplica({ name: 'probe.sprout', args: { board: root, tag: 'oak', child: owned } });
  check(elsewhere?.s === 'ok' && same(elsewhere.write?.map(({ t, id }) => [t, id]), [['board', owned]]),
    'another replica\'s sprout makes the step own a subtree', `outcome ${elsewhere?.s} ${elsewhere?.code ?? ''}`);

  await engine.commit('self/probe', [], sprout(root, 'oak', proposed));
  await engine.commit(`tree/${proposed}`, [{ op: 'create', t: 'tag', id: 'pine', f: { label: 'Pine' } }]);
  await engine.commit('self/probe', [], sprout(proposed, 'pine', grandchild));
  await engine.commit(`self/overlay/${proposed}`, [{ op: 'write', t: 'mark', id: 'pine', f: { done: true } }]);
  await settle();
  const parentOf = (id) => JSON.parse(psql(`select parent::text from probe_boards where id = '${id}'`) || 'null');
  check(psql(`select count(*) from probe_boards where id = '${proposed}'`) === '0', 'the proposed child is never created', 'it exists');
  const stored = parentOf(grandchild);
  check(stored?.board === owned && stored?.tag === 'pine' && Object.keys(stored).length === 2,
    'the grandchild\'s parent names the owned subtree and keeps its step', 'another parent');
  check(psql(`select scope_key from probe_tags where id = 'pine'`) === `tree:${owned}`, 'the tag queued in the proposed tree lands in the owned one',
    'another scope');
  check(psql(`select scope_key from probe_marks where id = 'pine'`) === `acct:${account}/overlay/${owned}`,
    'the mark queued in the proposed overlay lands in the owned tree\'s', 'another scope');

  await engine.commit(`tree/${owned}`, [], { cmd: { name: 'probe.adopt', args: { tag: 'elm', label: 'Pine' } },
    predict: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Pine' } }] });
  await engine.commit(`self/overlay/${owned}`, [{ op: 'write', t: 'mark', id: 'elm', f: { done: false } }]);
  await settle();
  check(psql(`select count(*) from probe_tags where id = 'elm'`) === '0', 'adopt creates no tag where its label is taken', 'a tag exists');
  check(psql(`select count(*) from probe_marks where id = 'elm'`) === '0' && psql(`select done from probe_marks where id = 'pine'`) === 'f',
    'the mark keyed by the proposed tag lands on the adopted one', 'another mark');

  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every entry settles and no notice is written',
    `${replica().outbox.length} entries, ${replica().notices.length} notices`);
  const scopes = ['self/probe', `tree/${root}`, `tree/${owned}`, `tree/${grandchild}`, `self/overlay/${owned}`];
  const matching = [];
  for (const scope of scopes) {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    const page = response.body?.pages?.[0];
    matching.push(page?.kind === 'rows' && !page.more && scopeDigest(replica().confirmedRows(scope)) === page.digest);
  }
  check(matching.every(Boolean), 'every scope\'s confirmed rows match the server\'s digest', `${matching.filter(Boolean).length} of ${scopes.length} match`);
  check(failures.length === 0, 'no failure is reported', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
