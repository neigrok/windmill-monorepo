// Prerequisites: built production/test-clock servers and epoch tool, matching-major PostgreSQL CLI, lsof, and npm ci --prefix web.
// Run from the repo: node backend/test/e2e/sync_epoch_restore.mjs --maintenance-db postgresql:///postgres?host=/tmp
// Uses the production browser engine and HTTP transport with the web tests' IndexedDB and Web Locks substitutes.
// Both reconnect orders retain work across replicas, including deletes before source replay and wrong-born notices.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BrowserSyncEngine } from '../../../web/src/platform/sync/engine.js';
import { HttpTransport } from '../../../web/src/platform/sync/transport.js';
import { Cursor } from '../../../packages/api-contract/sync/reference/core/wire.js';
import { registry } from '../../../web/src/platform/sync/schema.js';
import { FakeLocks } from '../../../web/test/platform/sync/fakes.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireWeb = createRequire(resolve(repo, 'web/package.json'));
const { IDBFactory } = requireWeb('fake-indexeddb');
const { values } = parseArgs({ options: {
  'server-bin': { type: 'string', default: resolve(repo, 'backend/build/windmill_server') },
  'clock-server-bin': { type: 'string', default: resolve(repo, 'backend/build/windmill_server_test_clock') },
  'rotate-bin': { type: 'string', default: resolve(repo, 'backend/build/windmill_rotate_sync_epoch') },
  'maintenance-db': { type: 'string', default: 'postgresql:///postgres?host=/tmp' },
  port: { type: 'string' },
} });
async function prove(order, clocked = false) {
  const label = `${clocked ? 'command ' : ''}${order}`;
  const database = `ep_restore_${process.pid}_${randomBytes(4).toString('hex')}`;
  const url = new URL(values['maintenance-db']);
  url.pathname = `/${database}`;
  const databaseUrl = url.href;
  const scratch = mkdtempSync(resolve(tmpdir(), 'ep-restore-'));
  const logPath = resolve(scratch, 'server.log');
  const dumpPath = resolve(scratch, 'older.dump');
  const clockPath = resolve(scratch, 'clock');
  const account = randomUUID();
  const token = randomBytes(24).toString('hex');
  const indexedDB = new IDBFactory();
  const scope = 'self/gym';
  const failures = [], failureDetails = [], trace = [], events = [], callbacks = [];
  const fixture = {
    baseline: { id: 'ep_baseline', title: 'Backup note', body: 'Present in the older dump' },
    newer: { id: 'ep_newer_confirmed', title: 'Newer note', body: 'Confirmed after the older dump' },
    acked: { id: 'ep_acked_pending', title: 'Accepted note', body: 'Accepted but not pulled before the restore' },
    unsent: { id: 'ep_unsent_pending', title: 'Offline note', body: 'Committed offline before the restore' },
    edited: { id: 'ep_edited_pending', title: 'Edited note', body: 'Accepted before the offline edit' },
    deleted: { id: 'ep_deleted_pending', title: 'Deleted note', body: 'Accepted before the offline delete' },
    shared: { id: 'ep_shared_pending', title: 'Shared note', body: 'Another replica deletes this before replay' },
    receiptAck: { id: 'ep_receipt_ack', title: 'Unpulled note', body: 'Accepted before the backup without a covering pull' },
  };
  const editedBody = 'Edited offline before the restore';
  const importedSession = { id: 'ep_imported_session', startedAt: 1000, finishedAt: 2000, sets: [] };
  const unpredictedSession = { id: 'ep_unpredicted_session', startedAt: 3000, finishedAt: 4000, sets: [] };
  const joined = { source: 'ep_joined_source', requested: ['ep_joined_first', 'ep_joined_second'], commands: [] };
  const joinedIds = [joined.source, ...joined.requested];
  const peers = [
    { name: `${database}-delete-first`, t: 'note', id: fixture.shared.id },
    { name: `${database}-delete-after-command`, t: 'session', id: unpredictedSession.id },
  ];
  const removals = [false, true].map((owed) => ({ owed, name: `${database}-removal-${owed}`,
    routine: `ep_removal_${owed}`, proposal: `ep_proposal_${owed}` }));
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const tickServer = () => { if (clocked) writeFileSync(clockPath, String(now())); };
  let server, engine, port, origin, created = false, pausePull = false, pausePush = false;
  const commandOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const run = (command, args, options = {}) => execFileSync(command, args, { ...commandOptions, ...options });
  const sql = (statement) => run('psql', [databaseUrl, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', statement]).trim();
  const epoch = () => sql('select epoch from sync_meta');
  const notes = () => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body) order by id), '[]') from gym_notes where user_id = '${account}'`));
  const expectedNotes = (...names) => [...names, ...(clocked ? ['receiptAck'] : [])]
    .map((name) => fixture[name]).sort((a, b) => a.id.localeCompare(b.id));
  const replica = () => engine.device.activeReplica;
  const pending = () => replica().entries(scope).map(({ localId, state, commitOrder }) => ({ localId, state, commitOrder }));
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  async function raw(intent) {
    tickServer();
    const response = await fetch(`${origin}/v1/sync/push`, { method: 'POST',
      headers: { 'Sync-Schema': String(registry.version), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ account, replica: `rp_${randomBytes(16).toString('hex')}`, ackThrough: 0, intents: [{ ...intent, n: 1 }] }),
      signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.results.map(({ s }) => s), ['ok']);
  }

  async function until(label, condition, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await condition()) return;
      if (server && (server.exitCode !== null || server.signalCode !== null)) {
        throw new Error(`${label}: ${server.spawnfile} exited (code=${server.exitCode}, signal=${server.signalCode})`);
      }
      await sleep(25);
    }
    throw new Error(`${label}: timed out; failures=${JSON.stringify(failures)} pending=${JSON.stringify(engine ? pending() : [])}`
      + ` network=${JSON.stringify(engine ? { sending: engine.sending, pulling: engine.pulling, inFlight: engine.inFlight.size } : {})}`);
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
    tickServer();
    const log = openSync(logPath, 'a');
    server = spawn(resolve(values[clocked ? 'clock-server-bin' : 'server-bin']), [], { cwd: scratch, stdio: ['ignore', log, log], env: {
      ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), WINDMILL_HOST: '127.0.0.1',
      WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin, WINDMILL_COOKIE_DOMAIN: '',
      RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '',
      JOURNAL_NUDGE_ENABLED: '0', SENTRY_DSN: '', AMPLITUDE_API_KEY: '',
      ...(clocked ? { WM_TEST_CLOCK_FILE: clockPath } : {}),
    } });
    closeSync(log);
    await once(server, 'spawn');
    await until('server readiness', async () => {
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
      reading: () => ({ wall: now(), mono: Math.floor(performance.now()), boot: 'restore-proof' }),
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
        tickServer();
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
      now,
      telemetry: { event: (name, props) => events.push({ name, props }), failure: (operation) => {
        failures.push(operation);
        failureDetails.push({ client: name, operation, stack: new Error().stack });
      } },
      onPushResult: (_replica, _command, result) => callbacks.push({ client: name, result }),
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
    assert.ok(responses.length >= (refused ? 2 : 1));
    assert.ok(responses.every(({ status, epoch }) => status === 200 && epoch === newEpoch));
    assert.equal(responses[0].request.replica, peer.replica);
    if (refused) assert.notEqual(responses.at(-1).request.replica, peer.replica);
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
    console.log(`PASS ${label}: ${refused ? 'wrong-born delete retained in a durable notice' : 'peer delete persisted before its retained source replays'}`);
  }

  async function recoverRemoval(peer, newEpoch) {
    pausePull = order === 'push-first';
    pausePush = order === 'pull-first';
    const started = trace.length, callbackStart = callbacks.length, eventStart = events.length;
    await openClient(false, peer.name);
    assert.deepEqual(replica().entries(scope), peer.entries);
    let reset;
    engine.onEvent((event) => {
      if (event.event !== 'activeReplicaChanged' || event.previous !== peer.replica) return;
      reset = structuredClone(replica().entries(scope));
      engine.setOnline(false);
    });
    await engine.start();
    engine.setOnline(true);
    await until('removal observes the restored epoch', () => reset && !engine.sending && !engine.pulling);
    assert.equal(replica().meta.serverEpoch, newEpoch);
    const first = trace.slice(started);
    if (order === 'push-first') {
      assert.deepEqual(first.map(({ endpoint, status }) => ({ endpoint, status })), [{ endpoint: 'push', status: 200 }]);
      assert.deepEqual(first[0].results.map(({ s }) => s), ['ok']);
      assert.equal(first[0].request.intents[0].n, peer.owed ? 2 : 1);
      assert.equal(sql(`select count(*) from gym_proposal_applies where id = '${peer.proposal}' and user_id = '${account}'`), '1');
    } else assert.ok(first.every(({ endpoint }) => endpoint === 'pull'));
    const accepted = order === 'push-first' && !peer.owed;
    assert.deepEqual(reset.map(({ state }) => state), peer.owed ? ['ready', 'ready'] : [accepted ? 'acked' : 'ready']);
    engine.close();
    await openClient(false, peer.name);
    assert.deepEqual(replica().entries(scope), reset);
    pausePull = true;
    pausePush = false;
    await engine.start();
    engine.setOnline(true);
    await until('removal recovery records only successful outcomes', () => pending().length === peer.entries.length
      && pending().every(({ state }) => state === 'acked'));
    const pushes = trace.slice(started).filter(({ endpoint }) => endpoint === 'push');
    assert.ok(pushes.every(({ status, results }) => status === 200 && results.every(({ s }) => s === 'ok')));
    const applied = pushes.flatMap(({ request }) => request.intents).filter(({ cmd }) => cmd?.name === 'gym.applyProposal');
    assert.equal(applied.length, order === 'push-first' && peer.owed ? 2 : 1);
    assert.deepEqual(callbacks.slice(callbackStart).map(({ client, result }) => ({ client, s: result.s })),
      peer.entries.map(() => ({ client: peer.name, s: 'ok' })));
    assert.deepEqual(replica().notices, []);
    assert.ok(events.slice(eventStart).every(({ name }) => name !== 'sync-refused'));
    assert.equal(sql(`select count(*) from gym_routines where id = '${peer.routine}'`), '0');
    assert.equal(sql(`select count(*) from gym_proposals where id = '${peer.proposal}'`), '0');
    assert.equal(sql(`select count(*) from gym_proposal_applies where id = '${peer.proposal}' and user_id = '${account}'`), '1');
    engine.setOnline(false);
    await until('removal stalled pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
    pausePull = false;
    engine.setOnline(true);
    await until('removal bootstrap settled', () => pending().length === 0
      && Cursor.decode(replica().cursorOf(scope).cursor)?.e === newEpoch
      && Cursor.decode(replica().cursorOf(scope).cursor)?.m === 'live');
    assert.equal(replica().confirmedRow(scope, 'routine', peer.routine), undefined);
    assert.equal(replica().confirmedRow(scope, 'proposal', peer.proposal), undefined);
    engine.close();
    await openClient(false, peer.name);
    assert.deepEqual(pending(), []);
    assert.deepEqual(replica().notices, []);
    engine.close();
    const outcome = order === 'push-first' ? peer.owed ? 'replayed from its durable receipt' : 'retained its known success'
      : peer.owed ? 'followed its older acknowledgement' : 'applied after the epoch reset';
    console.log(`PASS ${label}: applied removal ${outcome}, with no refusal`);
  }

  const errors = [];
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
    if (clocked) for (const peer of removals) {
      const stamp = `${now()}:0:r_aaaaaaaaaaaa`;
      const create = (t, id, fields) => ({ scope, d: [{ t, id, born: stamp, life: ['alive', stamp],
        f: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, [value, stamp]])) }] });
      const line = { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 80 }], restSeconds: 180 };
      await raw(create('routine', peer.routine, { name: 'Restore routine', position: 0, entries: [line] }));
      await raw({ ...create('proposal', peer.proposal, { routineId: peer.routine, intent: 'remove', proposedName: 'Restore routine',
        summary: 'Remove this routine', changes: [{ kind: 'removed', exerciseId: line.exerciseId, before: { sets: line.sets, restSeconds: line.restSeconds } }],
        door: 'ask', connection: '', agent: '' }),
      guard: ['name', 'entries'].map((field) => ({ t: 'routine', id: peer.routine, field, stamp })) });
    }
    await openClient(true);
    assert.equal((await engine.signIn(account)).complete, true);
    await engine.start();
    await createNote('baseline');
    await confirmed('baseline');
    const oldEpoch = epoch();
    assert.equal(replica().meta.serverEpoch, oldEpoch);
    if (clocked) {
      engine.close();
      for (const peer of removals) {
        await openClient(true, peer.name);
        assert.equal((await engine.signIn(account)).complete, true);
        await engine.start();
        await until('removal replica learned its proposal', () => replica().confirmedRow(scope, 'proposal', peer.proposal));
        engine.setOnline(false);
        await until('removal replica offline', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
        if (peer.owed) {
          pausePull = true;
          engine.setOnline(true);
          const ack = await createNote('receiptAck');
          await until('old acknowledgement retained in the backup', () => replica().entry(ack.localIds[0])?.state === 'acked');
          engine.setOnline(false);
          await until('removal source pull aborted', () => !engine.sending && !engine.pulling && engine.inFlight.size === 0);
          pausePull = false;
        }
        await engine.commit(scope, [], { cmd: { name: 'gym.applyProposal', args: { proposalId: peer.proposal } },
          predict: [{ op: 'update', t: 'proposal', id: peer.proposal, f: { state: 'applied', settledAt: now() } },
            { op: 'delete', t: 'routine', id: peer.routine }] });
        peer.entries = structuredClone(replica().entries(scope));
        peer.replica = replica().id;
        assert.deepEqual(peer.entries.map(({ state }) => state), peer.owed ? ['acked', 'ready'] : ['ready']);
        engine.close();
      }
      await openClient(true);
      await engine.start();
    }
    run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, databaseUrl]);
    console.log('PASS client synced; an older whole-database dump was saved');

    await createNote('newer');
    await confirmed('newer');
    if (clocked) await raw({ scope, cmd: { name: 'gym.start', args: { id: joined.source, startedAt: now(), joinOpenSession: true } } });
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
    if (clocked) for (const id of joined.requested) {
      const result = await engine.commit(scope, [], {
        cmd: { name: 'gym.start', args: { id, startedAt: now(), joinOpenSession: true } },
        predict: [{ op: 'create', t: 'session', id, f: { startedAt: now() } }],
      });
      await until('start retained its joined target', () => replica().entry(result.localIds[0])?.state === 'acked');
      joined.commands.push(result.localIds[0]);
      assert.equal(replica().entry(result.localIds[0]).predict[0].id, joined.source);
    }
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
    if (clocked) {
      clockOffset += 5 * 3600_000;
      tickServer();
    }
    await openClient(false);
    await engine.start();
    await createNote('unsent');
    await engine.commit(scope, [{ op: 'update', t: 'note', id: fixture.edited.id, f: { body: editedBody } }]);
    await engine.commit(scope, [{ op: 'delete', t: 'note', id: fixture.deleted.id }]);
    const commandDelete = await engine.commit(scope, [{ op: 'delete', t: 'session', id: importedSession.id }]);
    assert.equal(replica().entry(commandDelete.localIds[0]).intent.d[0].born, oldCommandBorn);
    if (clocked) {
      const result = await engine.commit(scope, [{ op: 'delete', t: 'session', id: joined.source }]);
      joined.delete = result.localIds[0];
      assert.equal(replica().entry(joined.delete).intent.d[0].id, joined.source);
    }
    const savedPending = pending();
    const savedEntries = structuredClone(replica().entries(scope));
    assert.deepEqual(savedPending.map(({ state }) => state), [...Array(clocked ? 8 : 6).fill('acked'), ...Array(clocked ? 5 : 4).fill('ready')]);
    assert.deepEqual(notes(), expectedNotes('baseline', 'newer', 'acked', 'edited', 'deleted', 'shared'));
    const oldReplica = replica().id;
    const oldCursor = replica().cursorOf(scope).cursor;
    assert.equal(Cursor.decode(oldCursor).e, oldEpoch);
    engine.close();
    console.log(`PASS ${label}: unpulled creates/command and independent/dependent offline work are durable`);

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
    if (clocked) for (const peer of removals) await recoverRemoval(peer, newEpoch);
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
    console.log(`PASS ${label}: epoch transition precedes retry and returns every owed entry to commit order`);

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
    if (clocked) {
      const deletion = replica().entry(joined.delete).intent.d[0];
      const target = joined.requested[0];
      const born = sql(`select born from sync_spent where type = 'session' and id = '${target}'`);
      assert.equal(deletion.id, target);
      assert.ok(born);
      assert.equal(deletion.born, born);
      for (const localId of joined.commands) {
        assert.equal(replica().entry(localId).predict[0].id, target);
        assert.equal(replica().entry(localId).intent.cmd.args.id, target);
      }
      assert.equal(sql(`select count(*) from gym_sessions where id in (${joinedIds.map((id) => `'${id}'`).join(', ')})`), '0');
      console.log(`PASS ${label}: both joined starts and their delete followed one replayed target and born`);
    }
    assert.deepEqual(replica().notices, []);
    console.log(`PASS ${label}: reload retained recovery; replay moved the command delete to its new born`);

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
    if (clocked) for (const id of joinedIds) {
      assert.equal(replica().confirmedRow(scope, 'session', id), undefined);
      assert.ok(engine.observe(scope).getSnapshot().drawn.every((row) => row.t !== 'session' || row.id !== id));
    }
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
    assert.ok(!failures.some((operation) => ['storage', 'auth', 'observer', 'leadership'].includes(operation)), JSON.stringify(failureDetails));
    assert.ok(events.some(({ name }) => name === 'sync-commit'));
    console.log(`PASS ${label}: bootstrap settled every owed create/edit/delete; client and server agree, with no notices`);
    const newUnpredictedBorn = sql(`select born from gym_sessions where id = '${unpredictedSession.id}'`);
    assert.ok(newUnpredictedBorn);
    assert.notEqual(newUnpredictedBorn, oldUnpredictedBorn);
    assert.equal(replica().confirmedRow(scope, 'session', unpredictedSession.id).born, newUnpredictedBorn);
    engine.close();
    if (clocked) {
      await openClient(false);
      assert.deepEqual(pending(), []);
      assert.deepEqual(replica().notices, []);
      for (const id of joinedIds) {
        assert.equal(replica().confirmedRow(scope, 'session', id), undefined);
        assert.ok(engine.observe(scope).getSnapshot().drawn.every((row) => row.t !== 'session' || row.id !== id));
      }
      engine.close();
    }
    await recoverPeer(peers[1], newEpoch, true);
    assert.equal(sql(`select born from gym_sessions where id = '${unpredictedSession.id}'`), newUnpredictedBorn);
    assert.equal(replica().confirmedRow(scope, 'session', unpredictedSession.id).born, newUnpredictedBorn);
  } catch (error) {
    errors.push(error);
  } finally {
    try { engine?.close(); } catch (error) { errors.push(error); }
    try { await stopServer(); } catch (error) { errors.push(error); }
    try {
      if (created) run('dropdb', [`--maintenance-db=${values['maintenance-db']}`, '--if-exists', '--force', database]);
    } catch (error) { errors.push(error); }
    if (errors.length) {
      console.error(`Restore proof failed (${label}); server log: ${logPath}`);
      try { console.error(readFileSync(logPath, 'utf8') || '(server log is empty)'); }
      catch (error) { console.error(`Could not read server log: ${error.message}`); }
      rmSync(dumpPath, { force: true });
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Restore proof and cleanup failed');
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const clocked of [false, true]) for (const order of ['pull-first', 'push-first']) await prove(order, clocked);
