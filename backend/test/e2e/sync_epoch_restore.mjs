// Prerequisites: built production server/epoch tool, matching-major PostgreSQL CLI, lsof, and npm ci --prefix web.
// Run from the repo: node backend/test/e2e/sync_epoch_restore.mjs --maintenance-db postgresql:///postgres?host=/tmp
// Uses the production browser engine and HTTP transport with the web tests' IndexedDB and Web Locks substitutes.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { Cursor } from '../../../web/src/platform/sync/core/wire.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { FakeLocks } from '../../../web/test/platform/sync/fakes.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireWeb = createRequire(resolve(repo, 'web/package.json'));
const { IDBFactory } = requireWeb('fake-indexeddb');
const { values } = parseArgs({ options: {
  'server-bin': { type: 'string', default: resolve(repo, 'backend/build/windmill_server') },
  'rotate-bin': { type: 'string', default: resolve(repo, 'backend/build/windmill_rotate_sync_epoch') },
  'maintenance-db': { type: 'string', default: 'postgresql:///postgres?host=/tmp' },
  port: { type: 'string' },
} });
const database = `ep_restore_${process.pid}_${randomBytes(4).toString('hex')}`;
const url = new URL(values['maintenance-db']);
url.pathname = `/${database}`;
const databaseUrl = url.href;
const scratch = mkdtempSync(resolve(tmpdir(), 'ep-restore-'));
const logPath = resolve(scratch, 'server.log');
const dumpPath = resolve(scratch, 'older.dump');
const account = randomUUID();
const token = randomBytes(24).toString('hex');
const indexedDB = new IDBFactory();
const scope = 'self/gym';
const failures = [], trace = [], events = [];
const fixture = {
  baseline: { id: 'ep_baseline', title: 'Backup note', body: 'Present in the older dump' },
  newer: { id: 'ep_newer_confirmed', title: 'Newer note', body: 'Confirmed after the older dump' },
  acked: { id: 'ep_acked_pending', title: 'Accepted note', body: 'Accepted but not pulled before the restore' },
  unsent: { id: 'ep_unsent_pending', title: 'Offline note', body: 'Committed offline before the restore' },
};
let server, engine, port, origin, created = false, passed = false, pausePull = false, pausePush = false;
const commandOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const run = (command, args, options = {}) => execFileSync(command, args, { ...commandOptions, ...options });
const sql = (statement) => run('psql', [databaseUrl, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', statement]).trim();
const epoch = () => sql('select epoch from sync_meta');
const notes = () => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body) order by id), '[]') from gym_notes where user_id = '${account}'`));
const expectedNotes = (...names) => names.map((name) => fixture[name]).sort((a, b) => a.id.localeCompare(b.id));
const replica = () => engine.device.activeReplica;
const pending = () => replica().entries(scope).map(({ localId, state, commitOrder }) => ({ localId, state, commitOrder }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(label, condition, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error(`${label}: server exited`);
    await sleep(25);
  }
  throw new Error(`${label}: timed out; failures=${JSON.stringify(failures)} pending=${JSON.stringify(engine ? pending() : [])}`);
}

function listeners() {
  const result = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], commandOptions);
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  assert.equal(result.status, 0, 'lsof could not inspect the chosen port');
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

async function startServer() {
  assert.deepEqual(listeners(), [], `port ${port} is occupied`);
  const log = openSync(logPath, 'a');
  server = spawn(resolve(values['server-bin']), [], { cwd: scratch, stdio: ['ignore', log, log], env: {
    ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), WINDMILL_HOST: '127.0.0.1',
    WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin, WINDMILL_COOKIE_DOMAIN: '',
    RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '',
    JOURNAL_NUDGE_ENABLED: '0', SENTRY_DSN: '', AMPLITUDE_API_KEY: '',
  } });
  closeSync(log);
  let launchError;
  server.on('error', (error) => { launchError = error; });
  await until('server readiness', async () => {
    if (launchError) throw launchError;
    try {
      const response = await fetch(`${origin}/v1/sync/hello`, {
        headers: { 'Sync-Schema': String(registry.version) }, signal: AbortSignal.timeout(1000),
      });
      return response.status === 200;
    } catch { return false; }
  }, 30_000);
  assert.deepEqual(listeners(), [server.pid], 'the listener must belong to this harness');
}

async function stopServer() {
  if (!server) return;
  const owned = server;
  if (!owned.pid) { server = null; return; }
  const pids = listeners();
  assert.ok(pids.every((pid) => pid === owned.pid), 'refusing to stop an unrelated listener');
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  // A failed launch may still be in startup before it owns the port.
  if (!pids.length && owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (owned.exitCode === null && owned.signalCode === null && Date.now() < deadline) await sleep(25);
  if (owned.exitCode === null && owned.signalCode === null) {
    const remaining = listeners();
    for (const pid of remaining) {
      assert.equal(pid, owned.pid);
      process.kill(pid, 'SIGKILL');
    }
    if (!remaining.length) owned.kill('SIGKILL');
    const killed = Date.now() + 5000;
    while (owned.exitCode === null && owned.signalCode === null && Date.now() < killed) await sleep(25);
    assert.ok(owned.exitCode !== null || owned.signalCode !== null, 'server did not stop');
  }
  assert.deepEqual(listeners(), [], 'server port is still listening');
  server = null;
}

async function openClient(online) {
  const transport = new HttpTransport({ schema: registry.version, base: origin,
    reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: 'restore-proof' }),
    // Keep live disconnected so the production HTTP puller alone must recover.
    socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
    fetch: async (address, options) => {
      const endpoint = new URL(address).pathname.split('/').at(-1);
      if ((pausePull && endpoint === 'pull') || (pausePush && endpoint === 'push')) {
        await new Promise((_, reject) => {
          const abort = () => reject(new DOMException('proof transport interrupted', 'AbortError'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
      const request = options.body ? JSON.parse(options.body) : undefined;
      const response = await fetch(address, { ...options, headers: { ...options.headers,
        ...(options.credentials === 'omit' ? {} : { Authorization: `Bearer ${token}` }),
      } });
      const body = await response.clone().json();
      trace.push({ endpoint, request, status: response.status, epoch: body.epoch, pages: body.pages });
      return response;
    },
  });
  engine = await BrowserSyncEngine.open({ indexedDB, name: database, transport,
    navigator: { onLine: online, locks: new FakeLocks() }, document: null, window: null,
    telemetry: { event: (name, props) => events.push({ name, props }), failure: (operation) => failures.push(operation) },
  });
  engine.observe(scope);
}

async function createNote(name) {
  const { id, title, body } = fixture[name];
  return engine.commit(scope, [{ op: 'create', t: 'note', id, f: { title, body, ord: 'a0' } }]);
}

async function confirmed(name) {
  await until(`${name} confirmed and settled`, () => replica().confirmedRow(scope, 'note', fixture[name].id)?.f.body[0] === fixture[name].body
    && replica().entries(scope).length === 0);
}

try {
  if (values.port) {
    port = Number(values.port);
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'invalid port');
  } else {
    const reservation = createServer();
    await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
  }
  origin = `http://127.0.0.1:${port}`;
  run('createdb', [`--maintenance-db=${values['maintenance-db']}`, database]);
  created = true;
  run('psql', [databaseUrl, '-Xq', '-v', 'ON_ERROR_STOP=1', '-f', resolve(repo, 'backend/db/schema.sql')]);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  sql(`insert into users(id,email,name) values('${account}','epoch-proof@example.com','Epoch proof');
    insert into sessions(token_hash,user_id,expires_ms) values('${tokenHash}','${account}',99999999999999)`);
  await startServer();
  await openClient(true);
  assert.equal((await engine.signIn(account)).complete, true);
  await engine.start();
  await createNote('baseline');
  await confirmed('baseline');
  const oldEpoch = epoch();
  assert.equal(replica().meta.serverEpoch, oldEpoch);
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, databaseUrl]);
  console.log('PASS client synced; an older whole-database dump was saved');

  await createNote('newer');
  await confirmed('newer');
  engine.setOnline(false);
  await until('network stopped', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
  pausePull = true;
  engine.setOnline(true);
  const acked = await createNote('acked');
  await until('accepted entry retained without a covering pull', () => replica().entry(acked.localIds[0])?.state === 'acked');
  engine.setOnline(false);
  await until('stalled pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
  const unsent = await createNote('unsent');
  const savedPending = pending();
  assert.deepEqual(savedPending.map(({ state }) => state), ['acked', 'ready']);
  assert.equal(replica().entry(unsent.localIds[0]).state, 'ready');
  assert.deepEqual(notes(), expectedNotes('baseline', 'newer', 'acked'));
  const oldReplica = replica().id;
  const oldCursor = replica().cursorOf(scope).cursor;
  assert.equal(Cursor.decode(oldCursor).e, oldEpoch);
  engine.close();
  console.log('PASS newer confirmed data, an unpulled acknowledgment and unsent work survive in the client store');

  await stopServer();
  run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', databaseUrl, dumpPath]);
  assert.equal(epoch(), oldEpoch);
  assert.deepEqual(notes(), expectedNotes('baseline'));
  const newEpoch = randomBytes(16).toString('hex');
  for (const outcome of ['ok', 'already-applied']) {
    const result = spawnSync(resolve(values['rotate-bin']), [oldEpoch, newEpoch], {
      ...commandOptions, env: { ...process.env, DATABASE_URL: databaseUrl, SENTRY_DSN: '' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'epoch tool failed');
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').flatMap((line) => {
      const match = line.match(/write (\{.*\})/);
      return match ? [JSON.parse(match[1])] : [];
    });
    assert.equal(lines.length, 1, 'tool must log one write outcome');
    assert.equal(lines[0].operation, 'sync.epoch.rotate');
    assert.equal(lines[0].product, 'platform');
    assert.equal(lines[0].door, 'tool');
    assert.equal(lines[0].outcome, outcome);
    assert.ok(Number.isFinite(lines[0].duration_ms) && lines[0].duration_ms >= 0);
    assert.equal(epoch(), newEpoch);
  }
  console.log('PASS older dump restored; epoch rotated once; retry logged already-applied');

  await startServer();
  pausePull = false;
  pausePush = true;
  await openClient(false);
  assert.equal(replica().id, oldReplica);
  assert.equal(replica().cursorOf(scope).cursor, oldCursor);
  assert.deepEqual(pending(), savedPending);
  let reset;
  engine.onEvent((event) => {
    if (event.event !== 'activeReplicaChanged' || event.previous !== oldReplica) return;
    reset = { epoch: replica().meta.serverEpoch, replica: replica().id,
      cursors: Object.values(replica().cursors).map(({ cursor }) => cursor), staging: Object.keys(replica().staging),
      pending: pending(), nextN: replica().meta.nextN, ackThrough: replica().meta.ackThrough };
    engine.setOnline(false);
  });
  await engine.start();
  engine.setOnline(true);
  await until('epoch change from the restored server', () => reset && !engine.sending && !engine.pulling);
  assert.equal(reset.epoch, newEpoch);
  assert.notEqual(reset.replica, oldReplica);
  assert.ok(reset.cursors.length > 0);
  assert.ok(reset.cursors.every((cursor) => cursor === null));
  assert.deepEqual(reset.staging, []);
  assert.equal(reset.nextN, 1);
  assert.equal(reset.ackThrough, 0);
  assert.deepEqual(reset.pending, savedPending.map((entry) => ({ ...entry, state: 'ready' })));
  assert.ok(trace.some((request) => request.endpoint === 'pull' && request.epoch === newEpoch
    && request.request.scopes.some(({ scope: name, cursor }) => name === scope && cursor === oldCursor)
    && request.pages.some((page) => page.scope === scope && page.kind === 'reset')));
  console.log('PASS production client detected the epoch, reset cursors and identity, and retained both writes in commit order');

  pausePush = false;
  engine.setOnline(true);
  await confirmed('unsent');
  await confirmed('acked');
  assert.equal(replica().confirmedRow(scope, 'note', fixture.newer.id), undefined);
  const recovered = engine.observe(scope).getSnapshot().stored.filter(({ t }) => t === 'note')
    .map(({ id, f }) => ({ id, title: f.title[0], body: f.body[0] })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(recovered, expectedNotes('baseline', 'acked', 'unsent'));
  assert.deepEqual(notes(), recovered);
  assert.equal(Cursor.decode(replica().cursorOf(scope).cursor).e, newEpoch);
  assert.ok(trace.some((request) => request.endpoint === 'pull' && request.epoch === newEpoch
    && request.request.scopes.some(({ scope: name, cursor }) => name === scope && cursor === null)));
  assert.deepEqual(replica().notices, []);
  assert.ok(!failures.some((operation) => ['storage', 'auth', 'observer', 'leadership'].includes(operation)));
  assert.ok(events.some(({ name }) => name === 'sync-commit'));
  console.log('PASS bootstrap discarded newer replica data; acknowledged and unsent work replayed and settled with matching server rows');
  passed = true;
} finally {
  engine?.close();
  try { await stopServer(); }
  finally {
    if (created) run('dropdb', [`--maintenance-db=${values['maintenance-db']}`, '--if-exists', '--force', database]);
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else {
      rmSync(dumpPath, { force: true });
      console.error(`Restore proof failed; server log: ${logPath}`);
      try { console.error(readFileSync(logPath, 'utf8').slice(-12_000)); } catch {}
    }
  }
}
