import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve('..');
const binaries = resolve(process.argv[2] ?? '../backend/build');
const database = `wm_web_b2_${process.pid}`;
const host = process.env.PGHOST ?? (process.platform === 'darwin' ? '/tmp' : '127.0.0.1');
const url = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
const origin = 'http://127.0.0.1:5181';
const backend = 'http://127.0.0.1:8094';
const scratch = mkdtempSync(resolve(tmpdir(), 'wm-web-b2-'));
const logPath = resolve(scratch, 'stack.log');
const log = createWriteStream(logPath);
const account = randomUUID();
const token = randomBytes(24).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const today = new Date().toLocaleDateString('en-CA');
let browser, server, vite, created = false, passed = 0;
const sql = (statement) => execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], { stdio: ['ignore', 'pipe', 'pipe'] });
const launch = (command, args, options) => {
  const child = spawn(command, args, options);
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  return child;
};
const stopPort = (port) => {
  let pids;
  try { pids = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean); } catch { return; }
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
};
async function waitForServer(address, child) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error('stack exited before readiness');
    try { await fetch(address, { signal: AbortSignal.timeout(1000) }); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('stack readiness timed out');
}
async function check(name, run) {
  await run(); passed++; console.log(`PASS ${name}`);
}
async function cookie(context) {
  await context.addCookies([{ name: 'wm_session', value: token, url: backend, httpOnly: true, sameSite: 'Lax' }]);
}
async function ready(page) {
  await page.evaluate(async () => {
    window.b2 = { ...(await import('/src/platform/sync/session.js')), ...(await import('/src/products/journal/pages.js')) };
  });
  try { await page.waitForFunction(() => window.b2.syncSession.getSnapshot().ready); }
  catch (error) {
    console.error(await page.evaluate(() => ({ session: { ready: b2.syncSession.snapshot.ready, error: b2.syncSession.snapshot.error },
      document: document.readyState, online: navigator.onLine, engineClosed: b2.syncSession.engine?.closed })));
    throw error;
  }
  await page.getByRole('textbox', { name: 'Write today' }).waitFor();
}
async function saved(page, text) {
  await page.waitForFunction(({ text, today }) => {
    const engine = b2.syncSession.engine;
    return engine && b2.pagesOf(engine).find((page) => page.day === today)?.body === text;
  }, { text, today });
}
async function converged(page, text) {
  try { await page.waitForFunction(({ text, today }) => {
    const engine = b2.syncSession.engine;
    return engine?.device.activeReplica.confirmedRow('self/journal', 'page', today)?.x.body.text === text
      && engine.device.activeReplica.entries('self/journal').length === 0;
  }, { text, today }); } catch (error) {
    console.error(await page.evaluate(() => { const e = b2.syncSession.engine; return { session: b2.syncSession.snapshot.signedIn, state: e.getSnapshot(), leader: e.leader, closed: e.closed, started: e.started, base: e.transport.base, entries: e.device.activeReplica.outbox.map((entry) => ({ state: entry.state, command: entry.intent.cmd?.name })) }; }));
    throw error;
  }
  const result = await page.request.get(`${backend}/v1/journal/page/${today}`);
  assert.equal(result.status(), 200);
  assert.equal((await result.json()).body, text);
}
async function offlineReady(page) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await page.evaluate(async () => {
      const cache = await caches.open('windmill-assets-v2');
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name).filter((raw) => {
        const url = new URL(raw);
        return url.origin === location.origin && /^\/(assets|src|@|node_modules)/.test(url.pathname);
      });
      const ready = await Promise.all(urls.map(async (url) => !!(await cache.match(url, { ignoreVary: true }))));
      return !!navigator.serviceWorker.controller && ready.every(Boolean)
        && !!(await cache.match(location.origin + '/src/products/gym/GymApp.jsx', { ignoreVary: true }))
        && !!(await (await (await caches.open('windmill-shell-v2')).match('/offline-generation'))?.json());
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(await page.evaluate(async () => ({ controller: !!navigator.serviceWorker.controller, registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => ({ active: r.active?.state, installing: r.installing?.state })), caches: await caches.keys(), assets: (await (await caches.open('windmill-assets-v2')).keys()).map((r) => new URL(r.url).pathname), resources: performance.getEntriesByType('resource').filter((e) => e.name.includes('GymApp')).map((e) => e.name) })));
  throw new Error('offline shell warming timed out');
}
try {
  // Own the chosen ports only when they are free; never stop somebody else's stack.
  for (const port of [8094, 5181]) {
    try { execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']); throw new Error(`port ${port} is occupied`); }
    catch (error) { if (error.status !== 1) throw error; }
  }
  execFileSync('createdb', ['-h', host, database]); created = true;
  execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(repo, 'backend/db/schema.sql'), '-f', resolve(repo, 'backend/db/gym_sync.sql'), '-f', resolve(repo, 'backend/db/journal_sync.sql')], { stdio: ['ignore', 'pipe', 'pipe'] });
  sql(`insert into users(id,email,name) values('${account}','web-b2@example.com','Web B2'); insert into sessions(token_hash,user_id,expires_ms) values('${hash(token)}','${account}',99999999999999);`);
  for (const binary of ['windmill_gym_backfill', 'windmill_journal_backfill']) execFileSync(resolve(binaries, binary), [], { env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(repo, 'backend/db/gym_sync_v5.sql')], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const mode of ['--upgrade-v5', '--audit-v5']) execFileSync(resolve(binaries, 'windmill_gym_backfill'), [mode], { env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
  server = launch(resolve(binaries, 'windmill_server'), [], { cwd: resolve(repo, 'backend'), env: { ...process.env, DATABASE_URL: url,
    PORT: '8094', WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin,
    SYNC_ENABLED: '1', GYM_ENGINE_WRITES: '1', JOURNAL_ENGINE_WRITES: '1',
    RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '', SENTRY_DSN: '', AMPLITUDE_API_KEY: '' } });
  vite = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5181', '--strictPort'],
    { cwd: process.cwd(), env: { ...process.env, VITE_API_BASE_URL: backend, WINDMILL_ALLOWED_ORIGINS: origin } });
  await Promise.all([waitForServer(`${backend}/v1/me`, server), waitForServer(origin, vite)]);
  browser = await chromium.launch({ headless: true });
  browser.on('disconnected', () => { if (!passed) console.error('Browser disconnected before acceptance completed'); });
  await check('journal write → offline reload → write → reconnect → convergence', async () => {
    const context = await browser.newContext(); await cookie(context);
    try {
      const page = await context.newPage();
      page.on('pageerror', (error) => console.error('Browser script error:', error.name, error.message));
      page.on('requestfailed', (request) => {
        if (request.resourceType() === 'script') console.error('Failed script:', new URL(request.url()).pathname);
      });
      await page.goto(`${origin}/app/journal`); await ready(page);
      await page.getByRole('textbox', { name: 'Write today' }).fill('online page'); await converged(page, 'online page');
      await offlineReady(page);
      await context.setOffline(true); await page.reload(); await ready(page);
      assert.equal(await page.getByRole('textbox', { name: 'Write today' }).inputValue(), 'online page');
      await page.getByRole('textbox', { name: 'Write today' }).fill('offline page'); await saved(page, 'offline page');
      assert.ok(await page.getByRole('status').filter({ hasText: 'Offline' }).count());
      await page.goto(`${origin}/app/gym`); await page.getByRole('button', { name: 'Account', exact: false }).waitFor();
      assert.equal(await page.getByText('Sign in to open Gym', { exact: false }).count(), 0);
      await page.goto(`${origin}/app/journal`); await ready(page);
      assert.equal(await page.getByRole('textbox', { name: 'Write today' }).inputValue(), 'offline page');
      await context.setOffline(false); await converged(page, 'offline page');
    } finally { await context.close(); }
  });
  for (const choice of ['Add', 'Discard']) await check(`signed-out draft → occupied account → ${choice}`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(`${origin}/app/journal`); await ready(page);
      await page.getByRole('textbox', { name: 'Write today' }).fill(`anonymous ${choice}`); await saved(page, `anonymous ${choice}`);
      await cookie(context); await page.reload(); await ready(page);
      await page.getByText('Add to your account?', { exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').getByText('1 page from before you signed in', { exact: false }).count(), 1);
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
      await page.getByRole('dialog').getByRole('button', { name: choice, exact: true }).click();
      if (choice === 'Discard') {
        await page.getByText('Discard 1 page?', { exact: true }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByText('Add to your account?', { exact: true }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
      }
      await page.waitForFunction(() => b2.syncSession.getSnapshot().signedIn);
      const expected = 'offline page\n\nanonymous Add';
      await converged(page, expected);
    } finally { await context.close(); }
  });
  await check('pre-engine cache and owed write migrate once and converge', async () => {
    const context = await browser.newContext(); await cookie(context);
    try {
      await context.addInitScript(({ account, today }) => {
        if (localStorage.getItem('fixture-migrated')) return;
        localStorage.setItem('fixture-migrated', 'yes');
        localStorage.setItem(`wm.journal.v2.pages.u.${account}`, JSON.stringify({
          [today]: { page: { day: today, body: 'legacy owed page', mood: 0, energy: null, source: 'typed', stamp: '9999999999999:0:legacy' }, needsPush: true, read: true },
          '2026-01-01': { page: { day: '2026-01-01', body: 'cached page', mood: 1, energy: null, source: 'typed', stamp: '1:0:legacy' }, needsPush: false, read: true },
        }));
      }, { account, today });
      const page = await context.newPage(); await page.goto(`${origin}/app/journal`); await ready(page);
      await converged(page, 'legacy owed page');
      assert.equal(await page.evaluate((account) => localStorage.getItem(`wm.journal.v2.pages.u.${account}`), account), null);
      await page.reload(); await ready(page); await converged(page, 'legacy owed page');
    } finally { await context.close(); }
  });
  assert.ok(Number(sql("select count(*) from events where name in ('sync_commit','sync_signin','sync_signout','sync_writer')").toString().match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0) > 0, 'sync beacons reached the local intake');
  console.log(`Journal local-stack e2e: ${passed}/4 passed, 0 skipped; local beacon intake verified`);
} catch (error) {
  console.error(error);
  console.error(`Stack diagnostics: ${logPath}`);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  try { await browser?.close(); } catch (error) { cleanup.push(error); }
  if (vite) { stopPort(5181); vite.kill('SIGTERM'); }
  if (server) { stopPort(8094); server.kill('SIGTERM'); }
  const exits = await Promise.allSettled([server, vite].filter(Boolean).map((child) => child.exitCode !== null || child.signalCode !== null ? null
    : Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('stack shutdown timed out')), 5000).unref())])));
  for (const result of exits) if (result.status === 'rejected') cleanup.push(result.reason);
  try { if (created) execFileSync('dropdb', ['-h', host, database]); } catch (error) { cleanup.push(error); }
  log.end();
  for (const error of cleanup) { console.error(error); process.exitCode = 1; }
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
}
