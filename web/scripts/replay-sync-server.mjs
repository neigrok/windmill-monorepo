import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserSyncEngine } from '../src/platform/sync/engine.js';
import { HttpTransport } from '../src/platform/sync/transport.js';
import { registry } from '../src/platform/sync/schema.js';
import { Cursor } from '../../packages/api-contract/sync/reference/core/wire.js';
import { scopeDigest } from '../../packages/api-contract/sync/reference/core/digest.js';
import { FakeTimers } from '../test/platform/sync/fakes.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binDir = resolve(process.argv[2] ?? join(root, 'backend/build'));
const database = `wm_web_b1_${process.pid}`;
const host = process.env.PGHOST ?? '/tmp';
const url = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
const base = 'http://127.0.0.1:8090';
const temporary = mkdtempSync(join(tmpdir(), 'wm-web-b1-replay-'));
const log = openSync(join(temporary, 'server.log'), 'w');
const secret = randomBytes(24).toString('hex'), hash = createHash('sha256').update(secret).digest('hex'), account = randomUUID();
let server, created = false;
const engines = [];
const commands = (program, args, options = {}) => execFileSync(program, args, { cwd: root, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
try {
  let listeners = '';
  try { listeners = commands('lsof', ['-tiTCP:8090', '-sTCP:LISTEN']).toString().trim(); } catch (error) { if (error.status !== 1) throw error; }
  assert.equal(listeners, '', 'port 8090 must be free');
  commands('createdb', ['-h', host, database]); created = true;
  commands('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', 'backend/db/schema.sql']);
  commands('psql', [url, '-v', 'ON_ERROR_STOP=1'], { input: `INSERT INTO users(id,email) VALUES ('${account}','web-b1-${process.pid}@example.com'); INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('${hash}','${account}',${Date.now() + 86400000});` });
  server = spawn(join(binDir, 'windmill_server'), [], { cwd: root, env: { ...process.env, DATABASE_URL: url, PORT: '8090',
    WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: base,
    RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '' }, stdio: ['ignore', log, log] });
  let startError; server.on('error', (error) => { startError = error; });
  for (let attempt = 0; ; attempt++) {
    if (startError) throw startError;
    if (server.exitCode !== null) throw new Error('backend exited before readiness');
    try { if ((await fetch(`${base}/v1/sync/hello`, { headers: { 'Sync-Schema': String(registry.version), Cookie: `wm_session=${secret}` }, signal: AbortSignal.timeout(1000) })).status === 200) break; } catch {}
    if (attempt === 100) throw new Error('backend readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const timers = new FakeTimers(); timers.time = Date.now();
  const reading = () => ({ wall: timers.time, mono: timers.time, boot: 'server-replay' });
  let loseReply = false, losses = 0, requests = 0;
  const transport = new HttpTransport({ schema: registry.version, base, reading, timers: globalThis,
    fetch: async (url, options) => {
      requests++;
      const response = await fetch(url, { ...options, headers: { ...options.headers, Cookie: `wm_session=${secret}` } });
      if (loseReply && url.endsWith('/push')) { loseReply = false; losses++; await response.text(); throw new Error('reply lost after admission'); }
      return response;
    } });
  const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), name: 'real-server', registry,
    transport, timers, now: () => timers.time, monotonic: () => timers.time, document: null, window: null,
    telemetry: { event() {}, failure() {} } });
  engines.push(engine);
  await engine.signIn(account);
  engine.started = true; engine.leader = true;
  let gestures = 0;
  for (let step = 0; step < 12; step++) {
    timers.time += 1000;
    await engine.commit('self/gym', [{ op: 'put', t: 'weighin', id: `2026-10-${String(1 + step % 3).padStart(2, '0')}`, present: true, f: { kg: 70 + step, recordedAt: timers.time } }]); gestures++;
    if (step === 3) {
      await engine.commit('self/journal', [], { cmd: { name: 'journal.claimPage', args: { day: '2026-10-04', body: 'Replay fixture', mood: 5, energy: 5, source: 'typed', claimId: 'claim_web_b1_replay_0001' } } }); gestures++;
    }
    loseReply = step === 4;
    engine.kick(); await engine.send(); timers.time += 60_000;
    engine.kick(); await engine.send(); engine.kickPull(); await engine.pull();
  }
  for (let i = 0; i < 20 && engine.device.activeReplica.outbox.length; i++) { timers.time += 60_000; engine.kick(); await engine.send(); engine.kickPull(); await engine.pull(); }
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.deepEqual(engine.device.activeReplica.notices, []);
  for (const scope of ['self/gym', 'self/journal']) {
    const { response } = await transport.request('pull', { scopes: [{ scope, cursor: null }] });
    assert.equal(response.status, 200);
    const page = response.body.pages[0];
    assert.equal(page.more, false);
    const local = (await engine.store.read([scope])).device.activeReplica.confirmedRows(scope);
    assert.deepEqual(local.sort((a, b) => JSON.stringify([a.t, a.id]).localeCompare(JSON.stringify([b.t, b.id]))), page.rows.sort((a, b) => JSON.stringify([a.t, a.id]).localeCompare(JSON.stringify([b.t, b.id]))));
    assert.equal(scopeDigest(local), page.digest);
    assert.equal(engine.device.activeReplica.cursorOf(scope).digest, page.digest);
    assert.equal(Cursor.decode(engine.device.activeReplica.cursorOf(scope).cursor).s, page.seq);
  }
  assert.equal(losses, 1);
  const eventSession = randomUUID();
  const intake = await fetch(`${base}/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `wm_session=${secret}` },
    body: JSON.stringify({ sessionKey: eventSession, events: [{ name: 'sync_writer', clientMs: Date.now(), props: { durationMs: 1, queueMs: 0 } }] }), signal: AbortSignal.timeout(5000) });
  assert.equal(intake.status, 202); assert.deepEqual(await intake.json(), { accepted: 1 });
  assert.equal(commands('psql', [url, '-Atc', `select count(*) from events where session_key='${eventSession}' and name='sync_writer'`]).toString().trim(), '1');
  console.log(JSON.stringify({ gate: 'real-server replay', steps: 12, gestures, lostReplies: losses, scopes: 2, requests, persistedTelemetryEvents: 1, pending: 0, converged: true }));
} finally {
  for (const engine of engines) engine.close();
  if (server?.pid) {
    let listener = '';
    try { listener = commands('lsof', ['-tiTCP:8090', '-sTCP:LISTEN']).toString().trim(); } catch {}
    if (listener) { assert.equal(Number(listener), server.pid, 'refusing to stop an unrelated listener'); process.kill(Number(listener), 'SIGTERM'); }
    else if (server.exitCode === null) server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.exitCode !== null ? resolve() : server.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('backend shutdown timed out')), 5000).unref())]);
  }
  closeSync(log);
  if (created) commands('dropdb', ['-h', host, database]);
  rmSync(temporary, { recursive: true, force: true });
}
