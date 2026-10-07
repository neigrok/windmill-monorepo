// Prerequisites: built production server/epoch tool, matching-major PostgreSQL CLI, lsof, and npm ci --prefix web.
// Run from the repo: node backend/test/e2e/sync_epoch_restore.mjs --maintenance-db postgresql:///postgres?host=/tmp
// Uses the production browser engine and HTTP transport with the web tests' IndexedDB and Web Locks substitutes.
// Both reconnect orders retain work across replicas, including deletes before source replay and wrong-born notices.
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
async function prove(order) {
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
    edited: { id: 'ep_edited_pending', title: 'Edited note', body: 'Accepted before the offline edit' },
    deleted: { id: 'ep_deleted_pending', title: 'Deleted note', body: 'Accepted before the offline delete' },
    shared: { id: 'ep_shared_pending', title: 'Shared note', body: 'Another replica deletes this before replay' },
  };
  const editedBody = 'Edited offline before the restore';
  const importedSession = { id: 'ep_imported_session', startedAt: 1000, finishedAt: 2000, sets: [] };
  const unpredictedSession = { id: 'ep_unpredicted_session', startedAt: 3000, finishedAt: 4000, sets: [] };
  const peers = [
    { name: `${database}-delete-first`, t: 'note', id: fixture.shared.id },
    { name: `${database}-delete-after-command`, t: 'session', id: unpredictedSession.id },
  ];
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

  async function openClient(online, name = database) {
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
        trace.push({ endpoint, request, status: response.status, epoch: body.epoch, pages: body.pages,
          error: body.error, results: body.results });
        return response;
      },
    });
    engine = await BrowserSyncEngine.open({ indexedDB, name, transport,
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

  async function recoverPeer(peer, newEpoch, refused) {
    pausePull = true;
    pausePush = false;
    const started = trace.length;
    await openClient(false, peer.name);
    assert.deepEqual(replica().entries(scope), peer.entries);
    await engine.start();
    engine.setOnline(true);
    await until('peer deletion answered in the restored epoch', () => replica().meta.serverEpoch === newEpoch
      && (refused ? replica().notices.length === 1 && pending().length === 0
        : pending().length === 1 && pending()[0].state === 'acked'));
    const responses = trace.slice(started).filter(({ endpoint }) => endpoint === 'push');
    assert.ok(responses.length >= 2);
    assert.ok(responses.every(({ status, epoch }) => status === 200 && epoch === newEpoch));
    assert.equal(responses[0].request.replica, peer.replica);
    assert.notEqual(responses.at(-1).request.replica, peer.replica);
    if (refused) {
      assert.deepEqual(replica().notices.map(({ id, scope, code, content }) => ({ id, scope, code, content })),
        [{ id: `notice:${peer.entries[0].localId}`, scope, code: 'unknown-record', content: { d: peer.entries[0].intent.d } }]);
    } else {
      assert.deepEqual(replica().notices, []);
      assert.equal(sql(`select born from sync_spent where type = 'note' and id = '${peer.id}'`), peer.entries[0].intent.d[0].born);
    }
    engine.setOnline(false);
    await until('peer stalled pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
    pausePull = false;
    engine.setOnline(true);
    await until('peer bootstrap completed', () => pending().length === 0
      && Cursor.decode(replica().cursorOf(scope).cursor)?.e === newEpoch
      && Cursor.decode(replica().cursorOf(scope).cursor)?.m === 'live');
    const savedNotices = structuredClone(replica().notices);
    engine.close();
    await openClient(false, peer.name);
    assert.deepEqual(replica().notices, savedNotices);
    assert.deepEqual(pending(), []);
    engine.close();
    console.log(`PASS ${order}: ${refused ? 'wrong-born delete retained in a durable notice' : 'peer delete persisted before its retained source replays'}`);
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
    for (const name of ['acked', 'edited', 'deleted', 'shared']) {
      const result = await createNote(name);
      await until(`${name} retained without a covering pull`, () => replica().entry(result.localIds[0])?.state === 'acked');
    }
    const imported = await engine.commit(scope, [], {
      cmd: { name: 'gym.importSession', args: importedSession },
      predict: [{ op: 'create', t: 'session', id: importedSession.id,
        f: { startedAt: importedSession.startedAt, finishedAt: importedSession.finishedAt, closedBy: 'finish' } }],
    });
    await until('command acknowledgment retained', () => replica().entry(imported.localIds[0])?.state === 'acked');
    const oldCommandBorn = sql(`select born from gym_sessions where id = '${importedSession.id}'`);
    assert.equal(replica().entry(imported.localIds[0]).predict[0].born, oldCommandBorn);
    const unpredicted = await engine.commit(scope, [], { cmd: { name: 'gym.importSession', args: unpredictedSession } });
    await until('command without prediction retained', () => replica().entry(unpredicted.localIds[0])?.state === 'acked');
    const oldUnpredictedBorn = sql(`select born from gym_sessions where id = '${unpredictedSession.id}'`);
    engine.setOnline(false);
    await until('stalled pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
    engine.close();
    pausePull = false;
    for (const peer of peers) {
      await openClient(true, peer.name);
      assert.equal((await engine.signIn(account)).complete, true);
      await engine.start();
      await until('peer learned the post-backup source', () => replica().confirmedRow(scope, peer.t, peer.id));
      engine.setOnline(false);
      await until('peer offline', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
      await engine.commit(scope, [{ op: 'delete', t: peer.t, id: peer.id }]);
      peer.entries = structuredClone(replica().entries(scope));
      peer.replica = replica().id;
      assert.equal(peer.entries.length, 1);
      assert.equal(peer.entries[0].state, 'ready');
      engine.close();
    }
    await openClient(false);
    await engine.start();
    await createNote('unsent');
    await engine.commit(scope, [{ op: 'update', t: 'note', id: fixture.edited.id, f: { body: editedBody } }]);
    await engine.commit(scope, [{ op: 'delete', t: 'note', id: fixture.deleted.id }]);
    const commandDelete = await engine.commit(scope, [{ op: 'delete', t: 'session', id: importedSession.id }]);
    assert.equal(replica().entry(commandDelete.localIds[0]).intent.d[0].born, oldCommandBorn);
    const savedPending = pending();
    const savedEntries = structuredClone(replica().entries(scope));
    assert.deepEqual(savedPending.map(({ state }) => state), ['acked', 'acked', 'acked', 'acked', 'acked', 'acked', 'ready', 'ready', 'ready', 'ready']);
    assert.deepEqual(notes(), expectedNotes('baseline', 'newer', 'acked', 'edited', 'deleted', 'shared'));
    const oldReplica = replica().id;
    const oldCursor = replica().cursorOf(scope).cursor;
    assert.equal(Cursor.decode(oldCursor).e, oldEpoch);
    engine.close();
    console.log(`PASS ${order}: unpulled creates/command and independent/dependent offline work are durable`);

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
    await recoverPeer(peers[0], newEpoch, false);
    pausePull = order === 'push-first';
    pausePush = order === 'pull-first';
    const recoveryStart = trace.length;
    await openClient(false);
    assert.equal(replica().id, oldReplica);
    assert.equal(replica().cursorOf(scope).cursor, oldCursor);
    assert.deepEqual(pending(), savedPending);
    assert.deepEqual(replica().entries(scope), savedEntries);
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
    const recovery = trace.slice(recoveryStart);
    if (order === 'push-first') {
      assert.deepEqual(recovery.map(({ endpoint, status, error }) => ({ endpoint, status, error })),
        [{ endpoint: 'push', status: 409, error: 'gap' }]);
      assert.equal(recovery[0].epoch, newEpoch);
      assert.equal(recovery[0].request.replica, oldReplica);
    } else {
      assert.ok(recovery.some((request) => request.endpoint === 'pull' && request.epoch === newEpoch
        && request.request.scopes.some(({ scope: name, cursor }) => name === scope && cursor === oldCursor)
        && request.pages.some((page) => page.scope === scope && page.kind === 'reset')));
      assert.ok(recovery.every(({ endpoint }) => endpoint !== 'push'));
    }
    console.log(`PASS ${order}: epoch transition precedes retry and returns every owed entry to commit order`);

    const resetEntries = structuredClone(replica().entries(scope));
    engine.close();
    await openClient(false);
    assert.equal(replica().id, reset.replica);
    assert.equal(replica().meta.serverEpoch, newEpoch);
    assert.equal(replica().meta.nextN, 1);
    assert.equal(replica().meta.ackThrough, 0);
    assert.equal(replica().cursorOf(scope).cursor, null);
    assert.deepEqual(replica().entries(scope), resetEntries);
    const replayStart = trace.length;
    pausePull = true;
    pausePush = false;
    await engine.start();
    engine.setOnline(true);
    await until('every owed write replayed before bootstrap', () => replica().entries(scope).length === savedPending.length
      && replica().entries(scope).every(({ state }) => state === 'acked'));
    const replayed = trace.slice(replayStart).filter(({ endpoint }) => endpoint === 'push');
    assert.ok(replayed.every(({ status, epoch }) => status === 200 && epoch === newEpoch));
    const numbered = new Map();
    for (const { request } of replayed) for (const { n, gestureId } of request.intents) {
      const localId = `${gestureId}/0`;
      if (numbered.has(n)) assert.equal(numbered.get(n), localId, 'a retry must keep its numbered intent');
      else numbered.set(n, localId);
    }
    assert.deepEqual([...numbered].map(([n, localId]) => ({ n, localId })),
      savedPending.map(({ localId }, index) => ({ n: index + 1, localId })));
    const newCommandBorn = sql(`select born from sync_spent where type = 'session' and id = '${importedSession.id}'`);
    assert.ok(newCommandBorn);
    assert.notEqual(newCommandBorn, oldCommandBorn, 'replayed command must create a new incarnation');
    assert.equal(replica().entry(commandDelete.localIds[0]).intent.d[0].born, newCommandBorn);
    assert.equal(sql(`select count(*) from gym_sessions where id = '${importedSession.id}'`), '0');
    assert.equal(sql(`select count(*) from sync_spent where type = 'note' and id = '${fixture.deleted.id}'`), '1');
    assert.deepEqual(replica().notices, []);
    console.log(`PASS ${order}: reload retained recovery; replay moved the command delete to its new born`);

    engine.setOnline(false);
    await until('replay pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
    pausePull = false;
    engine.setOnline(true);
    await confirmed('unsent');
    await confirmed('acked');
    assert.equal(replica().confirmedRow(scope, 'note', fixture.newer.id), undefined);
    assert.equal(replica().confirmedRow(scope, 'note', fixture.deleted.id), undefined);
    assert.equal(replica().confirmedRow(scope, 'note', fixture.shared.id), undefined);
    assert.equal(replica().confirmedRow(scope, 'session', importedSession.id), undefined);
    const recovered = engine.observe(scope).getSnapshot().stored.filter(({ t }) => t === 'note')
      .map(({ id, f }) => ({ id, title: f.title[0], body: f.body[0] })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(recovered, expectedNotes('baseline', 'acked', 'unsent', 'edited')
      .map((note) => note.id === fixture.edited.id ? { ...note, body: editedBody } : note));
    assert.ok(engine.observe(scope).getSnapshot().drawn.every(({ id }) => id !== fixture.deleted.id && id !== fixture.shared.id && id !== importedSession.id));
    assert.deepEqual(notes(), recovered);
    assert.equal(Cursor.decode(replica().cursorOf(scope).cursor).e, newEpoch);
    assert.ok(trace.some((request) => request.endpoint === 'pull' && request.epoch === newEpoch
      && request.request.scopes.some(({ scope: name, cursor }) => name === scope && cursor === null)));
    assert.deepEqual(replica().notices, []);
    assert.ok(!failures.some((operation) => ['storage', 'auth', 'observer', 'leadership'].includes(operation)));
    assert.ok(events.some(({ name }) => name === 'sync-commit'));
    console.log(`PASS ${order}: bootstrap settled every owed create/edit/delete; client and server agree, with no notices`);
    const newUnpredictedBorn = sql(`select born from gym_sessions where id = '${unpredictedSession.id}'`);
    assert.ok(newUnpredictedBorn);
    assert.notEqual(newUnpredictedBorn, oldUnpredictedBorn);
    assert.equal(replica().confirmedRow(scope, 'session', unpredictedSession.id).born, newUnpredictedBorn);
    engine.close();
    await recoverPeer(peers[1], newEpoch, true);
    assert.equal(sql(`select born from gym_sessions where id = '${unpredictedSession.id}'`), newUnpredictedBorn);
    assert.equal(replica().confirmedRow(scope, 'session', unpredictedSession.id).born, newUnpredictedBorn);
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
}

for (const order of ['pull-first', 'push-first']) await prove(order);
