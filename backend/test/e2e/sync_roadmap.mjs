#!/usr/bin/env node
// Roadmap on the sync engine end to end (roadmap-on-the-engine.md §4, engine.md Appendix A.1): the production browser
// engine over HTTP, under the composed registry, against windmill_server serving roadmap's scopes on :$PORT and a
// THROWAWAY Postgres. This script wipes every sync_* row of $WM_E2E_DB, and roadmap's engine rows with them.
// - A roadmap: its `tree` record, then its title, genesis kinds, two steps, one carrying a link, and the link between them.
// - roadmap.createSubtree under the first step: the server plants the subtree's record, its meta one deeper with the
//   root's reach, its genesis kinds and the step's branch.
// - The root's visibility: the server writes the root's reach and the standing subtree's.
// - roadmap.recolourKind: the kind's hue and the colour of the step wearing it.
// - The first step's delete ends the subtree's standing: the server writes its reach private.
// - Everything converges: no entry stays pending, no notice is written, and every scope's confirmed rows match the
//   server's digest. The live socket stays closed, so the HTTP puller alone carries each consequence back.
// The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql, and the server serving roadmap on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8090 ROADMAP_ENGINE_ENABLED=1 ./build/windmill_server
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8090 node test/e2e/sync_roadmap.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';
import { scopeDigest } from '../../../packages/api-contract/sync/reference/core/digest.js';

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
for (const table of ['sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
const email = 'sync-roadmap-e2e@example.com';
psql(`insert into users (id, email, name) values (gen_random_uuid(), '${email}', 'Roadmap') on conflict (email) do nothing`);
const account = psql(`select id from users where email = '${email}'`);
const secret = randomBytes(24).toString('hex');
psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
const authorized = { Authorization: `Bearer ${secret}`, 'Sync-Schema': String(registry.version) };
const hello = async () => (await fetch(`${base}/v1/sync/hello`, { headers: authorized, signal: AbortSignal.timeout(REQUEST_MS) })).json();

const served = await hello();
check(served.schema === registry.version && served.minSchema === registry.minVersion && served.holdsRecords?.roadmap === false,
  'hello names the composed schema and the account holds no roadmap yet', `schema ${served.schema}/${served.minSchema}`);

// ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────────
const timers = new FakeTimers();
timers.time = Date.now();
const failures = [];
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'sync-roadmap' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
    return fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${secret}` } });
  } });
// Backoffs draw zero and the device clock follows the wall clock, so every round may send and no stamp runs ahead of
// the server's skew bound.
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'sync-roadmap', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
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
  const confirmed = (scope, t, id) => replica().confirmedRows(scope).find((row) => row.t === t && same(row.id, id));
  const value = (scope, t, id, field) => confirmed(scope, t, id)?.f?.[field]?.[0];
  const stored = (table, scope, id, column) => psql(`select ${column} from ${table} where scope_key = '${scope}' and id = '${id}'`);

  const root = 't_00000000000000e1', subtree = 't_00000000000000e2';
  const tree = `tree/${root}`, below = `tree/${subtree}`;
  const genesis = [['build', 'terracotta', 'Build', 'Things you make', 'a0'], ['learn', 'olive', 'Learn', 'Things you figure out', 'a1'],
    ['milestone', 'gold', 'Milestone', 'Moments that matter', 'a2']];
  for (const scope of ['self/roadmap', tree, below]) engine.observe(scope);

  await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: root }]);
  await engine.commit(tree, [
    { op: 'write', t: 'meta', id: 'meta', f: { title: 'A roadmap' } },
    ...genesis.map(([id, hue, label, description, ord]) => ({ op: 'create', t: 'kind', id, f: { hue, label, description, ord } })),
    { op: 'create', t: 'node', id: 'basics', f: { label: 'Basics', ord: 'a0', color: 'olive', links: [{ url: 'https://example.com/guide', label: 'Guide' }] } },
    { op: 'create', t: 'node', id: 'ownership', f: { label: 'Ownership', ord: 'a1' } },
    { op: 'put', t: 'edge', id: ['basics', 'ownership'] },
  ], { atomic: true });
  await settle();
  check(stored('roadmap_trees', `acct:${account}/roadmap`, root, 'life') === 'alive' && stored('roadmap_kinds', `tree:${root}`, 'learn', 'hue') === 'olive',
    'a roadmap lands: its record in the account and its kinds in its tree', 'a record is missing');
  check(stored('roadmap_nodes', `tree:${root}`, 'basics', 'jsonb_array_length(links)') === '1' && stored('roadmap_edges', `tree:${root}`, '["basics","ownership"]', 'life') === 'alive',
    'a step lands with its link, and the link between the steps', 'a step, link or edge is missing');
  check((await hello()).holdsRecords?.roadmap === true, 'hello says the account holds a roadmap', 'it holds none');

  await engine.commit('self/roadmap', [], { cmd: { name: 'roadmap.createSubtree', args: { tree: root, root, step: 'basics', subtree } } });
  await settle();
  check(value(tree, 'node', 'basics', 'branch') === subtree && stored('roadmap_nodes', `tree:${root}`, 'basics', 'branch') === subtree,
    'createSubtree writes the step\'s branch, on the server and in the replica', 'the branch is unset');
  const place = value('self/roadmap', 'tree', subtree, 'parent');
  check(place?.tree === root && place?.step === 'basics' && value(below, 'meta', 'meta', 'depth') === 1
    && value(below, 'meta', 'meta', 'reach') === 'private' && genesis.every(([id, hue]) => value(below, 'kind', id, 'hue') === hue),
  'the subtree is planted: its place, its meta one deeper with the root\'s reach, and its genesis kinds', 'the subtree differs');

  await engine.commit(tree, [{ op: 'write', t: 'meta', id: 'meta', f: { visibility: 'public' } }]);
  await settle();
  check(stored('roadmap_metas', `tree:${root}`, 'meta', 'reach') === 'public' && stored('roadmap_metas', `tree:${subtree}`, 'meta', 'reach') === 'public'
    && value(below, 'meta', 'meta', 'reach') === 'public', 'the root\'s visibility writes its reach and the standing subtree\'s', 'a reach stayed private');

  await engine.commit(tree, [], { cmd: { name: 'roadmap.recolourKind', args: { kind: 'learn', hue: 'sky' } } });
  await settle();
  check(value(tree, 'kind', 'learn', 'hue') === 'sky' && value(tree, 'node', 'basics', 'color') === 'sky' && stored('roadmap_nodes', `tree:${root}`, 'ownership', 'color') === '',
    'recolourKind recolours the kind and the step wearing it, and no other', 'a colour differs');

  await engine.commit(tree, [{ op: 'delete', t: 'node', id: 'basics' }]);
  await settle();
  check(stored('roadmap_nodes', `tree:${root}`, 'basics', 'life') === 'dead' && stored('roadmap_metas', `tree:${subtree}`, 'meta', 'reach') === 'private'
    && value(below, 'meta', 'meta', 'reach') === 'private', 'deleting the step that owns the subtree ends its standing: its reach turns private', 'the subtree still reads');

  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every entry settles and no notice is written',
    `${replica().outbox.length} entries, ${replica().notices.length} notices`);
  const scopes = ['self/roadmap', tree, below];
  const matching = [];
  for (const scope of scopes) {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    const page = response.body?.pages?.[0];
    matching.push(page?.kind === 'rows' && !page.more && scopeDigest(replica().confirmedRows(scope)) === page.digest);
  }
  check(matching.every(Boolean), 'every scope\'s confirmed rows match the server\'s digest', `${matching.filter(Boolean).length} of ${scopes.length} match`);
  check(failures.length === 0, 'the engine reports no failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
