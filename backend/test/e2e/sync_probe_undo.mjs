#!/usr/bin/env node
// Undo of an act (K-3, engine.md §6.4, §7.3) end to end: the production browser engine over HTTP against
// windmill_server_probe on :$PORT and a THROWAWAY Postgres. This script wipes every sync_* and probe_* row of $WM_E2E_DB.
// - An opted act over the product scope and a tree journals its receipts; its Undo restores both fields through
//   probe.restore and probe.restoreTree, a lost reply included, and settles with what it applied.
// - An edit queued after an Undo wins once the restore's ACK reclocks it.
// - probe.branch undone by probe.unbranch over the evidence the engine builds: the board dies with its tree and the
//   parent takes back its title.
// - A held removal cancelled in place, then redone: the Redo removes it again under the version it found.
// - A tag born by an act that keeps no journal and removed by an opted act before either was sent: the removal's Undo
//   walks from the birth's row and the tag comes back.
// - Everything converges: no entry stays pending, no notice is written, and every scope's confirmed rows match the
//   server's digest. The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql -f db/probe.sql, and the probe server running on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8089 ./build/windmill_server_probe
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8089 node test/e2e/sync_probe_undo.mjs

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
const email = 'sync-probe-undo-e2e@example.com';
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
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'sync-probe-undo' }),
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
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'sync-probe-undo', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null,
  // One writer event a transaction shares the per-minute telemetry bound with failures; the run takes the most the
  // reporter allows, so its one expected failure is not crowded out.
  telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
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
  const confirmed = (scope, t, id) => replica().confirmedRows(scope).find((row) => row.t === t && row.id === id);
  const target = (scope, t, id, slot) => ({ scope, t, id, slot });
  const fields = (index, restoreCommand, targets) => ({ index, recipes: [{ kind: 'fields', restoreCommand, targets: targets.map((item) => ({ target: item })) }] });

  const parent = 'b_5c0f0001', child = 'b_5c0f0002', card = 'cardUndoE2E00001', tree = `tree/${parent}`;
  // The replica keeps the rows of the scopes it observes in memory, as a product's screen does.
  engine.observe('self/probe');
  engine.observe(tree);
  await engine.commit('self/probe', [{ op: 'create', t: 'board', id: parent }]);
  await engine.commit('self/probe', [{ op: 'create', t: 'card', id: card, f: { title: 'Before' } }]);
  await engine.commit(tree, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Root' } }, { op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], { atomic: true });
  await settle();
  check(replica().outbox.length === 0, 'a board, a card and its tree are confirmed before any act', `${replica().outbox.length} entries remain`);

  const cardTitle = target('self/probe', 'card', card, { kind: 'field', name: 'title' });
  const metaTitle = target(tree, 'meta', 'meta', { kind: 'field', name: 'title' });
  const { outcome: act } = await engine.commitAct([
    { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: card, f: { title: 'Renamed' } }] },
    { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Grown' } }] },
  ], { undo: { version: 1, segments: [fields(0, 'probe.restore', [cardTitle]), fields(1, 'probe.restoreTree', [metaTitle])] } });
  await settle();
  check(replica().journal.find(({ actId }) => actId === act.gestureId)?.sourceEntries.every(({ attempts }) => attempts[0]?.outcome === 'ok'),
    'an opted act keeps each source\'s accepted receipt after it settles', 'a source without its receipt');
  const undo = await engine.requestInverse(act.gestureId);
  check(undo.kind === 'pending' && undo.localChanged, 'its Undo is reserved and drawn at once', `answered ${undo.kind}`);
  loseReply = true;
  await round();
  await settle();
  const undone = engine.readInverseResult(undo.requestId);
  check(same(undone, { kind: 'settled', requestId: undo.requestId, inverseActId: undo.inverseActId, changed: true, appliedCount: 2, skippedCount: 0 }),
    'the Undo settles after a lost reply with both fields restored', `answered ${undone.kind} ${undone.appliedCount ?? ''}/${undone.skippedCount ?? ''}`);
  check(confirmed('self/probe', 'card', card)?.f.title[0] === 'Before' && confirmed(tree, 'meta', 'meta')?.f.title[0] === 'Root',
    'the server holds both earlier values', 'another value');

  const { outcome: again } = await engine.commitAct([{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: card, f: { title: 'Again' } }] }],
    { undo: { version: 1, segments: [fields(0, 'probe.restore', [cardTitle])] } });
  await settle();
  await engine.requestInverse(again.gestureId);
  await engine.commit('self/probe', [{ op: 'update', t: 'card', id: card, f: { title: 'Mine' } }]);
  await settle();
  check(confirmed('self/probe', 'card', card)?.f.title[0] === 'Mine', 'an edit queued after an Undo wins over the restore', 'the restore won');

  const { outcome: branched } = await engine.commitAct([{ scope: 'self/probe', changes: [], opts: {
    cmd: { name: 'probe.branch', args: { parent, child, title: 'Branch' } },
    scopedPredict: [{ scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: child }] },
      ...[parent, child].map((id) => ({ scope: `tree/${id}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] }))] } }],
  { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'command', command: 'probe.unbranch', input: { parent, child, title: 'Root' },
    evidence: { ownedFields: [metaTitle], unchangedCreatedRecords: [{ scope: 'self/probe', t: 'board', id: child }], unchangedCreatedScopes: [`tree/${child}`] } }] }] } });
  await settle();
  const unbranch = await engine.requestInverse(branched.gestureId);
  await settle();
  const unbranched = engine.readInverseResult(unbranch.requestId);
  check(unbranched.kind === 'settled' && unbranched.appliedCount === 1, 'probe.unbranch runs over the engine\'s evidence and applies',
    `answered ${unbranched.kind} ${unbranched.appliedCount ?? ''}/${unbranched.skippedCount ?? ''}`);
  check(!confirmed('self/probe', 'board', child) && confirmed(tree, 'meta', 'meta')?.f.title[0] === 'Root',
    'the created board is gone and the parent has its title back', 'a board or title remains');
  check(psql(`select state from sync_scopes where key = 'tree:${child}'`) === 'dead', 'the created tree died with its board', 'the tree lives');

  const { outcome: removal } = await engine.commitAct([{ scope: tree, changes: [{ op: 'delete', t: 'tag', id: 'oak' }], opts: { hold: true } }],
    { undo: { version: 1, segments: [fields(0, 'probe.restoreTree', [target(tree, 'tag', 'oak', { kind: 'life' })])] } });
  const cancelled = await engine.requestInverse(removal.gestureId);
  check(cancelled.kind === 'cancelled' && cancelled.changed, 'a held removal\'s Undo cancels it in place', `answered ${cancelled.kind}`);
  const redo = await engine.requestInverse(cancelled.inverseActId);
  await settle();
  const redone = engine.readInverseResult(redo.requestId);
  check(redone.kind === 'settled' && redone.appliedCount === 1 && !confirmed(tree, 'tag', 'oak'), 'its Redo removes the tag under the version it found',
    `answered ${redone.kind} ${redone.appliedCount ?? ''}`);

  const sent = pushes.length;
  const { outcome: birth } = await engine.commitAct([{ scope: tree, changes: [{ op: 'create', t: 'tag', id: 'ash', f: { label: 'Ash' } }] }],
    { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: tree, t: 'tag', id: 'ash' } }] }] } });
  await engine.releaseReversibleAct(birth.gestureId);
  const { outcome: unmade } = await engine.commitAct([{ scope: tree, changes: [{ op: 'delete', t: 'tag', id: 'ash' }] }],
    { undo: { version: 1, segments: [fields(0, 'probe.restoreTree', [target(tree, 'tag', 'ash', { kind: 'life' })])] } });
  check(pushes.length === sent && !replica().journal.some(({ actId }) => actId === birth.gestureId),
    'a tag is born by an act that keeps no journal and removed before either is sent', `${pushes.length - sent} pushes went first`);
  await settle();
  const unmake = await engine.requestInverse(unmade.gestureId);
  await settle();
  const remade = engine.readInverseResult(unmake.requestId);
  check(same(remade, { kind: 'settled', requestId: unmake.requestId, inverseActId: unmake.inverseActId, changed: true, appliedCount: 1, skippedCount: 0 })
    && confirmed(tree, 'tag', 'ash')?.f.label[0] === 'Ash', 'the removal\'s Undo walks from that birth and the server holds the tag again',
    `answered ${remade.kind} ${remade.appliedCount ?? ''}/${remade.skippedCount ?? ''}`);

  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every entry settles and no notice is written',
    `${replica().outbox.length} entries, ${replica().notices.length} notices`);
  const scopes = ['self/probe', tree];
  const matching = [];
  for (const scope of scopes) {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    const page = response.body?.pages?.[0];
    matching.push(page?.kind === 'rows' && !page.more && scopeDigest(replica().confirmedRows(scope)) === page.digest);
  }
  check(matching.every(Boolean), 'every scope\'s confirmed rows match the server\'s digest', `${matching.filter(Boolean).length} of ${scopes.length} match`);
  check(same([...new Set(failures)], ['transport']), 'only the lost reply reports a failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
