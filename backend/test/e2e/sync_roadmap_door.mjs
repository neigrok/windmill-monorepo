#!/usr/bin/env node
// Roadmap's server door end to end (roadmap-on-the-engine.md §7): MCP's writes and the fork reach a browser engine replica
// by sync. Against windmill_server serving roadmap's scopes on :$PORT, its MCP's shared bearer acting as the account
// $WM_E2E_MCP_USER names, and a THROWAWAY Postgres. This script wipes every sync_* row of $WM_E2E_DB, and roadmap's
// engine rows with them.
// - MCP plants a roadmap and two steps, each call under a requestId, and sends each again: the copy is answered as the
//   first was and writes nothing.
// - The browser engine, signed in as the same account, pulls the roadmap and its steps and the link between them.
// - The fork route copies the roadmap under a requestId, and the same fork sent again answers the same copy: the copy's
//   record and its steps reach the browser by sync, under a new id.
// - Everything converges: no entry stays pending, no notice is written, and every scope's confirmed rows match the
//   server's digest.
// The output names checks only, never a record id or a title.
//
// Prereqs: npm ci --prefix web, psql "$WM_E2E_DB" -f db/schema.sql, and the server serving roadmap on it:
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8090 ROADMAP_ENGINE_ENABLED=1 \
//     WINDMILL_MCP_TOKEN=<token> WINDMILL_MCP_USER=<uuid> ./build/windmill_server
// Run:  WM_E2E_DB=<database> PORT=8090 WM_E2E_MCP_TOKEN=<token> WM_E2E_MCP_USER=<uuid> node test/e2e/sync_roadmap_door.mjs

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── a clean engine, the account and its session ────────────────────────────────────────────────────────────────────
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: REQUEST_MS }).trim();
for (const table of ['sync_spent', 'sync_requests', 'sync_replicas', 'sync_scopes']) psql(`delete from ${table}`);
psql(`insert into users (id, email, name) values ('${ACCOUNT}', 'sync-roadmap-door-e2e@example.com', 'Door') on conflict (id) do nothing`);
const secret = randomBytes(24).toString('hex');
psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${createHash('sha256').update(secret).digest('hex')}', '${ACCOUNT}', ${Date.now() + 3_600_000})`);
const accountScope = `acct:${ACCOUNT}/roadmap`;
const count = (sql) => Number(psql(sql));
const seqOf = (tree) => count(`select seq from sync_scopes where key = 'tree:${tree}'`);

// ── MCP over HTTP, as the server's shared bearer ───────────────────────────────────────────────────────────────────
let session = null;
let serial = 0;
const rpc = async (method, params) => {
  const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
  session ??= response.headers.get('Mcp-Session-Id');
  return (await response.json()).result;
};
const tool = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args });
  return { error: result?.isError === true, body: result?.isError ? null : JSON.parse(result?.content?.[0]?.text ?? 'null') };
};

// ── the browser engine ─────────────────────────────────────────────────────────────────────────────────────────────
const timers = new FakeTimers();
timers.time = Date.now();
const failures = [];
const transport = new HttpTransport({ schema: registry.version, base, timers: globalThis,
  reading: () => ({ wall: timers.time, mono: timers.time, boot: 'sync-roadmap-door' }),
  scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
  socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
  fetch: (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
    return fetch(url, { ...options, signal, headers: { ...options.headers, Authorization: `Bearer ${secret}` } });
  } });
const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'sync-roadmap-door', registry, transport, timers,
  draw: () => 0, now: () => timers.time, monotonic: () => timers.time, navigator: { onLine: true, locks: new FakeLocks() },
  document: null, window: null, telemetry: { limit: 100, event() {}, failure(operation) { failures.push(operation); } } });
const leading = async () => {
  for (let turn = 0; !engine.leader; turn++) {
    if (turn === 1000) throw new Error('the engine never became the leader');
    await new Promise((done) => setImmediate(done));
  }
};
try {
  await engine.signIn(ACCOUNT);
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
  const alive = (row) => row && row.life?.[0] !== 'dead';
  const steps = (scope) => replica().confirmedRows(scope).filter((row) => row.t === 'node' && alive(row)).map((row) => row.id).sort();
  engine.observe('self/roadmap');

  // ── MCP writes, each under a requestId and each sent twice ──
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sync-roadmap-door', version: '1' } });
  const planted = await tool('roadmap_create_tree', { title: 'A door roadmap', requestId: 'e2e-plant' });
  const again = await tool('roadmap_create_tree', { title: 'A door roadmap', requestId: 'e2e-plant' });
  const root = planted.body?.treeId;
  check(!planted.error && same(planted.body, again.body)
    && count(`select count(*) from roadmap_trees where scope_key = '${accountScope}' and life = 'alive'`) === 1,
  'create_tree sent twice under one requestId plants one roadmap and answers the copy as the first', 'a second roadmap or another answer');
  const first = await tool('roadmap_create_node', { treeId: root, id: 'first', label: 'First', color: 'terracotta', requestId: 'e2e-first' });
  const second = { treeId: root, id: 'second', label: 'Second', color: 'terracotta', prerequisites: ['first'], requestId: 'e2e-second' };
  const made = await tool('roadmap_create_node', second);
  const head = seqOf(root);
  const remade = await tool('roadmap_create_node', second);
  check(!first.error && !made.error && same(made.body, remade.body) && seqOf(root) === head && made.body?.seq === head,
    'create_node sent again under its requestId writes nothing and answers the seq the tree scope holds', `seq ${head}`);
  const conflict = await tool('roadmap_create_node', { ...second, label: 'Other' });
  check(conflict.error && seqOf(root) === head, 'the same requestId with other arguments is refused, writing nothing', 'it wrote');

  // ── the browser pulls them ──
  const tree = `tree/${root}`;
  engine.observe(tree);
  await settle();
  check(alive(confirmed('self/roadmap', 'tree', root)), 'the browser holds the roadmap\'s record', 'it is missing');
  check(same(steps(tree), ['first', 'second']) && alive(confirmed(tree, 'edge', ['first', 'second'])),
    'the browser holds both steps and the link between them', `${steps(tree).length} steps`);

  // ── the fork, through the route ──
  const fork = async () => {
    const forked = await fetch(`${base}/v1/trees/${root}/fork`, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'e2e-fork' }) });
    return { status: forked.status, id: forked.status === 201 ? (await forked.json()).data?.id : null };
  };
  const forked = await fork();
  const copy = forked.id;
  check(typeof copy === 'string' && copy !== root, 'the fork route answers 201 with a new roadmap', `status ${forked.status}`);
  const resent = await fork();
  check(resent.id === copy && count(`select count(*) from roadmap_trees where scope_key = '${accountScope}' and life = 'alive'`) === 2,
    'the same fork sent again answers the same copy and plants no other', `status ${resent.status}`);
  await settle();
  const copied = `tree/${copy}`;
  engine.observe(copied);
  await settle();
  check(alive(confirmed('self/roadmap', 'tree', copy)), 'the copy\'s record reaches the browser by sync', 'it is missing');
  check(same(steps(copied), ['first', 'second']) && alive(confirmed(copied, 'edge', ['first', 'second']))
    && confirmed(copied, 'meta', 'meta')?.f?.forkedFrom?.[0] === root,
  'the copy\'s steps, link and source reach the browser', `${steps(copied).length} steps`);

  check(replica().outbox.length === 0 && replica().notices.length === 0, 'every entry settles and no notice is written',
    `${replica().outbox.length} entries, ${replica().notices.length} notices`);
  const scopes = ['self/roadmap', tree, copied];
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
