#!/usr/bin/env node
// Roadmap's read models on the sync engine end to end (roadmap-on-the-engine.md §7): the production browser engine over
// HTTP, under the composed registry, against windmill_server serving roadmap's scopes on :$PORT and a THROWAWAY
// Postgres. This script wipes every sync_* row of $WM_E2E_DB, roadmap's engine rows with them, and the activity of the
// two roadmaps it makes.
// - A person makes a roadmap of two steps, a subtree under the first with two steps of its own, completes both of
//   those and the second step, makes the roadmap public and renames the first step, all through the engine.
// - The activity feed tells the roadmap's two gestures that left a deed, one line each, by who made them, and a stranger
//   reads it while the roadmap is public.
// - The owner's progress shown to a stranger: the first step complete because its subtree is, dated when the server
//   received the subtree's last mark, the second as marked, and the subtree's two steps of two.
// - The share page names the roadmap and the subtree by the owning step's label, with their step counts.
// - Deleting the first step ends the subtree's standing: its page is the shell as served and its activity is not found.
// The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql, and the server serving roadmap on it with the web
// shell beside it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8090 ROADMAP_ENGINE_ENABLED=1 WINDMILL_WEB_ROOT=../web \
//     ./build/windmill_server
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=8090 node test/e2e/roadmap_read_models.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { FakeLocks, FakeTimers } from '../../../web/test/platform/sync/fakes.js';

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

// ── a clean engine and two sessions ────────────────────────────────────────────────────────────────────────────────
const root = 't_00000000000000f1', subtree = 't_00000000000000f2';
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();
for (const table of ['sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
psql(`delete from tree_ops where tree_id in ('${root}', '${subtree}')`);
const signIn = (email, name) => {
  psql(`insert into users (id, email, name) values (gen_random_uuid(), '${email}', '${name}') on conflict (email) do nothing`);
  const account = psql(`select id from users where email = '${email}'`);
  const secret = randomBytes(24).toString('hex');
  psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${account}', ${Date.now() + 3_600_000})`);
  return { account, secret };
};
const owner = signIn('roadmap-reads-e2e@example.com', 'Owner');
const stranger = signIn('roadmap-reads-stranger-e2e@example.com', 'Stranger');
const read = async (path, who) => {
  const headers = who ? { Authorization: `Bearer ${who.secret}` } : {};
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
};

// ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────────
const timers = new FakeTimers();
timers.time = Date.now();
const failures = [];
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'roadmap-reads' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
    return fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${owner.secret}` } });
  } });
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'roadmap-reads', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
const leading = async () => {
  for (let turn = 0; !engine.leader; turn++) {
    if (turn === 1000) throw new Error('the engine never became the leader');
    await new Promise((done) => setImmediate(done));
  }
};
try {
  await engine.signIn(owner.account);
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
  const tree = `tree/${root}`, below = `tree/${subtree}`;
  const genesis = [['build', 'terracotta', 'Build', 'Things you make', 'a0'], ['learn', 'olive', 'Learn', 'Things you figure out', 'a1'],
    ['milestone', 'gold', 'Milestone', 'Moments that matter', 'a2']];
  const title = 'A roadmap read back', renamed = 'Foundations first';
  for (const scope of ['self/roadmap', tree, below, `self/overlay/${root}`, `self/overlay/${subtree}`]) engine.observe(scope);

  await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: root }]);
  await engine.commit(tree, [
    { op: 'write', t: 'meta', id: 'meta', f: { title } },
    ...genesis.map(([id, hue, label, description, ord]) => ({ op: 'create', t: 'kind', id, f: { hue, label, description, ord } })),
    { op: 'create', t: 'node', id: 'basics', f: { label: 'Basics', ord: 'a0' } },
    { op: 'create', t: 'node', id: 'ownership', f: { label: 'Ownership', ord: 'a1' } },
    { op: 'put', t: 'edge', id: ['basics', 'ownership'] },
  ], { atomic: true });
  await settle();
  await engine.commit('self/roadmap', [], { cmd: { name: 'roadmap.createSubtree', args: { tree: root, root, step: 'basics', subtree } } });
  await settle();
  await engine.commit(below, [
    { op: 'create', t: 'node', id: 'rig', f: { label: 'Rig', ord: 'a0' } },
    { op: 'create', t: 'node', id: 'knot', f: { label: 'Knot', ord: 'a1' } },
  ], { atomic: true });
  await settle();
  const complete = { status: 'complete', outOfOrder: false };
  await engine.commit(`self/overlay/${root}`, [{ op: 'write', t: 'progress', id: 'ownership', f: { mark: complete } }]);
  await settle();
  await engine.commit(`self/overlay/${subtree}`, [
    { op: 'write', t: 'progress', id: 'rig', f: { mark: complete } },
    { op: 'write', t: 'progress', id: 'knot', f: { mark: complete } },
  ], { atomic: true });
  await settle();
  const lastMarkAt = Number(psql(`select max(ru) from roadmap_progress where scope_key = 'acct:${owner.account}/overlay/${subtree}'`));
  await engine.commit(tree, [{ op: 'write', t: 'meta', id: 'meta', f: { visibility: 'public' } }]);
  await engine.commit(tree, [{ op: 'update', t: 'node', id: 'basics', f: { label: renamed } }]);
  await settle();
  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every gesture lands', `${replica().outbox.length} entries, ${replica().notices.length} notices`);

  const activity = await read(`/v1/trees/${root}/activity`, owner);
  const events = activity.status === 200 ? activity.json().events : [];
  check(same(events.map((event) => [event.verb, event.nodeId, event.actor]), [['added', 'basics', ''], ['renamed', 'basics', '']])
    && events[0]?.summary === 'added 2 nodes' && events[1]?.summary === `renamed to ${renamed}` && events[0]?.label === renamed,
  'the activity tells the two gestures that left a deed, one line each, by the steps as they are named now', `${events.length} events`);
  const seqs = psql(`select string_agg(seq::text, ',' order by seq) from tree_ops where tree_id = '${root}'`);
  const actors = psql(`select count(*) from tree_ops where tree_id = '${root}' and actor_id = '${owner.account}'`);
  check(same(events.map((event) => String(event.seq)), seqs.split(',')) && actors === '2', 'each line sits at the roadmap\'s seq and was made by its owner',
    'the rows differ');
  const strangers = await read(`/v1/trees/${root}/activity`, stranger);
  check(strangers.status === 200 && same(strangers.json().events, events), 'a stranger reads the same activity while the roadmap is public',
    `status ${strangers.status}`);

  const progress = await read(`/v1/trees/${root}/progress`);
  const marks = progress.status === 200 ? progress.json().marks : [];
  const byNode = Object.fromEntries(marks.map((mark) => [mark.node, mark]));
  check(byNode.basics?.status === 'complete' && byNode.basics?.markedAt === lastMarkAt && byNode.ownership?.status === 'complete'
    && marks.length === 2, 'a stranger is shown the first step complete because its subtree is, dated when the server received its last mark',
  `${marks.length} marks`);
  const subtrees = progress.status === 200 ? progress.json().subtrees : [];
  check(same(subtrees.map(({ node, tree: opened, done, total }) => [node, opened, done, total]), [['basics', subtree, 2, 2]]),
    'the progress tells what the subtree has come to', 'the subtree count differs');

  const rootPage = await read(`/t/${root}`);
  const subtreePage = await read(`/t/${subtree}`);
  check(rootPage.text.includes(`<title>${title} — Windmill</title>`) && rootPage.text.includes('A Windmill skill tree — 2 steps.'),
    'the share page names the roadmap and counts its steps', 'the roadmap\'s page differs');
  check(subtreePage.text.includes(`<title>${renamed} — Windmill</title>`) && subtreePage.text.includes('A Windmill skill tree — 2 steps.'),
    'the subtree\'s page is named by its owning step', 'the subtree\'s page differs');

  await engine.commit(tree, [{ op: 'delete', t: 'node', id: 'basics' }]);
  await settle();
  const hiddenPage = await read(`/t/${subtree}`, owner);
  const hiddenActivity = await read(`/v1/trees/${subtree}/activity`, owner);
  check(!hiddenPage.text.includes('path-share') && hiddenActivity.status === 404,
    'a subtree whose step is deleted is hidden from its owner: the shell as served, and no activity', `status ${hiddenActivity.status}`);
  const after = await read(`/v1/trees/${root}/activity`, owner);
  check(after.status === 200 && after.json().events.at(-1)?.verb === 'removed', 'the delete is the activity\'s next line', `status ${after.status}`);
  check(failures.length === 0, 'the engine reports no failure', `failures ${[...new Set(failures)].sort().join(',')}`);
} catch (error) {
  check(false, 'the run completes', error instanceof Error ? error.constructor.name : 'a thrown value');
} finally {
  engine.close();
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
