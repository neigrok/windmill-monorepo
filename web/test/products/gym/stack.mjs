import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
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

async function run() {
  const binDir = resolve(process.argv[2] ?? join(root, 'backend/build'));
  const database = `${process.env.WM_E2E_DB_PREFIX ?? 'wm_web_'}gym_${process.pid}`;
  const backendPort = Number(process.env.WM_E2E_PORT ?? 8094);
  const webPort = Number(process.env.WM_E2E_WEB_PORT ?? 5181);
  const host = process.env.PGHOST ?? '/tmp';
  const databaseUrl = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
  const base = `http://127.0.0.1:${backendPort}`;
  const origin = `http://127.0.0.1:${webPort}`;
  const temporary = mkdtempSync(join(tmpdir(), 'wm-web-gym-'));
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
    for (const port of [backendPort, webPort]) assert.equal(listener(port), '', `port ${port} must be free`);
    commands('createdb', ['-h', host, database]); created = true;
    commands('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', 'backend/db/schema.sql']);
    sql(`
      INSERT INTO users(id,email,name) VALUES ('${account}','web-gym-${process.pid}@example.com','Gym fixture');
      INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('${hash}','${account}',${now + day});
    `);
    const backend = start(join(binDir, 'windmill_server'), [], backendPort, { DATABASE_URL: databaseUrl, PORT: String(backendPort), WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin, SENTRY_DSN: '', AMPLITUDE_API_KEY: '', RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '' });
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
    await phone.commit('self/gym', [{ op: 'write', t: 'prefs', id: 'prefs', f: { restSeconds: 180, restSound: false } }]);
    await phoneGym.savePreferences({ units: 'kg', confirmHaptic: false, confirmSound: true });
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

    const wireRows = [];
    let cursor = null;
    do {
      const reply = await request('/v1/sync/pull', { sync: true, body: { scopes: [{ scope: 'self/gym', cursor }] } });
      const page = reply.pages[0];
      assert.equal(page.kind, 'rows', 'the seeded gym is readable over sync');
      wireRows.push(...page.rows);
      cursor = page.more ? page.cursor : null;
    } while (cursor !== null);
    const env = environment();
    env.timers.time = now;
    const persisted = await BrowserSyncEngine.open({ ...env.options, registry });
    try {
      await persisted.write(null, (device) => {
        const replica = device.activeReplica;
        for (const row of wireRows) replica.putConfirmed('self/gym', row);
        replica.cursors['self/gym'] = { ...replica.cursorOf('self/gym'), booted: true };
      }, ['self/gym']);
      const reads = createGymApi(persisted, { event() {}, failure(operation) { assert.fail(`domain read failed: ${operation}`); },
        zone: { offsetSeconds: () => 0 } });
      assert.equal((await reads.exercises()).find(({ id }) => id === 'back-squat').name, 'Fixture Squat');
      assert.deepEqual(await reads.preferences(), { units: 'kg', restSeconds: 180, restSound: false, confirmHaptic: false, confirmSound: true });
      assert.deepEqual((await reads.notes()).map(({ id, title, body }) => ({ id, title, body })), [
        { id: 'note_fixture_a', title: 'Fixture goal', body: 'Synthetic fixture note' },
        { id: 'note_fixture_b', title: 'Fixture cue', body: '' },
      ]);
      assert.equal((await reads.bodyweight()).latest.weightKg, 79.55);
      assert.deepEqual((await reads.routines()).map(({ id }) => id), ['rt_fixture_main', 'rt_fixture_other']);
      assert.deepEqual((await reads.routine('rt_fixture_main')).entries[0].sets, ramp);
      assert.equal((await reads.proposal('prop_fixture_settled')).state, 'applied');
      assert.deepEqual((await reads.proposals({ state: 'pending' })).map(({ id }) => id), ['prop_fixture_pending']);
      assert.deepEqual((await reads.sessions()).map(({ id, setCount, workingSetCount, tonnageKg }) => ({ id, setCount, workingSetCount, tonnageKg })), [
        { id: 'ses_fixture_3', setCount: 3, workingSetCount: 3, tonnageKg: 1160 },
        { id: 'ses_fixture_2', setCount: 3, workingSetCount: 2, tonnageKg: 840 },
        { id: 'ses_fixture_1', setCount: 3, workingSetCount: 2, tonnageKg: 400 },
      ]);
      assert.deepEqual((await reads.sessions({ limit: 1 })).map(({ id }) => id), ['ses_fixture_3']);
      for (const index of [1, 2, 3]) {
        assert.deepEqual(await reads.session(`ses_fixture_${index}`), await request(`/v1/gym/sessions/ses_fixture_${index}`));
        const review = await reads.review(`ses_fixture_${index}`);
        assert.equal(review.stats.workingSets, index === 3 ? 3 : 2);
        assert.equal(review.slight, true);
      }
      assert.deepEqual((await reads.history({ timeZone: 'UTC' })).summary, { sessions: 3, sets: 7, reps: 50, tonnageKg: 2400 });
      assert.deepEqual((await reads.history({ exercise: 'back-squat', timeZone: 'UTC' })).sessions.map(({ id }) => id), ['ses_fixture_3', 'ses_fixture_1']);
      assert.deepEqual((await reads.history({ routine: 'rt_fixture_other', timeZone: 'UTC' })).sessions.map(({ id }) => id), ['ses_fixture_2']);
      const firstPage = await reads.history({ limit: 1, timeZone: 'UTC' });
      assert.deepEqual(firstPage.sessions.map(({ id }) => id), ['ses_fixture_3']);
      assert.deepEqual(firstPage.next, { before: now - 5 * day, beforeId: 'ses_fixture_3' });
      const last = await reads.lastTime('back-squat');
      assert.equal(last.session.id, 'ses_fixture_3');
      assert.deepEqual(last.sets.map(({ weightKg, reps }) => ({ weightKg, reps })), [{ weightKg: 85, reps: 5 }, { weightKg: 82.5, reps: 6 }]);
      assert.deepEqual(await reads.lastTime('deadlift'), { exerciseId: 'deadlift' });
      assert.deepEqual(await reads.lastSets(), [
        { exerciseId: 'back-squat', weightKg: 82.5, reps: 6, at: now - 5 * day },
        { exerciseId: 'bench-press', weightKg: 30, reps: 12, at: now - 12 * day },
        { exerciseId: 'ex_fixture_custom', weightKg: 24, reps: 10, at: now - 5 * day },
        { exerciseId: 'pull-up', weightKg: -10, reps: 8, at: now - 20 * day },
      ]);
      const squat = await reads.record('back-squat');
      assert.equal(squat.sessionCount, 2);
      assert.equal(squat.bestE1rm.e1rm, 85 * (1 + 5 / 30));
      assert.equal(squat.heaviest.weightKg, 85);
      assert.equal((await reads.record('pull-up')).bestE1rm, undefined);
      assert.equal((await reads.record('deadlift')).sessionCount, 0);
      const progress = await reads.progress();
      assert.deepEqual(progress.sessions.map(({ sessionId }) => sessionId), ['ses_fixture_1', 'ses_fixture_2', 'ses_fixture_3']);
      assert.equal(progress.sessions[2].movements.find(({ exerciseId }) => exerciseId === 'back-squat').estimate.e1rm, squat.bestE1rm.e1rm);
      assert.equal(await reads.session('ses_fixture_missing'), null);
      assert.equal(await reads.routine('rt_fixture_missing'), null);
      assert.equal(await reads.proposal('prop_fixture_missing'), null);
      console.log(JSON.stringify({ gate: 'Domain reads over backend sync rows', sessions: 3, sets: 9, rows: wireRows.length }));
    } finally { persisted.close(); }

    {
      const vite = start(process.execPath, [join(root, 'web/node_modules/vite/bin/vite.js'), join(root, 'web'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webPort, { VITE_API_BASE_URL: base });
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

      await goto('#/gym/log');
      await page.getByRole('button', { name: 'Weigh in', exact: true }).first().click();
      await page.getByRole('textbox', { name: 'Bodyweight in kg' }).fill('81,234');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitUntil(async () => (await request('/v1/gym/bodyweight')).latest?.weightKg === 81.23,
        { processes: [vite, backend], label: 'bodyweight domain convergence' }); e2e++;

      await goto('#/gym/bodyweight');
      await page.getByRole('button', { name: /^81\.23 kg ·/ }).click();
      await page.getByRole('button', { name: 'Delete weigh-in', exact: true }).click();
      await page.getByRole('button', { name: /^81\.23 kg ·/ }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByRole('button', { name: /^81\.23 kg ·/ }).waitFor(); e2e++;

      await page.goto(`${origin}/app/settings`);
      await page.getByRole('group', { name: 'Weight units' }).getByRole('button', { name: 'lb', exact: true }).click();
      await waitUntil(async () => (await request('/v1/gym/preferences')).units === 'lb',
        { processes: [vite, backend], label: 'preference domain convergence' });
      assert.deepEqual(await request('/v1/gym/preferences'), { units: 'lb', restSeconds: 180, restSound: false, confirmHaptic: false, confirmSound: true }); e2e++;

      await agent('gym_propose_routine_change', { id: 'prop_fixture_dismiss', routineId: 'rt_fixture_main', name: 'Fixture Next',
        entries: [{ exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 85 }] }] });
      await goto('#/gym/proposals/prop_fixture_dismiss');
      await page.getByRole('button', { name: 'Turn this down', exact: true }).click();
      await waitUntil(async () => (await request('/v1/gym/proposals/prop_fixture_dismiss')).state === 'dismissed',
        { processes: [vite, backend], label: 'proposal dismissal convergence' });
      await page.getByRole('status').filter({ hasText: 'Turned down · nothing changed.' }).waitFor(); e2e++;

      await agent('gym_create_routine', { id: 'rt_fixture_remove', name: 'Fixture Removal', position: 2,
        entries: [{ exerciseId: 'bench-press' }] });
      await agent('gym_propose_routine_removal', { id: 'prop_fixture_remove', routineId: 'rt_fixture_remove' });
      await goto('#/gym/proposals/prop_fixture_remove');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await waitUntil(async () => await request('/v1/gym/routines/rt_fixture_remove') === null,
        { processes: [vite, backend], label: 'proposal removal convergence' });
      await page.getByRole('status').filter({ hasText: 'Applied · Fixture Removal · routine removed' }).waitFor();
      await waitUntil(() => page.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        return !syncSession.engine.device.activeReplica.deviceRows('gym')['rack:removalReceipts'];
      }), { processes: [vite, backend], label: 'visible removal receipt acknowledgment' }); e2e++;
      assert.ok(commandsSeen.includes('gym.applyProposal') && commandsSeen.includes('gym.dismissProposal'));

      await waitUntil(() => sql(`SELECT count(DISTINCT props->>'operation') FROM events WHERE user_id='${account}' AND name='gym_action' AND props->>'operation' IN ('routine-save','session-import','bodyweight-save','preferences-save','proposal-apply','proposal-dismiss') AND props->>'outcome'='saved-local';`) === '6',
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
      console.log(JSON.stringify({ gate: 'Playwright local stack', passed: e2e, total: 11, pending: 0, persistedGymOperations: 6, syncWriteLog: true, ports: [backendPort, webPort] }));
    }
    completed = true;
  } catch (error) {
    if (created) {
      try { console.error(JSON.stringify({ gate: 'gym product telemetry', operations: JSON.parse(sql(
        `SELECT coalesce(json_agg(seen), '[]') FROM (SELECT props->>'operation' AS operation, props->>'outcome' AS outcome, count(*) FROM events WHERE user_id='${account}' AND name='gym_action' GROUP BY 1,2 ORDER BY 1,2) AS seen;`)) })); }
      catch { console.error('Gym product telemetry could not be read.'); }
    }
    if (lastPage && !lastPage.isClosed()) {
      await lastPage.screenshot({ path: join(temporary, 'failure.png'), fullPage: true }).catch(() => {});
      const sync = await lastPage.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        const engine = syncSession.engine;
        return { ready: syncSession.getSnapshot().ready, error: syncSession.getSnapshot().error,
          replicaState: engine?.device.activeReplica.meta.state, online: engine?.online, leader: engine?.leader };
      }).catch(() => null);
      console.error(JSON.stringify({ browserErrors: pageErrors, url: lastPage.url(), sync }));
      console.error(JSON.stringify({ gate: 'Playwright local stack', passed: e2e, total: 11, status: 'failed' }));
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
