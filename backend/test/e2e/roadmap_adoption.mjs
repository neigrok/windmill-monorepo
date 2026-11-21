#!/usr/bin/env node
// Production's roadmaps after their adoption onto the sync engine (roadmap-on-the-engine.md §8.1), served: the production
// browser engine over HTTP, under the composed registry, against windmill_server serving roadmap's scopes on :$PORT over
// a THROWAWAY Postgres that windmill_roadmap_adopt adopted from roadmap_adopt_fixture.sql.
// - The owner's replica pulls their roadmaps as the move adopted them: every `tree` record, the deleted ones dead, and the
//   cello roadmap's meta, steps in the old server's order, links, kinds, marks and pointer, each scope matching the server's digest.
// - A change of the owner's lands on an adopted roadmap: its seq continues above the old head, and the activity feed keeps
//   the lines the rooms wrote and tells the new one after them.
// - The reader reads the same public roadmap and their own mark on it, and never the owner's pointer.
// The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, and the adopted database served:
//   createdb -h /tmp --template=template0 --encoding=UTF8 "$WM_E2E_DB"
//   psql -h /tmp -d "$WM_E2E_DB" -f db/schema.sql -f test/platform/infra/roadmap_adopt_fixture.sql
//   printf 't_c000000000000001\nt_d000000000000001\n' > expected-ownerless
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" ROADMAP_ADOPTION_PRIVATE_DIR=private \
//     ROADMAP_ADOPTION_EXPECTED_OWNERLESS=expected-ownerless ./build/windmill_roadmap_adopt all
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8090 ROADMAP_ENGINE_ENABLED=1 ./build/windmill_server
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8090 node test/e2e/roadmap_adoption.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';
import { scopeDigest } from '../../../packages/api-contract/sync/reference/core/digest.js';
import { Stamp } from '../../../packages/api-contract/sync/reference/core/stamp.js';

const DEADLINE_MS = 180_000;
const REQUEST_MS = 10_000;
const DB = process.env.WM_E2E_DB;
const PORT = Number(process.env.PORT);
if (!DB || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || process.argv.length > 2) {
  console.error('set WM_E2E_DB to the adopted throwaway database (name or postgresql:// URL) and PORT to the server\'s port; the script takes no arguments');
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
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();

// ── the fixture's accounts, signed in ──────────────────────────────────────────────────────────────────────────────
const cello = 't_a000000000000001', music = 't_a000000000000003';
if (psql(`select count(*) from roadmap_trees where id = '${cello}'`) !== '1') {
  console.error('the database holds no adopted fixture: adopt roadmap_adopt_fixture.sql with windmill_roadmap_adopt first');
  process.exit(2);
}
const signIn = (account) => {
  const secret = randomBytes(24).toString('hex');
  psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
  return { account, secret };
};
const owner = signIn('aaaaaaaa-0000-4000-8000-00000000000a');
const reader = signIn('bbbbbbbb-0000-4000-8000-00000000000b');

// ── one browser engine for each of them ────────────────────────────────────────────────────────────────────────────
const failures = [];
const engineOf = async (who, name) => {
  const timers = new FakeTimers();
  timers.time = Date.now();
  const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
    reading: () => ({ wall: timers.time, mono: timers.time, boot: name }),
    scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
    socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
    fetch: (url, options) => {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
      return fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${who.secret}` } });
    } });
  const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name, registry, transport, timers,
    draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
    document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
  const replica = () => engine.device.activeReplica;
  const pending = () => replica().outbox.filter((entry) => ['ready', 'sent'].includes(entry.state));
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
  const settle = async () => {
    for (let turn = 0; turn < 30 && pending().length; turn++) await round();
    for (let turn = 0; turn < 5; turn++) await round();
  };
  const rows = (scope) => replica().confirmedRows(scope);
  const row = (scope, t, id) => rows(scope).find((each) => each.t === t && same(each.id, id));
  const matchesServer = async (scope) => {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    const page = response.body?.pages?.[0];
    return page?.kind === 'rows' && !page.more && scopeDigest(rows(scope)) === page.digest;
  };
  await engine.signIn(who.account);
  await engine.start();
  return { engine, replica, settle, rows, row, matchesServer };
};

const owners = await engineOf(owner, 'roadmap-adoption-owner');
const readers = await engineOf(reader, 'roadmap-adoption-reader');
try {
  const tree = `tree/${cello}`, overlay = `self/overlay/${cello}`;
  for (const scope of ['self/roadmap', tree, overlay]) owners.engine.observe(scope);
  await owners.settle();

  const records = owners.rows('self/roadmap').filter((row) => row.t === 'tree' && row.life[0] === 'alive').map((row) => row.id).sort();
  check(same(records, ['t_a000000000000001', 't_a000000000000002', 't_a000000000000003', 't_a000000000000004', 't_a000000000000007'])
    && psql("select string_agg(life, ',' order by id) from roadmap_trees where id in ('t_a000000000000005', 't_a000000000000006')") === 'dead,dead',
  'the owner pulls a record of each of their roadmaps, and the deleted ones stand dead on the server', `${records.length} records`);
  const meta = owners.row(tree, 'meta', 'meta');
  check(meta?.f?.title?.[0] === 'Learn the cello' && meta?.f?.reach?.[0] === 'public' && meta?.f?.guideInherited?.[0] === true,
    'the roadmap\'s meta reads as roadmap\'s tables held it', 'the meta differs');
  const steps = owners.rows(tree).filter((row) => row.t === 'node');
  const authored = [...steps].sort((a, b) => {
    const [x, y] = [a.f.ord[0], b.f.ord[0]];
    if (x !== y) return x < y ? -1 : 1;
    return Stamp.compare(a.born, b.born) || (a.id < b.id ? -1 : 1);
  }).map((row) => row.id);
  check(same(authored, ['empty-ord', 'owning', 'kept', 'unset', 'future', 'bad-ord', 'revived', 'active', 'opener', 'cleared', 'late']),
    'the present steps come in today\'s order, an empty and a malformed key given their places', 'the order differs');
  const kept = owners.row(tree, 'node', 'kept');
  const links = (kept?.f?.links?.[0] ?? []).map((link) => [link.url, link.label]);
  check(kept?.f?.label?.[0] === 'Hold the bow' && same(links, [['https://example.com/bow', 'Bow hold'], ['https://example.com/bare', '']])
    && kept?.f?.status?.[0] === 'complete' && owners.row(tree, 'node', 'dead') === undefined
    && psql(`select string_agg(id || ' ' || life, ',' order by id) from roadmap_nodes where scope_key = 'tree:${cello}' and life = 'dead'`)
      === 'dead dead,removed-only dead',
  'a step\'s fields read as the old server read them, and the dead steps stand dead on the server', 'a step differs');
  check(same(owners.rows(tree).filter((row) => row.t === 'edge').map((row) => row.id).sort(), [['kept', 'unset'], ['owning', 'kept']])
    && psql(`select id from roadmap_edges where scope_key = 'tree:${cello}' and life = 'dead'`) === '["kept","future"]',
  'the links come as adopted', 'the links differ');
  check(owners.row(overlay, 'pointer', 'opener')?.f?.opens?.[0] === music && owners.row(overlay, 'progress', 'kept')?.f?.mark?.[0]?.outOfOrder === true,
    'the owner\'s overlay holds their pointer and their marks', 'the overlay differs');
  const matching = [];
  for (const scope of ['self/roadmap', tree, overlay]) matching.push(await owners.matchesServer(scope));
  check(matching.every(Boolean), 'every scope the owner pulled matches the server\'s digest', `${matching.filter(Boolean).length} of 3 match`);

  const seqBefore = Number(psql(`select seq from sync_scopes where key = 'tree:${cello}'`));
  await owners.engine.commit(tree, [
    { op: 'update', t: 'node', id: 'kept', f: { label: 'Hold the bow loosely' } },
    { op: 'create', t: 'node', id: 'shifting', f: { label: 'Shifting', ord: 'aD' } },
    { op: 'put', t: 'edge', id: ['kept', 'shifting'] },
  ], { atomic: true });
  await owners.settle();
  check(owners.replica().outbox.length === 0 && owners.replica().notices.length === 0, 'a change to an adopted roadmap lands',
    `${owners.replica().outbox.length} entries, ${owners.replica().notices.length} notices`);
  const seqAfter = Number(psql(`select seq from sync_scopes where key = 'tree:${cello}'`));
  check(seqAfter > seqBefore && seqBefore > 9, 'the roadmap\'s seq continues above its old head', `${seqBefore} then ${seqAfter}`);
  const activity = await fetch(`${base}/v1/trees/${cello}/activity`, { headers: { Authorization: `Bearer ${owner.secret}` }, signal: AbortSignal.timeout(REQUEST_MS) });
  const events = activity.status === 200 ? (await activity.json()).events : [];
  check(same(events.slice(0, 2).map((event) => event.seq), [8, 9]) && events.length > 2 && events.slice(2).every((event) => event.seq > seqBefore)
    && events.at(-1)?.actor === '', 'the activity keeps the rooms\' lines and tells the new deed after them', `${events.length} events`);

  await readers.engine.subscribe(tree);
  for (const scope of [tree, overlay]) readers.engine.observe(scope);
  await readers.settle();
  check(readers.row(tree, 'meta', 'meta')?.f?.title?.[0] === 'Learn the cello' && readers.row(tree, 'node', 'kept')?.f?.label?.[0] === 'Hold the bow loosely',
    'the reader reads the public roadmap as it stands now', 'the reader\'s roadmap differs');
  check(readers.row(overlay, 'progress', 'kept')?.f?.mark?.[0]?.status === 'complete' && readers.rows(overlay).every((row) => row.t === 'progress'),
    'the reader\'s overlay holds their own mark and never the owner\'s pointer', 'the reader\'s overlay differs');
  check(failures.length === 0, 'the engines report no failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  owners.engine.close();
  readers.engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
