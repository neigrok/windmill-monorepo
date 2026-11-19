// The roadmap room's writes end to end on a local stack, once with the server's roadmap engine and the web's switch on
// (the room on the device's copy) and once with both off (today's room). One owner on several devices, each a browser
// context with its own store: Undo and Redo, edits made offline syncing once the connection returns, a change made
// without knowing of another device's delete (INV-1), the line that tells the person once of a link of theirs another
// device's delete changed (§6), and a roadmap's deletion from the switcher. Each run has its own
// database, server and built app on the given ports, and stops and drops them. It prints no id and no roadmap text.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repo = resolve('..');
const binaries = resolve(process.argv[2] ?? '../backend/build');
const backendPort = Number(process.env.WM_E2E_PORT ?? 8095);
const webPort = Number(process.env.WM_E2E_WEB_PORT ?? 5183);
const prefix = process.env.WM_E2E_DB_PREFIX ?? 'wm_web_';
const host = process.env.PGHOST ?? (process.platform === 'darwin' ? '/tmp' : '127.0.0.1');
const origin = `http://127.0.0.1:${webPort}`;
const backend = `http://127.0.0.1:${backendPort}`;
const scratch = mkdtempSync(resolve(tmpdir(), 'wm-web-roadmap-replica-'));
const logPath = resolve(scratch, 'stack.log');
const log = createWriteStream(logPath);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const settle = (ms) => new Promise((done) => setTimeout(done, ms));
const RUN_MS = 20 * 60_000;
setTimeout(() => {
  console.error(`The run passed its ${RUN_MS / 60_000}-minute deadline. Stack diagnostics: ${logPath}`);
  process.exit(1);
}, RUN_MS);

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
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error('stack exited before readiness');
    try { await fetch(address, { signal: AbortSignal.timeout(1000) }); return; } catch {}
    await settle(100);
  }
  throw new Error('stack readiness timed out');
}
async function stopped(children) {
  return Promise.allSettled(children.filter(Boolean).map((child) => child.exitCode !== null || child.signalCode !== null ? null
    : Promise.race([new Promise((done) => child.once('exit', done)), new Promise((_, fail) => setTimeout(() => fail(new Error('stack shutdown timed out')), 5000).unref())])));
}

// Two roadmaps of the owner's: three steps in a line, and one of a single step. With the engine on they are planted
// through roadmap's domain actions on a device of the owner's; with it off, through today's routes.
async function seed(mode, secret, account) {
  const planted = { sail: 'Learn to sail', knot: 'Learn to knot' };
  if (mode === 'off') {
    const plant = async (body) => {
      const response = await fetch(`${backend}/v1/trees`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      assert.ok(response.ok, 'the roadmap was planted');
      return (await response.json()).treeId;
    };
    const sail = await plant({ title: planted.sail, nodes: [
      { id: 'course', label: 'Choose a course', color: 'terracotta', prerequisites: [] },
      { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['course'] },
      { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'] },
    ] });
    await settle(1100);
    await plant({ title: planted.knot, nodes: [{ id: 'bowline', label: 'Tie a bowline', color: 'terracotta', prerequisites: [] }] });
    return sail;
  }
  const source = (path) => import(pathToFileURL(resolve(path)).href);
  const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
  const { BrowserSyncEngine } = await source('src/platform/sync/engine.js');
  const { registry } = await source('src/platform/sync/schema.js');
  const { HttpTransport } = await source('src/platform/sync/transport.js');
  const { FakeLocks } = await source('test/platform/sync/fakes.js');
  const { ActionRunner, EngineReplica } = await source('src/platform/domain-kit/runner.js');
  const { FixedZone } = await source('src/platform/domain-kit/time.js');
  const { CreateRoadmap } = await source('src/products/roadmap/domain/roadmaps.js');
  const transport = new HttpTransport({ schema: registry.version, base: backend, reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: 'seed' }),
    scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
    socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
    fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) }) });
  const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name: 'seed', registry, transport,
    navigator: { onLine: true, locks: new FakeLocks() }, document: null, window: null,
    telemetry: { event() {}, failure(operation) { throw new Error(`the seed's engine failed: ${operation}`); } } });
  try {
    await engine.signIn(account);
    const runner = new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0));
    const plant = async (act) => {
      const outcome = await runner.runAct(act);
      assert.equal(outcome.kind, 'committed', 'the roadmap was planted');
      return outcome.result.tree;
    };
    const sail = await plant(new CreateRoadmap(planted.sail, { steps: [
      { key: 'course', label: 'Choose a course' }, { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock' },
    ], links: [['course', 'wind'], ['wind', 'dock']] }));
    await plant(new CreateRoadmap(planted.knot, { steps: [{ key: 'bowline', label: 'Tie a bowline' }], links: [] }));
    await engine.start();
    for (let turn = 0; turn < 60 && engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'); turn++) {
      await settle(200);
      engine.kick();
      await engine.send();
    }
    assert.ok(!engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'), 'the seed reached the server');
    return sail;
  } finally {
    engine.close();
  }
}

// The owner's room as one device shows it.
class Device {
  static async open(browser, secret) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'wm_session', value: secret, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const device = new Device(context, page);
    page.on('pageerror', () => device.errors.push('pageerror'));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) device.errors.push('console'); });
    return device;
  }

  constructor(context, page) {
    this.context = context;
    this.page = page;
    this.errors = [];
  }

  card(label) { return this.page.locator('.st-board-card-title', { hasText: label }); }

  async board(address) {
    await this.page.goto(`${origin}/${address}`);
    await this.page.locator('.st-roadmap-progress').waitFor();
    const toggle = this.page.getByRole('button', { name: 'Board', exact: true });
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await this.page.locator('[data-column]').first().waitFor();
  }

  columnOf(label) {
    return this.page.evaluate((label) => [...document.querySelectorAll('[data-column]')]
      .find((column) => [...column.querySelectorAll('.st-board-card-title')].some((title) => title.textContent === label))?.dataset.column ?? null, label);
  }

  async keys(combination) {
    await this.page.evaluate(() => document.activeElement?.blur());
    await this.page.keyboard.press(combination);
  }

  async create(label, after = null) {
    await this.page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
    const composer = this.page.getByRole('dialog', { name: 'New step', exact: true });
    await composer.locator('input').first().fill(label);
    if (after) {
      await composer.locator('.st-board-draft-needs').click();
      await this.page.getByRole('checkbox', { name: after }).click();
      await this.page.getByRole('button', { name: 'Apply', exact: true }).click();
    }
    await composer.getByRole('button', { name: 'Create step', exact: true }).click();
    await this.card(label).waitFor();
  }

  // The landing lines under the Board's cards, each with the card it stands under.
  landed() {
    return this.page.evaluate(() => [...document.querySelectorAll('.st-board-landed')]
      .map((line) => [line.previousElementSibling.querySelector('.st-board-card-title').textContent, line.textContent]));
  }

  async openStep(label) {
    await this.card(label).click();
    const article = this.page.getByRole('article', { name: label, exact: true });
    await article.waitFor();
    return article;
  }

  async closeStep() {
    await this.page.locator('.st-board-step-layer article').focus();
    await this.page.keyboard.press('Escape');
    await this.page.locator('.st-board-step-layer article').waitFor({ state: 'detached' });
  }

  async deleteStep(label) {
    const step = await this.openStep(label);
    await step.getByRole('button', { name: 'More', exact: true }).click();
    await this.page.getByRole('menuitem', { name: 'Delete step' }).click();
    await this.page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await this.page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15_000 });
  }

  async deleteFromSwitcher(title) {
    await this.page.locator('.st-roadmap-switcher [aria-haspopup="menu"]').click();
    await this.page.getByRole('button', { name: `Delete ${title}`, exact: true }).focus();
    await this.page.keyboard.press('Enter');
    await this.page.locator('[data-switcher-action="confirm"]').focus();
    await this.page.keyboard.press('Enter');
  }

  // The roadmap read again until `seen` holds or the bound passes.
  async until(address, seen, bound = 45_000) {
    const end = Date.now() + bound;
    for (;;) {
      await this.board(address);
      if (await seen()) return true;
      if (Date.now() > end) return false;
      await settle(2000);
    }
  }
}

async function scenarios(mode, browser, secret, account, check) {
  const sail = await seed(mode, secret, account);
  const address = `#/app/${sail}`;
  const a = await Device.open(browser, secret);
  const devices = [a];
  try {
    await a.board(address);
    await check('a new step is taken back by Undo and brought back by Redo', async () => {
      await a.create('Tie a reef knot');
      await a.keys('ControlOrMeta+z');
      await a.card('Tie a reef knot').waitFor({ state: 'detached' });
      await a.keys('ControlOrMeta+Shift+z');
      await a.card('Tie a reef knot').waitFor();
    });

    const b = await Device.open(browser, secret);
    devices.push(b);
    await check('edits made with no connection stand on the device, and another device shows them once it returns', async () => {
      await a.context.setOffline(true);
      await settle(500);
      const course = await a.openStep('Choose a course');
      await course.getByRole('button', { name: 'Complete', exact: true }).click();
      await a.closeStep();
      await a.create('Reef the sail');
      assert.ok(await a.page.getByText('Offline', { exact: false }).count() > 0, 'the status line says Offline');
      await a.context.setOffline(false);
      assert.ok(await b.until(address, async () => await b.card('Reef the sail').count() === 1 && await b.columnOf('Choose a course') === 'done'
        && await b.card('Tie a reef knot').count() === 1), 'another device shows the new steps and the mark');
    });

    const c = await Device.open(browser, secret);
    devices.push(c);
    await check(mode === 'on' ? 'INV-1: a step changed without knowing of its delete comes back, renamed, on every device'
      : 'today: a step renamed without knowing of its delete stays deleted', async () => {
      await a.context.setOffline(true);
      await settle(500);
      await b.board(address);
      await b.deleteStep('Leave the dock');
      assert.ok(await c.until(address, async () => await c.card('Leave the dock').count() === 0), 'the delete reached the server');
      const held = await a.openStep('Leave the dock');
      await held.getByRole('button', { name: 'Edit name', exact: true }).click();
      await a.page.getByRole('textbox', { name: 'Name', exact: true }).fill('Leave the harbour');
      await a.page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      await a.page.getByRole('article', { name: 'Leave the harbour', exact: true }).waitFor();
      await a.closeStep();
      await a.context.setOffline(false);
      const cameBack = await c.until(address, async () => await c.card('Leave the harbour').count() === 1, 30_000);
      assert.equal(cameBack, mode === 'on', mode === 'on' ? 'the renamed step came back' : 'the renamed step stayed deleted');
    });

    await a.board(address);
    if (mode === 'on') {
      await check('§6: a step linked offline to a step another device deleted is told once what it follows now, and a revival the device never saw is not', async () => {
        await a.context.setOffline(true);
        await settle(500);
        await a.create('Trim the sail', /Read the wind/);
        await b.board(address);
        await b.deleteStep('Read the wind');
        assert.ok(await c.until(address, async () => await c.card('Read the wind').count() === 0), 'the delete reached the server');
        await a.context.setOffline(false);
        await a.page.locator('.st-board-landed').waitFor({ timeout: 45_000 });
        await a.card('Read the wind').waitFor({ state: 'detached' });
        assert.deepEqual(await a.landed(), [['Trim the sail', 'Read the wind was removed. This now follows Choose a course.']],
          'the step linked offline says it once; the step renamed without knowing of its delete says nothing');
        const step = await a.openStep('Trim the sail');
        assert.equal(await step.locator('.st-step-landed').innerText(), 'Read the wind was removed. This now follows Choose a course.');
        await a.closeStep();
        await a.board(address);
        assert.deepEqual(await a.landed(), [], 'a later opening is quiet');
      });
      await a.board(address);
      await check('a roadmap’s deletion lands on the person’s roadmaps with Undo, and Undo within the hold returns to it', async () => {
        await a.deleteFromSwitcher('Learn to sail');
        await a.page.locator('.st-roadmaps').waitFor();
        const toast = a.page.locator('.st-board-toast');
        await toast.getByText('Roadmap deleted', { exact: true }).waitFor();
        assert.equal(await a.page.locator('.st-roadmaps-row').count(), 1, 'the list holds the roadmap left');
        await toast.getByRole('button', { name: 'Undo', exact: true }).click();
        await a.page.locator('.st-board-toast', { hasText: 'Deletion undone' }).waitFor();
        assert.ok(a.page.url().endsWith(address), 'Undo returns to the roadmap');
        assert.ok(await c.until(address, async () => await c.card('Choose a course').count() === 1), 'another device still opens it');
      });
      await check('after nine seconds the deletion is permanent: another device lists only the roadmap left', async () => {
        await a.deleteFromSwitcher('Learn to sail');
        await a.page.locator('.st-board-toast').waitFor();
        await a.page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15_000 });
        const end = Date.now() + 45_000;
        let gone = false;
        while (!gone && Date.now() < end) {
          await c.page.goto(`${origin}/#/app/roadmaps`);
          await c.page.locator('.st-roadmaps-row').first().waitFor();
          await settle(1500);
          gone = await c.page.locator('.st-roadmaps-row').count() === 1;
        }
        assert.ok(gone, 'the deleted roadmap left every list');
      });
    } else {
      await check('today a roadmap’s deletion lands on the newest roadmap left, with no Undo, and the server serves it no more', async () => {
        await a.deleteFromSwitcher('Learn to sail');
        await a.page.waitForURL((url) => !url.hash.endsWith(sail));
        await a.page.locator('.st-roadmap-progress').waitFor();
        assert.equal(await a.page.locator('.st-board-toast').count(), 0, 'no Undo is offered');
        const response = await fetch(`${backend}/v1/trees/${sail}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 404, 'the server serves it no more');
      });
    }
    await check('no device logged an error', async () => {
      assert.deepEqual(devices.flatMap((device) => device.errors), []);
    });
  } finally {
    for (const device of devices) await device.context.close();
  }
}

// One run: its database and owner, the server with the engine as the mode says, the app built with the switch as it
// says and served on the given port; the scenarios; then everything it started stopped and dropped.
async function run(mode, browser) {
  const database = `${prefix}roadmap_replica_${mode}_${process.pid}`;
  const url = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
  const account = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const sql = (statement) => execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], { stdio: ['ignore', 'pipe', 'pipe'] });
  let server, web, created = false, passed = 0;
  const check = async (name, body) => { await body(); passed++; console.log(`PASS ${mode} · ${name}`); };
  try {
    for (const port of [backendPort, webPort]) {
      try { execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']); throw new Error(`port ${port} is occupied`); }
      catch (error) { if (error.status !== 1) throw error; }
    }
    execFileSync('createdb', ['-h', host, database]); created = true;
    execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(repo, 'backend/db/schema.sql')], { stdio: ['ignore', 'pipe', 'pipe'] });
    sql(`insert into users(id,email,name) values('${account}','web-roadmap@example.com','Web Roadmap'); insert into sessions(token_hash,user_id,expires_ms) values('${hash(secret)}','${account}',99999999999999);`);
    const dist = resolve(scratch, `dist-${mode}`);
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: process.cwd(), env: { ...process.env, VITE_ROADMAP_REPLICA_ROOM: mode === 'on' ? 'on' : '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    server = launch(resolve(binaries, 'windmill_server'), [], { cwd: resolve(repo, 'backend'), env: { ...process.env, DATABASE_URL: url,
      PORT: String(backendPort), WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin,
      ROADMAP_ENGINE_ENABLED: mode === 'on' ? '1' : '',
      RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '', SENTRY_DSN: '', AMPLITUDE_API_KEY: '' } });
    web = launch(process.execPath, ['scripts/serve-built.mjs', '--root', dist, '--port', String(webPort), '--backend', backend, '--duration', '1200'], { cwd: process.cwd() });
    await Promise.all([waitForServer(`${backend}/v1/me`, server), waitForServer(origin, web)]);
    await scenarios(mode, browser, secret, account, check);
    const events = Number(sql("select count(*) from events where name like 'roadmap_%'").toString().match(/\d+/)?.[0] ?? 0);
    assert.ok(events > 0, 'the room’s events reached the local intake');
    return passed;
  } finally {
    if (web) { stopPort(webPort); web.kill('SIGTERM'); }
    if (server) { stopPort(backendPort); server.kill('SIGTERM'); }
    const exits = await stopped([server, web]);
    for (const result of exits) if (result.status === 'rejected') throw result.reason;
    if (created) execFileSync('dropdb', ['-h', host, database]);
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const on = await run('on', browser);
  const off = await run('off', browser);
  assert.deepEqual({ on, off }, { on: 7, off: 5 }, 'every scenario of both runs must finish');
  console.log(`Roadmap replica local-stack e2e: ${on} passed with both switches on, ${off} with both off; local event intake verified`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : error);
  console.error(`Stack diagnostics: ${logPath}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  log.end();
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
