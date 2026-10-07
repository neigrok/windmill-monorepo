import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve('..');
const binaries = resolve(process.argv[2] ?? '../backend/build');
const database = `${process.env.WM_E2E_DB_PREFIX ?? 'wm_web_'}journal_${process.pid}`;
const backendPort = Number(process.env.WM_E2E_PORT ?? 8094);
const webPort = Number(process.env.WM_E2E_WEB_PORT ?? 5181);
const host = process.env.PGHOST ?? (process.platform === 'darwin' ? '/tmp' : '127.0.0.1');
const url = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
const origin = `http://127.0.0.1:${webPort}`;
const backend = `http://127.0.0.1:${backendPort}`;
const scratch = mkdtempSync(resolve(tmpdir(), 'wm-web-journal-'));
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
async function cookie(context, value = token) {
  await context.addCookies([{ name: 'wm_session', value, url: backend, httpOnly: true, sameSite: 'Lax' }]);
}
async function ready(page) {
  await page.evaluate(async () => {
    window.journal = { ...(await import('/src/platform/sync/session.js')), ...(await import('/src/products/journal/pages.js')) };
  });
  try { await page.waitForFunction(() => window.journal.syncSession.getSnapshot().ready); }
  catch (error) {
    console.error(await page.evaluate(() => ({ session: { ready: journal.syncSession.snapshot.ready, error: journal.syncSession.snapshot.error },
      document: document.readyState, online: navigator.onLine, engineClosed: journal.syncSession.engine?.closed })));
    throw error;
  }
  await page.getByRole('textbox', { name: 'Write today' }).waitFor();
}
async function saved(page, text) {
  await page.waitForFunction(({ text, today }) => {
    const engine = journal.syncSession.engine;
    return engine && journal.pagesOf(engine).find((page) => page.day === today)?.body === text;
  }, { text, today });
}
async function converged(page, text) {
  try { await page.waitForFunction(({ text, today }) => {
    const engine = journal.syncSession.engine;
    return engine?.device.activeReplica.confirmedRow('self/journal', 'page', today)?.x.body.text === text
      && engine.device.activeReplica.entries('self/journal').length === 0;
  }, { text, today }); } catch (error) {
    console.error(await page.evaluate(() => { const e = journal.syncSession.engine; return { session: journal.syncSession.snapshot.signedIn, state: e.getSnapshot(), leader: e.leader, closed: e.closed, started: e.started, base: e.transport.base, entries: e.device.activeReplica.outbox.map((entry) => ({ state: entry.state, command: entry.intent.cmd?.name })) }; }));
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
async function pendingAccount(context, label) {
  const id = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const email = `journal-${label}@example.com`;
  sql(`insert into users(id,email,name) values('${id}','${email}','Journal ${label}');
    insert into sessions(token_hash,user_id,expires_ms) values('${hash(secret)}','${id}',99999999999999);`);
  await cookie(context, secret);
  const page = await context.newPage();
  await page.goto(`${origin}/app/journal`); await ready(page);
  await page.getByRole('textbox', { name: 'Write today' }).fill(`confirmed ${label}`);
  await converged(page, `confirmed ${label}`);
  await page.reload(); await ready(page);
  await converged(page, `confirmed ${label}`);
  const epoch = await page.evaluate(() => journal.syncSession.engine.device.activeReplica.meta.serverEpoch);
  await page.route('**/v1/sync/push', (route) => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ epoch, retryAfterMs: 60000 }) }));
  await page.getByRole('textbox', { name: 'Write today' }).fill(`pending ${label}`);
  await saved(page, `pending ${label}`);
  await page.waitForFunction(() => journal.syncSession.engine.device.activeReplica.entries('self/journal').length === 1);
  await page.getByRole('button', { name: `Account — Journal ${label}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Sessions & devices', exact: true }).waitFor();
  return { page, id, email, secret };
}
try {
  // Own the chosen ports only when they are free; never stop somebody else's stack.
  for (const port of [backendPort, webPort]) {
    try { execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']); throw new Error(`port ${port} is occupied`); }
    catch (error) { if (error.status !== 1) throw error; }
  }
  execFileSync('createdb', ['-h', host, database]); created = true;
  execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(repo, 'backend/db/schema.sql')], { stdio: ['ignore', 'pipe', 'pipe'] });
  sql(`insert into users(id,email,name) values('${account}','web-journal@example.com','Web Journal'); insert into sessions(token_hash,user_id,expires_ms) values('${hash(token)}','${account}',99999999999999);`);
  server = launch(resolve(binaries, 'windmill_server'), [], { cwd: resolve(repo, 'backend'), env: { ...process.env, DATABASE_URL: url,
    PORT: String(backendPort), WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin,
    RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '', SENTRY_DSN: '', AMPLITUDE_API_KEY: '' } });
  vite = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    { cwd: process.cwd(), env: { ...process.env, VITE_API_BASE_URL: backend, WINDMILL_ALLOWED_ORIGINS: origin } });
  await Promise.all([waitForServer(`${backend}/v1/me`, server), waitForServer(origin, vite)]);
  browser = await chromium.launch({ channel: 'chromium', headless: true });
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
      await page.waitForFunction(() => journal.syncSession.getSnapshot().signedIn);
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
  for (const choice of ['Keep', 'Discard']) await check(`revoke this session → Cancel → ${choice} → completed sign-out`, async () => {
    const context = await browser.newContext();
    let release, page;
    try {
      const fixture = await pendingAccount(context, choice.toLowerCase());
      page = fixture.page;
      const { id } = fixture;
      const settings = page.url();
      const sessions = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sessions & devices', exact: true }) });
      const revoke = sessions.getByRole('button', { name: /^Revoke / });
      await revoke.click();
      const question = page.getByRole('dialog');
      await question.waitFor();
      assert.equal(await question.getByText('Sign out?', { exact: true }).count(), 1);
      assert.equal(page.url(), settings, 'the question must not navigate');
      assert.equal(await question.getByText('1 change hasn’t been confirmed', { exact: false }).count(), 1);
      await question.getByRole('button', { name: 'Cancel', exact: true }).click();
      await question.waitFor({ state: 'hidden' });
      assert.equal(page.url(), settings, 'Cancel stays in settings');
      assert.equal((await page.request.get(`${backend}/v1/me`)).status(), 200, 'Cancel keeps this session');
      assert.equal(await page.evaluate(() => journal.syncSession.getSnapshot().signedIn), true);
      const finishing = new Promise((resolve) => { release = resolve; });
      await page.route('**/v1/auth/logout', async (route) => { await finishing; await route.continue(); });
      const logout = page.waitForRequest((request) => request.url() === `${backend}/v1/auth/logout`);
      logout.catch(() => {});
      await revoke.click(); await question.waitFor();
      const beacon = page.waitForResponse((response) => response.url() === `${backend}/v1/events`
        && response.request().postDataJSON()?.events?.some((event) => event.name === 'sync_signout' && event.props?.outcome === 'ok'));
      beacon.catch(() => {});
      await question.getByRole('button', { name: choice, exact: true }).click();
      await logout;
      assert.equal(page.url(), settings, 'navigation waits for credential cleanup');
      assert.equal(await page.evaluate(() => journal.syncSession.getSnapshot().signedIn), true);
      release();
      await page.waitForFunction(() => !journal.syncSession.getSnapshot().signedIn);
      await page.waitForURL((url) => url.pathname === '/');
      const retained = await page.evaluate(async (id) => {
        const { device } = await journal.syncSession.engine.store.read();
        return { active: device.activeReplica.meta.state, accounts: device.replicas.filter((replica) => replica.meta.account === id)
          .map((replica) => ({ state: replica.meta.state, entries: replica.entries('self/journal').length })) };
      }, id);
      assert.deepEqual(retained, { active: 'anon', accounts: choice === 'Keep' ? [{ state: 'dormant', entries: 1 }] : [] });
      assert.equal((await page.request.get(`${backend}/v1/me`)).status(), 401);
      assert.ok((await beacon).ok(), 'completed sign-out beacon was accepted');
    } finally {
      release?.();
      try { await page?.unrouteAll({ behavior: 'wait' }); } finally { await context.close(); }
    }
  });
  await check('two tabs: account A closure refuses B’s replacement cookie and preserves both accounts', async () => {
    const context = await browser.newContext();
    try {
      const { page, id, email, secret } = await pendingAccount(context, 'cookie-race');
      const settings = page.url();
      const successor = randomUUID();
      const link = randomBytes(24).toString('hex');
      const nextEmail = 'journal-cookie-successor@example.com';
      const now = Date.now();
      sql(`insert into users(id,email,name) values('${successor}','${nextEmail}','Successor');
        insert into magic_links(token_hash,email,created_ms,expires_ms)
          values('${hash(link)}','${nextEmail}',${now},${now + 900000});`);
      const other = await context.newPage();
      await other.goto(`${origin}/privacy.html`);
      let sessionReads = 0;
      await page.route('**/v1/sessions', async (route) => {
        const response = await route.fetch();
        if (++sessionReads === 2) {
          const signedIn = await other.evaluate(async (token) => {
            const { verifyToken } = await import('/src/shell/auth/AuthClient.js');
            return verifyToken(token);
          }, link);
          assert.equal(signedIn.user.id, successor, 'the second tab signs in as B using the real server');
        }
        await route.fulfill({ response });
      });
      const deletion = page.waitForResponse((response) => response.url() === `${backend}/v1/me`
        && response.request().method() === 'DELETE');
      deletion.catch(() => {});
      const closing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Close your account', exact: true }) });
      await closing.getByRole('button', { name: 'Close my account', exact: true }).click();
      await closing.getByRole('textbox').fill(email);
      await closing.getByRole('button', { name: 'Close my account', exact: true }).click();
      const response = await deletion;
      const intended = await fetch(`${backend}/v1/me`, { headers: { Authorization: `Bearer ${secret}` } });
      const successorMe = await other.evaluate(async (backend) => {
        const response = await fetch(`${backend}/v1/me`, { credentials: 'include' });
        return { status: response.status, body: await response.json() };
      }, backend);
      const closed = JSON.parse(execFileSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
        `select json_build_object('A', (select deleted_at is not null from users where id='${id}'),
          'B', (select deleted_at is not null from users where id='${successor}'))`], { encoding: 'utf8' }));
      console.log(`Account closure race: ${JSON.stringify({ tabs: context.pages().length, sessionReads,
        status: response.status(), credentialStatus: { A: intended.status, B: successorMe.status }, closed })}`);
      assert.equal(sessionReads, 2);
      assert.equal(response.status(), 409);
      assert.deepEqual(await response.json(), { error: 'the signed-in account changed; no account was closed', code: 'account-mismatch' });
      assert.deepEqual(response.request().postDataJSON(), { account: id });
      assert.equal(intended.status, 200);
      assert.equal((await intended.json()).user.id, id);
      assert.equal(successorMe.status, 200);
      assert.equal(successorMe.body.user.id, successor);
      assert.deepEqual(closed, { A: false, B: false });
      await closing.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
      assert.equal(page.url(), settings);
      assert.deepEqual(await page.evaluate(() => {
        const engine = journal.syncSession.engine;
        return { account: engine.device.activeReplica.meta.account, entries: engine.device.activeReplica.entries('self/journal').length,
          closing: engine.device.meta.closingAccount, signingOut: engine.signingOut };
      }), { account: id, entries: 1, closing: undefined, signingOut: false });
    } finally { await context.close(); }
  });
  await check('close account → discard device data without a question → completed sign-out', async () => {
    const context = await browser.newContext();
    let release, page;
    try {
      const fixture = await pendingAccount(context, 'closing');
      page = fixture.page;
      const { id, email } = fixture;
      const settings = page.url();
      const finishing = new Promise((resolve) => { release = resolve; });
      await page.route('**/v1/me', async (route) => {
        if (route.request().method() === 'DELETE') {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          await finishing;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      const deletion = page.waitForRequest((request) => request.url() === `${backend}/v1/me` && request.method() === 'DELETE');
      deletion.catch(() => {});
      const closing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Close your account', exact: true }) });
      await closing.getByRole('button', { name: 'Close my account', exact: true }).click();
      await closing.getByRole('textbox').fill(email);
      const beacon = page.waitForResponse((response) => response.url() === `${backend}/v1/events`
        && response.request().postDataJSON()?.events?.some((event) => event.name === 'sync_signout' && event.props?.outcome === 'ok'));
      beacon.catch(() => {});
      await closing.getByRole('button', { name: 'Close my account', exact: true }).click();
      await deletion;
      assert.equal(page.url(), settings, 'closing waits for local sign-out to finish');
      assert.equal(await page.getByRole('dialog').count(), 0, 'account closure needs no Keep/Discard question');
      assert.equal(await page.evaluate(() => journal.syncSession.getSnapshot().signedIn), true);
      release();
      await page.waitForFunction(() => !journal.syncSession.getSnapshot().signedIn);
      await page.waitForURL((url) => url.pathname === '/');
      assert.equal(await page.evaluate(async (id) => (await journal.syncSession.engine.store.read()).device.replicas
        .filter((replica) => replica.meta.account === id).length, id), 0, 'the closed account has no device replica');
      assert.equal((await page.request.get(`${backend}/v1/me`)).status(), 401);
      assert.ok((await beacon).ok(), 'completed account closure beacon was accepted');
    } finally {
      release?.();
      try { await page?.unrouteAll({ behavior: 'wait' }); } finally { await context.close(); }
    }
  });
  assert.ok(Number(sql("select count(*) from events where name in ('sync_commit','sync_signin','sync_signout','sync_writer')").toString().match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0) > 0, 'sync beacons reached the local intake');
  assert.ok(Number(sql("select count(*) from events where name = 'sync_signout' and props->>'outcome' = 'ok'").toString().match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0) >= 3,
    'all three completed sign-outs reached the local beacon intake');
  console.log(`Journal local-stack e2e: ${passed}/8 passed, 0 skipped; local beacon intake verified`);
} catch (error) {
  console.error(error);
  console.error(`Stack diagnostics: ${logPath}`);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  try { await browser?.close(); } catch (error) { cleanup.push(error); }
  if (vite) { stopPort(webPort); vite.kill('SIGTERM'); }
  if (server) { stopPort(backendPort); server.kill('SIGTERM'); }
  const exits = await Promise.allSettled([server, vite].filter(Boolean).map((child) => child.exitCode !== null || child.signalCode !== null ? null
    : Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('stack shutdown timed out')), 5000).unref())])));
  for (const result of exits) if (result.status === 'rejected') cleanup.push(result.reason);
  try { if (created) execFileSync('dropdb', ['-h', host, database]); } catch (error) { cleanup.push(error); }
  log.end();
  for (const error of cleanup) { console.error(error); process.exitCode = 1; }
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
}
