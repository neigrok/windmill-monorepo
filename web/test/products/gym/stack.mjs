import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { chromium } from 'playwright';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { HttpTransport } from '../../../src/platform/sync/transport.js';
import { createGymApi } from '../../../src/products/gym/gymSync.js';
import { environment } from '../../platform/sync/fakes.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixturePath = fileURLToPath(new URL('./rest-parity.fixture.json', import.meta.url));
const day = 86400000;

export async function waitUntil(check, { processes = [], timeout = 15000, interval = 50, label = 'condition' } = {}) {
  const until = performance.now() + timeout;
  for (;;) {
    for (const process of processes) {
      if (process.startError) throw new Error(`${label}: process could not start`, { cause: process.startError });
      if (process.exitCode !== null || process.signalCode !== null) throw new Error(`${label}: process exited before readiness`);
    }
    let timer;
    try {
      const answered = await Promise.race([check(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out`)), Math.max(1, until - performance.now()));
      })]);
      if (answered) return;
    } finally { clearTimeout(timer); }
    if (performance.now() >= until) throw new Error(`${label}: timed out`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function stopOwnedServer({ child, port }, listener, { kill = process.kill, timeout = 5000 } = {}) {
  const pid = listener(port);
  if (pid) {
    assert.equal(Number(pid), child.pid, `refusing to stop unrelated port ${port} listener`);
    kill(Number(pid), 'SIGTERM');
  } else if (child.exitCode === null && child.signalCode === null && !child.startError) child.kill('SIGTERM');
  const ended = () => child.exitCode !== null || child.signalCode !== null || child.startError;
  try { await waitUntil(ended, { timeout, interval: 5, label: `port ${port} shutdown` }); }
  catch (error) {
    if (!ended()) child.kill('SIGKILL');
    await waitUntil(ended, { timeout, interval: 5, label: `port ${port} forced cleanup` });
    throw error;
  }
  assert.equal(listener(port), '', `port ${port} remained occupied after shutdown`);
}

async function compareParity(fixture) {
  const { projectGym } = await import('../../../src/products/gym/syncProjections.js');
  const failures = [];
  for (const sample of fixture.samples) {
    const view = projectGym(fixture.rows, { now: sample.now ?? fixture.now, timeZone: 'UTC' });
    try { assert.deepEqual(await view[sample.method](...sample.args), sample.expected); }
    catch (error) { failures.push({ method: sample.method, args: sample.args, error }); }
  }
  return { passed: fixture.samples.length - failures.length, total: fixture.samples.length, failures };
}

async function run() {
  const binDir = resolve(process.argv[2] ?? join(root, 'backend/build'));
  const capture = process.argv.includes('--capture');
  const parityOnly = process.argv.includes('--parity');
  const database = `wm_web_b2_gym_${process.pid}`;
  const host = process.env.PGHOST ?? '/tmp';
  const databaseUrl = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
  const base = 'http://127.0.0.1:8094';
  const origin = 'http://127.0.0.1:5181';
  const temporary = mkdtempSync(join(tmpdir(), 'wm-web-b2-gym-'));
  const log = openSync(join(temporary, 'stack.log'), 'w');
  const secret = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(secret).digest('hex');
  const account = randomUUID();
  const now = Date.now();
  let created = false, completed = false, browser, lastPage, phone, e2e = 0;
  const pageErrors = [];
  const servers = [];
  const commands = (program, args, options = {}) => execFileSync(program, args, { cwd: root, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const sql = (input) => commands('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At'], { input }).toString().trim();
  const listener = (port) => {
    try { return commands('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']).toString().trim(); }
    catch (error) { if (error.status === 1) return ''; throw error; }
  };
  const start = (program, args, port, env) => {
    const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
    child.on('error', (error) => { child.startError = error; });
    servers.push({ child, port });
    return child;
  };
  const request = async (path, { body, method = body === undefined ? 'GET' : 'POST', sync = false } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: `wm_session=${secret}`, 'Content-Type': 'application/json', ...(sync ? { 'Sync-Schema': String(registry.version) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (response.status === 404 && method === 'GET') return null;
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  try {
    for (const port of [8094, 5181]) assert.equal(listener(port), '', `port ${port} must be free`);
    commands('createdb', ['-h', host, database]); created = true;
    commands('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', 'backend/db/schema.sql']);
    sql(`
      INSERT INTO users(id,email,name) VALUES ('${account}','web-b2-gym-${process.pid}@example.com','Gym fixture');
      INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('${hash}','${account}',${now + day});
    `);
    const backend = start(join(binDir, 'windmill_server'), [], 8094, { DATABASE_URL: databaseUrl, PORT: '8094', WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin, SENTRY_DSN: '', AMPLITUDE_API_KEY: '', RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '' });
    await waitUntil(async () => { try { return Boolean(await request('/v1/sync/hello', { sync: true })); } catch { return false; } }, { processes: [backend], label: 'backend readiness' });

    // The phone is a second replica of the account and writes the way the native apps do: commands and
    // record changes pushed through the engine, never a gym REST door.
    phone = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), name: 'stack-phone', registry, document: null, window: null,
      telemetry: { event() {}, failure() {} },
      transport: new HttpTransport({ schema: registry.version, base, timers: globalThis,
        reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: 'stack-phone' }),
        fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Cookie: `wm_session=${secret}` } }) }) });
    await phone.signIn(account);
    phone.started = true; phone.leader = true;
    const pushFromPhone = async () => waitUntil(async () => {
      phone.kick(); await phone.send();
      return phone.device.activeReplica.outbox.every((entry) => entry.state === 'acked');
    }, { processes: [backend], label: 'phone push admission' });
    const pullToPhone = async () => { phone.kickPull(); await phone.pull(); };
    const phoneGym = createGymApi(phone, { event() {}, failure() {} });

    // An agent's writes arrive through MCP under a personal key, the way a connected assistant's do.
    const key = await request('/v1/mcp-keys', { body: { name: 'stack' } });
    const opened = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stack', version: '0' } } }),
      signal: AbortSignal.timeout(5000) });
    assert.ok(opened.ok, `MCP initialize: HTTP ${opened.status}`);
    const mcpSession = opened.headers.get('mcp-session-id');
    const agent = async (name, args) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key.token}`, 'Mcp-Session-Id': mcpSession, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(5000) });
      const reply = await response.json();
      assert.ok(response.ok && reply.result && !reply.result.isError, `${name}: ${JSON.stringify(reply.error ?? reply.result?.content)}`);
    };

    const ramp = [{ reps: 5, weightKg: 60 }, { reps: 5, weightKg: 80 }, {}];
    await agent('gym_create_exercise', { id: 'ex_fixture_custom', name: 'Fixture Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 1.25 });
    await phoneGym.renameExercise('back-squat', 'Fixture Squat');
    await phoneGym.createRoutine({ id: 'rt_fixture_main', name: 'Fixture Lower', position: 0, entries: [
      { exerciseId: 'back-squat', sets: ramp, restSeconds: 180 }, { exerciseId: 'pull-up' },
      { exerciseId: 'ex_fixture_custom', sets: [{ reps: 10, weightKg: 24 }], restSeconds: 60 }] });
    await phoneGym.savePreferences({ units: 'kg', restSeconds: 180, restSound: false, confirmHaptic: false, confirmSound: true });
    for (const [id, title, body] of [['note_fixture_a', 'Fixture goal', 'Synthetic fixture note'], ['note_fixture_b', 'Fixture cue', '']]) {
      await phoneGym.saveNote(id, { title, body });
    }
    for (const [daysAgo, weightKg] of [[14, 80.1], [1, 79.55]]) {
      await phoneGym.saveBodyweight(new Date(now - daysAgo * day).toISOString().slice(0, 10), { weightKg });
    }
    await pushFromPhone();
    await agent('gym_create_routine', { id: 'rt_fixture_other', name: 'Fixture Agent original', position: 1, entries: [{ exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 45 }], restSeconds: 120 }] });
    await agent('gym_propose_routine_change', { id: 'prop_fixture_settled', routineId: 'rt_fixture_other', name: 'Fixture Agent', summary: 'Fixture settled change',
      entries: [{ exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 50 }], restSeconds: 120 }] });
    await agent('gym_propose_routine_change', { id: 'prop_fixture_pending', routineId: 'rt_fixture_main', name: 'Fixture Lower A', summary: 'Fixture pending change',
      entries: [{ exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 65 }, { reps: 5, weightKg: 85 }, {}], restSeconds: 180 }, { exerciseId: 'pull-up' },
        { exerciseId: 'ex_fixture_custom', sets: [{ reps: 10, weightKg: 24 }], restSeconds: 60 }] });
    await waitUntil(async () => { await pullToPhone(); return Boolean(await phoneGym.proposal('prop_fixture_settled')); }, { processes: [backend], label: 'phone pull' });
    await phoneGym.applyProposal('prop_fixture_settled');
    for (const [index, daysAgo, routineId, sets] of [
      [1, 20, 'rt_fixture_main', [['back-squat', 40, 8, 'warmup'], ['back-squat', 80, 5, 'working'], ['pull-up', -10, 8, 'working']]],
      [2, 12, 'rt_fixture_other', [['bench-press', 50, 8, 'working'], ['bench-press', 55, 8, 'working'], ['bench-press', 30, 12, 'drop']]],
      [3, 5, 'rt_fixture_main', [['back-squat', 85, 5, 'working'], ['back-squat', 82.5, 6, 'working'], ['ex_fixture_custom', 24, 10, 'working']]],
    ]) {
      const startedAt = now - daysAgo * day;
      await phoneGym.importSession({ id: `ses_fixture_${index}`, routineId, startedAt, finishedAt: startedAt + 3600000,
        sets: sets.map(([exerciseId, weightKg, reps, kind], setIndex) => ({ id: `set_fixture_${index}_${setIndex}`, exerciseId, weightKg, reps, kind,
          rpe: kind === 'working' ? 8.5 : null, note: 'Fixture set note', completedAt: startedAt + (setIndex + 1) * 600000 })) });
    }
    const corrected = await phoneGym.session('ses_fixture_3');
    await phoneGym.correctSession('ses_fixture_3', { requestId: 'fix_fixture_3', startedAt: corrected.session.startedAt, finishedAt: corrected.session.finishedAt,
      routineName: 'Fixture corrected name', sets: corrected.sets.map(({ id, exerciseId, setNumber, weightKg, reps, rpe, note, completedAt }) =>
        ({ id, exerciseId, setNumber, weightKg, reps, rpe: rpe ?? null, note, completedAt })) });
    await pushFromPhone();

    const fixture = { now, timeZone: 'UTC', wireRows: [], rows: [], samples: [] };
    let cursor = null;
    do {
      const reply = await request('/v1/sync/pull', { sync: true, body: { scopes: [{ scope: 'self/gym', cursor }] } });
      const page = reply.pages[0];
      assert.equal(page.kind, 'rows', 'the seeded gym is readable over sync');
      fixture.wireRows.push(...page.rows);
      cursor = page.more ? page.cursor : null;
    } while (cursor !== null);
    const persisted = await BrowserSyncEngine.open({ ...environment().options, registry });
    try {
      await persisted.write(null, (device) => {
        for (const row of fixture.wireRows) device.activeReplica.putConfirmed('self/gym', row);
      }, ['self/gym']);
      fixture.rows = persisted.observe('self/gym').getSnapshot().drawn;
    } finally { persisted.close(); }
    const samples = [
      ['exercises', [], '/exercises', 'exercises'], ['lastSets', [], '/exercises/last', 'movements'],
      ['preferences', [], '/preferences'], ['notes', [], '/notes', 'notes'], ['bodyweight', [], '/bodyweight'],
      ['routines', [], '/routines', 'routines'], ['routine', ['rt_fixture_main'], '/routines/rt_fixture_main'], ['routine', ['rt_fixture_other'], '/routines/rt_fixture_other'],
      ['proposals', [], '/proposals', 'proposals'], ['proposals', [{ state: 'pending' }], '/proposals?state=pending', 'proposals'],
      ['proposal', ['prop_fixture_pending'], '/proposals/prop_fixture_pending'], ['proposal', ['prop_fixture_settled'], '/proposals/prop_fixture_settled'],
      ['sessions', [], '/sessions', 'sessions'], ['sessions', [{ limit: 1 }], '/sessions?limit=1', 'sessions'],
      ['history', [{ timeZone: 'UTC' }], '/history?timeZone=UTC'], ['history', [{ exercise: 'back-squat', timeZone: 'UTC' }], '/history?exercise=back-squat&timeZone=UTC'],
      ['history', [{ limit: 1, timeZone: 'UTC' }], '/history?limit=1&timeZone=UTC'],
      ['history', [{ routine: 'rt_fixture_main', timeZone: 'UTC' }], '/history?routine=rt_fixture_main&timeZone=UTC'],
      ['progress', [], '/stats?projection=progress'], ['stats', [], '/stats'],
      ['lastTime', ['back-squat'], '/last?exercise=back-squat'], ['lastTime', ['pull-up'], '/last?exercise=pull-up'], ['lastTime', ['deadlift'], '/last?exercise=deadlift'],
      ['record', ['back-squat'], '/exercises/back-squat/record'], ['record', ['pull-up'], '/exercises/pull-up/record'], ['record', ['ex_fixture_custom'], '/exercises/ex_fixture_custom/record'], ['record', ['deadlift'], '/exercises/deadlift/record'],
      ...[1, 2, 3].flatMap((index) => [['session', [`ses_fixture_${index}`], `/sessions/ses_fixture_${index}`], ['review', [`ses_fixture_${index}`], `/sessions/ses_fixture_${index}/review`]]),
      ['session', ['ses_fixture_missing'], '/sessions/ses_fixture_missing'], ['routine', ['rt_fixture_missing'], '/routines/rt_fixture_missing'], ['proposal', ['prop_fixture_missing'], '/proposals/prop_fixture_missing'],
    ];
    for (const [method, args, path, key] of samples) {
      const body = await request(`/v1/gym${path}`);
      const expected = key ? body[key] : body;
      fixture.samples.push({ method, args, ...(expected?.asOf ? { now: expected.asOf } : {}), expected });
    }
    assert.equal(fixture.samples.length, 36, 'strict gym parity covers every comparison');
    const parity = await compareParity(fixture);
    console.log(JSON.stringify({ gate: 'REST parity', passed: parity.passed, total: parity.total, failedMethods: [...new Set(parity.failures.map(({ method }) => method))] }));
    for (const failure of parity.failures) console.error(failure.error.message);
    assert.equal(parity.failures.length, 0, `REST parity failed ${parity.failures.length}/${parity.total} comparisons`);
    if (capture) {
      writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(JSON.stringify({ gate: 'REST fixture capture', projections: new Set(samples.map(([method]) => method)).size, comparisons: samples.length, rows: fixture.rows.length }));
      completed = true;
      return;
    }

    if (!parityOnly) {
      const vite = start(process.execPath, [join(root, 'web/node_modules/vite/bin/vite.js'), join(root, 'web'), '--host', '127.0.0.1', '--port', '5181', '--strictPort'], 5181, { VITE_API_BASE_URL: base });
      await waitUntil(async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { processes: [vite, backend], label: 'vite readiness' });
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
      await context.addCookies([{ name: 'wm_session', value: secret, url: base, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      lastPage = page;
      const gymRequests = [], commandsSeen = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/v1/gym/')) gymRequests.push(`${request.method()} ${url.pathname}`);
        if (url.pathname === '/v1/sync/push') {
          const body = request.postDataJSON();
          commandsSeen.push(...body.intents.map((intent) => intent.cmd?.name).filter(Boolean));
        }
      });
      const goto = (hash) => page.goto(`${origin}/app/gym${hash}`);
      await goto('#/gym');
      await page.getByRole('link', { name: 'Fixture Lower', exact: false }).first().waitFor();
      await page.waitForFunction(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        return syncSession.engine?.live?.following?.has('self/gym');
      });
      const phoneStart = Date.now() - 60000;
      await phone.commit('self/gym', [], { cmd: { name: 'gym.start', args: { id: 'ses_fixture_phone', routineId: 'rt_fixture_main', startedAt: phoneStart, joinOpenSession: true } },
        predict: [{ op: 'create', t: 'session', id: 'ses_fixture_phone', f: { startedAt: phoneStart } }] });
      await pushFromPhone();
      await page.locator('.gym-mirror-head').filter({ hasText: 'Training now' }).waitFor(); e2e++;
      assert.equal(await page.locator('.gym-mirror button').count(), 0, 'mirror must never control a live workout');
      await phone.commit('self/gym', [{ op: 'create', t: 'set', id: 'set_fixture_phone', f: { sessionId: 'ses_fixture_phone', exerciseId: 'back-squat',
        weightKg: 92.5, reps: 5, kind: 'working', rpe: null, note: '', completedAt: Date.now() - 5000 } }]);
      await pushFromPhone();
      await page.locator('.gym-mirror-line').filter({ hasText: '92.5 × 5' }).waitFor(); e2e++;
      const phoneFinish = Date.now() - 1000;
      await phone.commit('self/gym', [], { cmd: { name: 'gym.finish', args: { sessionId: 'ses_fixture_phone', finishedAt: phoneFinish } },
        predict: [{ op: 'update', t: 'session', id: 'ses_fixture_phone', f: { finishedAt: phoneFinish } }] });
      await pushFromPhone();
      await page.locator('.gym-mirror').waitFor({ state: 'detached' }); e2e++;

      await goto('#/gym/routines/rt_fixture_main');
      await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Fixture Web Edited');
      await page.getByRole('button', { name: 'Save routine', exact: true }).click();
      await waitUntil(async () => (await request('/v1/gym/routines/rt_fixture_main')).name === 'Fixture Web Edited', { processes: [vite, backend], label: 'web routine convergence' }); e2e++;
      const saved = await request('/v1/gym/routines/rt_fixture_main');
      assert.deepEqual(saved.entries[0].sets, [{ reps: 5, weightKg: 60 }, { reps: 5, weightKg: 80 }, {}]);

      await goto('#/gym/backfill/rt_fixture_main');
      await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
      const before = sql(`SELECT count(*) FROM gym_sessions WHERE user_id='${account}'`);
      await page.locator('.gym-save-do').click();
      await waitUntil(() => sql(`SELECT count(*) FROM gym_sessions WHERE user_id='${account}'`) === String(Number(before) + 1), { processes: [vite, backend], label: 'web backfill convergence' });
      const importedId = sql(`SELECT id FROM gym_sessions WHERE user_id='${account}' AND id NOT LIKE 'ses_fixture_%' ORDER BY started_at DESC LIMIT 1;`);
      const imported = await request(`/v1/gym/sessions/${importedId}`);
      assert.equal(imported.sets.length, 5);
      assert.ok(imported.session.finishedAt <= Date.now());
      assert.ok(commandsSeen.includes('gym.importSession'), 'backfill must use the engine command'); e2e++;

      await waitUntil(() => sql(`SELECT count(DISTINCT props->>'operation') FROM events WHERE user_id='${account}' AND name='gym_action' AND props->>'operation' IN ('routine-save','session-import') AND props->>'outcome'='saved-local';`) === '2',
        { processes: [vite, backend], label: 'gym product telemetry' });
      const writeLog = readFileSync(join(temporary, 'stack.log'), 'utf8');
      assert.ok(writeLog.includes('"operation":"sync.push"'), 'engine admission must emit its write log');

      await goto('#/gym/log');
      await page.getByRole('link', { name: 'Fixture Web Edited', exact: false }).first().waitFor();
      await waitUntil(() => page.evaluate(async () => {
        const assets = await caches.open('windmill-assets-v2');
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name).filter((raw) => {
          const url = new URL(raw);
          return url.origin === location.origin && /^\/(assets|src|@|node_modules)/.test(url.pathname);
        });
        return Boolean(navigator.serviceWorker.controller)
          && (await Promise.all(urls.map(async (url) => Boolean(await assets.match(url, { ignoreVary: true }))))).every(Boolean)
          && Boolean(await (await (await caches.open('windmill-shell-v2')).match('/offline-generation'))?.json());
      }), { processes: [vite, backend], label: 'offline shell warming' });
      await page.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        if (syncSession.engine.device.activeReplica.outbox.length) throw new Error('pending work before offline reload');
        await navigator.serviceWorker.ready;
      });
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Fixture Web Edited', exact: false }).first().waitFor();
      assert.ok(await page.getByRole('status').filter({ hasText: 'Offline.' }).count()); e2e++;
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(gymRequests.filter((request) => request !== 'GET /v1/gym/threads'), [], 'web mirror and engine writes must use no replaced REST door');
      await context.close();
      console.log(JSON.stringify({ gate: 'Playwright local stack', passed: e2e, total: 6, pending: 0, persistedGymOperations: 2, syncWriteLog: true, ports: [8094, 5181] }));
    }
    completed = true;
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) {
      await lastPage.screenshot({ path: join(temporary, 'failure.png'), fullPage: true }).catch(() => {});
      const sync = await lastPage.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        const engine = syncSession.engine;
        return { ready: syncSession.getSnapshot().ready, error: syncSession.getSnapshot().error,
          replicaState: engine?.device.activeReplica.meta.state, online: engine?.online, leader: engine?.leader };
      }).catch(() => null);
      console.error(JSON.stringify({ browserErrors: pageErrors, url: lastPage.url(), sync }));
      console.error(JSON.stringify({ gate: 'Playwright local stack', passed: e2e, total: 6, status: 'failed' }));
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    phone?.close();
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const server of servers.reverse()) {
      try { await stopOwnedServer(server, listener); } catch (error) { cleanupErrors.push(error); }
    }
    closeSync(log);
    if (created) { try { commands('dropdb', ['-h', host, database]); } catch (error) { cleanupErrors.push(error); } }
    if (completed) rmSync(temporary, { recursive: true, force: true });
    else console.error(`Stack logs: ${join(temporary, 'stack.log')}`);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'local stack cleanup failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
