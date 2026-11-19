// The roadmap room's writes end to end on a local stack, once with the server's roadmap engine and the web's switch on
// (the room on the device's copy) and once with both off (today's room). One owner on several devices, each a browser
// context with its own store: Undo and Redo, edits made offline syncing once the connection returns, a change made
// without knowing of another device's delete (INV-1), a change made on a device that already holds that delete (INV-1,
// the server keeping the step's other fields), the line that tells the person once of a link of theirs another device's
// delete changed, named from the device's note when the room opens again (§6), a roadmap's deletion and a sign-out that
// leave no step's name in the device's store (§6), a roadmap's deletion from the switcher, and a change to a roadmap
// another device deleted, kept in the one list of what cannot land (§6, flow 49) only with the switch on. Each run has
// its own database, server and built app on the given ports, and stops and drops them. It prints no id and no roadmap
// text: a check that passes prints its name, and a failure prints the failing check's name, the words of the assertion
// that failed (none of which names a roadmap, a step or an id) or else only the kind of error, and the path of the stack
// log, which holds the full error and the stack's output and stays on this machine.
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
    const knot = await plant({ title: planted.knot, nodes: [{ id: 'bowline', label: 'Tie a bowline', color: 'terracotta', prerequisites: [] }] });
    return { sail, knot };
  }
  const device = await OwnerDevice.open('seed', secret, account);
  try {
    const sail = await device.plant(new device.domain.CreateRoadmap(planted.sail, { steps: [
      { key: 'course', label: 'Choose a course' }, { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock' },
    ], links: [['course', 'wind'], ['wind', 'dock']] }));
    const knot = await device.plant(new device.domain.CreateRoadmap(planted.knot, { steps: [{ key: 'bowline', label: 'Tie a bowline' }], links: [] }));
    const row = await device.plant(new device.domain.CreateRoadmap('Learn to row', { steps: [{ key: 'grip', label: 'Grip the oars' }], links: [] }));
    await device.engine.start();
    await device.sent();
    return { sail, knot, row };
  } finally {
    device.engine.close();
  }
}

// A device of the owner's with no screen: the browser engine on an in-memory store over the local server, and roadmap's
// domain actions on it, as the room runs them.
class OwnerDevice {
  static async open(name, secret, account) {
    const source = (path) => import(pathToFileURL(resolve(path)).href);
    const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
    const { BrowserSyncEngine } = await source('src/platform/sync/engine.js');
    const { registry } = await source('src/platform/sync/schema.js');
    const { HttpTransport } = await source('src/platform/sync/transport.js');
    const { FakeLocks } = await source('test/platform/sync/fakes.js');
    const { ActionRunner, EngineReplica } = await source('src/platform/domain-kit/runner.js');
    const { FixedZone } = await source('src/platform/domain-kit/time.js');
    const { CreateRoadmap } = await source('src/products/roadmap/domain/roadmaps.js');
    const { ChangeStep, RoadmapStep } = await source('src/products/roadmap/domain/steps.js');
    const transport = new HttpTransport({ schema: registry.version, base: backend, reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: name }),
      scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
      socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
      fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) }) });
    const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name, registry, transport,
      navigator: { onLine: true, locks: new FakeLocks() }, document: null, window: null,
      telemetry: { event() {}, failure(operation) { throw new Error(`the ${name} device's engine failed: ${operation}`); } } });
    await engine.signIn(account);
    return new OwnerDevice(engine, new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0)), { CreateRoadmap, ChangeStep, RoadmapStep });
  }

  constructor(engine, runner, domain) {
    this.engine = engine;
    this.runner = runner;
    this.domain = domain;
  }

  async plant(act) {
    const outcome = await this.runner.runAct(act);
    assert.equal(outcome.kind, 'committed', 'the roadmap was planted');
    return outcome.result.tree;
  }

  // Every write of the device's reached the server, within the bound.
  async sent() {
    for (let turn = 0; turn < 60 && this.engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'); turn++) {
      await settle(200);
      this.engine.kick();
      await this.engine.send();
    }
    assert.ok(!this.engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'), 'the device\'s writes reached the server');
  }

  // The device pulls until `seen` holds of its replica, within the bound.
  async pulled(seen) {
    for (let turn = 0; turn < 60; turn++) {
      this.engine.kickPull();
      await this.engine.pull();
      if (seen()) return true;
      await settle(250);
    }
    return false;
  }

  // The id of the step of the roadmap this device draws under `label`, or null.
  step(tree, label) {
    const { RoadmapStep } = this.domain;
    return this.runner.read(`tree/${tree}`, (read) => read.repository(RoadmapStep).all('drawn').find((step) => step.label === label)?.id.record ?? null);
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

  // Every record and row of the device's sync store, read from IndexedDB itself, not through the room: `records` the
  // control records by key (replicas, device rows, notices, the outbox), `rows` the cached rows by their generation.
  store() {
    return this.page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('wm-sync');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const all = (name) => new Promise((resolve, reject) => {
          const request = database.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return { records: (await all('records')).map(({ key, value }) => ({ key, value })), rows: (await all('rows')).map(({ generation, value }) => ({ generation, value })) };
      } finally {
        database.close();
      }
    });
  }

  // The store read again until `seen` holds of it or the bound passes.
  async storeUntil(seen, bound = 45_000) {
    const end = Date.now() + bound;
    for (;;) {
      if (seen(await this.store())) return true;
      if (Date.now() > end) return false;
      await settle(500);
    }
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

  // The connection cut once the service worker controls the page and has primed the offline shell, so the room's
  // lazy chunks still load: the run waits for what a person's second visit already has.
  async offline() {
    const end = Date.now() + 30_000;
    const ready = () => this.page.evaluate(async () => !!navigator.serviceWorker.controller
      && !!(await (await (await caches.open('windmill-shell-v2')).match('/offline-generation'))?.json()));
    while (!await ready()) {
      if (Date.now() > end) throw new Error('the offline shell was not primed within 30 s');
      await settle(100);
    }
    await this.context.setOffline(true);
    await settle(500);
  }

  async rename(label, name) {
    const step = await this.openStep(label);
    await step.getByRole('button', { name: 'Edit name', exact: true }).click();
    await this.page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await this.page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await this.page.getByRole('article', { name, exact: true }).waitFor();
    await this.closeStep();
  }

  // The account menu's rows, read on the app's home with it open; it closes again.
  async accountMenu() {
    await this.page.goto(`${origin}/app`);
    await this.page.locator('.wm-head-seat button[aria-expanded]').click();
    await this.page.getByRole('menu').first().waitFor();
    const rows = await this.page.getByRole('menuitem').allInnerTexts();
    await this.page.keyboard.press('Escape');
    return rows;
  }

  // The account menu read again until `seen` holds of its rows or the bound passes.
  async menuUntil(seen, bound = 45_000) {
    const end = Date.now() + bound;
    for (;;) {
      if (seen(await this.accountMenu())) return true;
      if (Date.now() > end) return false;
      await settle(1500);
    }
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

// The rows of one of the store's caches, `confirmed` or `spentIds`, of one scope: its control record names the
// generation its rows are kept under.
const rowsOf = (store, kind, scope) => {
  const generations = new Set(store.records.filter(({ key }) => {
    const [what, , cache, of] = JSON.parse(key);
    return what === 'cache' && cache === kind && of === scope;
  }).map(({ value }) => value.generation));
  return store.rows.filter((row) => generations.has(row.generation)).map((row) => row.value);
};
// What a device's store holds of a roadmap: the id of its step under `label` as the server confirmed it, and whether the
// device keeps a step's spent id, all a delete leaves of it (engine.md §7.5).
const stepIn = (store, tree, label) => rowsOf(store, 'confirmed', `tree/${tree}`).find((row) => row.t === 'node' && row.f?.label?.[0] === label)?.id ?? null;
const spentIn = (store, tree, id) => rowsOf(store, 'spentIds', `tree/${tree}`).some((row) => row.id === id);
// The landing notes the store holds, by key, and whether any record or row of it holds `words`.
const notesIn = (store) => Object.fromEntries(store.records.filter(({ key }) => key.includes('"landing:')).map(({ key, value }) => [JSON.parse(key).at(-1), value]));
const holds = (store, words) => JSON.stringify(store).includes(words);

// A screenshot of what a device shows, for comparing with the boards, where WM_E2E_SHOTS names a folder; never printed.
async function shoot(device, name) {
  if (!process.env.WM_E2E_SHOTS) return;
  await device.page.evaluate(() => Promise.all((document.querySelector('.st-kept')?.getAnimations() ?? []).map((animation) => animation.finished)));
  await device.page.screenshot({ path: resolve(process.env.WM_E2E_SHOTS, `${name}.png`) });
}

async function scenarios(mode, browser, { secret, second }, account, check) {
  const { sail, knot, row } = await seed(mode, secret, account);
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
      await a.offline();
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
      await a.offline();
      await b.board(address);
      await b.deleteStep('Leave the dock');
      assert.ok(await c.until(address, async () => await c.card('Leave the dock').count() === 0), 'the delete reached the server');
      await a.rename('Leave the dock', 'Leave the harbour');
      await a.context.setOffline(false);
      const cameBack = await c.until(address, async () => await c.card('Leave the harbour').count() === 1, 30_000);
      assert.equal(cameBack, mode === 'on', mode === 'on' ? 'the renamed step came back' : 'the renamed step stayed deleted');
    });

    await a.board(address);
    if (mode === 'on') {
      await check('§6: a step linked offline to a step another device deleted is told once what it follows now, and a revival the device never saw is not', async () => {
        await a.offline();
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
        assert.equal(await step.locator('.st-step-landed').innerText(), 'Read the wind was removed. This now follows Choose a course.', 'the step\'s page says the same line');
        await a.closeStep();
        await a.board(address);
        assert.deepEqual(await a.landed(), [], 'a later opening is quiet');
      });
      await check('INV-1: a change made on a device that holds only the spent id of a step another device deleted brings it back on every device with the change and its other fields', async () => {
        const n = await OwnerDevice.open('owner-device', secret, account);
        try {
          await n.engine.start();
          assert.ok(await n.pulled(() => n.step(sail, 'Tie a reef knot') !== null), 'the device holds the roadmap');
          const reefKnot = n.step(sail, 'Tie a reef knot');
          await b.board(address);
          await b.deleteStep('Tie a reef knot');
          assert.ok(await c.until(address, async () => await c.card('Tie a reef knot').count() === 0), 'the delete reached the server');
          assert.ok(await n.pulled(() => n.engine.readMetadata(`tree/${sail}`).spent.some((row) => row.id === reefKnot)), 'the device keeps only the spent id');
          const changed = await n.runner.runAct(new n.domain.ChangeStep(sail, reefKnot, { description: 'Hold it under load' }));
          assert.equal(changed.kind, 'committed', 'the change is admitted');
          await n.sent();
        } finally {
          n.engine.close();
        }
        assert.ok(await c.until(address, async () => await c.card('Tie a reef knot').count() === 1), 'the step came back with its name');
        const step = await c.openStep('Tie a reef knot');
        assert.ok((await step.innerText()).includes('Hold it under load'), 'the step came back with the change');
        await c.closeStep();
      });
      await a.board(address);
      await check('§6: a line about a step linked to one another device deleted names it from the device’s note when the room opens again', async () => {
        await a.create('Ease the sheet', /Trim the sail/);
        let trim = null;
        assert.ok(await a.storeUntil((store) => (trim = stepIn(store, sail, 'Trim the sail')) !== null), 'the device holds the step it linked from');
        await a.page.goto(`${origin}/#/app/roadmaps`);
        await a.page.locator('.st-roadmaps-row').first().waitFor();
        await b.board(address);
        await b.deleteStep('Trim the sail');
        assert.ok(await c.until(address, async () => await c.card('Trim the sail').count() === 0), 'the delete reached the server');
        assert.ok(await a.storeUntil((store) => spentIn(store, sail, trim) && stepIn(store, sail, 'Trim the sail') === null),
          'the device holds the delete, the step\'s spent id alone, before its room opens');
        await a.board(address);
        await a.page.locator('.st-board-landed').waitFor({ timeout: 45_000 });
        assert.deepEqual(await a.landed(), [['Ease the sheet', 'Trim the sail was removed. This now follows Choose a course.']],
          'the room names the deleted step from the device\'s note');
        await a.board(address);
        assert.deepEqual(await a.landed(), [], 'a later opening is quiet');
      });
      await check('§6: a roadmap’s deletion takes the device’s note of it, and a sign-out with Keep takes every note: the device’s store keeps no name of a step', async () => {
        const d = await Device.open(browser, second);
        devices.push(d);
        await d.board(address);
        await d.create('Coil the line', /Choose a course/);
        await d.board(`#/app/${row}`);
        await d.create('Feather the oars', /Grip the oars/);
        assert.ok(await c.until(`#/app/${row}`, async () => await c.card('Feather the oars').count() === 1), 'the new step reached the server');
        const made = notesIn(await d.store());
        assert.deepEqual({ notes: Object.keys(made).sort(), named: [holds(made, 'Choose a course'), holds(made, 'Grip the oars')] },
          { notes: [`landing:${row}`, `landing:${sail}`].sort(), named: [true, true] }, 'the device notes its new steps in each roadmap, with the name of the step each link comes from');
        await d.board(`#/app/${row}`);
        await d.deleteFromSwitcher('Learn to row');
        await d.page.locator('.st-board-toast').waitFor();
        await d.page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15_000 });
        const deleted = notesIn(await d.store());
        assert.deepEqual({ notes: Object.keys(deleted), named: [holds(deleted, 'Choose a course'), holds(deleted, 'Grip the oars')] },
          { notes: [`landing:${sail}`], named: [true, false] }, 'the deleted roadmap\'s note left with it; the note of a roadmap that stands stays until sign-out');
        await d.page.goto(`${origin}/app`);
        await d.page.locator('.wm-head-seat button[aria-expanded]').click();
        await d.page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
        const ask = d.page.getByRole('dialog', { name: 'Sign out?', exact: true });
        await ask.getByRole('button', { name: 'Sign out', exact: true }).click();
        await ask.waitFor({ state: 'detached' });
        const head = (store) => store.records.find(({ key }) => key === '["head"]')?.value.meta ?? {};
        assert.ok(await d.storeUntil((store) => store.records.some(({ key, value }) => key.startsWith('["replica"') && value.state === 'dormant')
          && !head(store).signOut && !head(store).deviceCleanup), 'the sign-out finished with Keep and the products\' cleanup ran');
        const out = await d.store();
        assert.deepEqual({ notes: notesIn(out), named: ['Choose a course', 'Grip the oars'].filter((words) => holds(out, words)) },
          { notes: {}, named: [] }, 'after a sign-out with Keep the device\'s store holds no landing note, and no record or row names a step a link came from');
        const end = Date.now() + 45_000;
        let listed = 0;
        while (listed !== 2 && Date.now() < end) {
          await a.page.goto(`${origin}/#/app/roadmaps`);
          await a.page.locator('.st-roadmaps-row').first().waitFor();
          await settle(1500);
          listed = await a.page.locator('.st-roadmaps-row').count();
        }
        assert.equal(listed, 2, 'the deleted roadmap left the other devices\' lists');
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
    await check(mode === 'on' ? '§6: a change to a roadmap another device deleted is kept here with its reason; Copy takes its words, Discard asks once and empties the list, and the account menu\'s entry leaves with it'
      : 'today nothing is kept here: the account menu offers no Kept here after a change to a roadmap another device deleted', async () => {
      const knotAddress = `#/app/${knot}`;
      assert.equal((await a.accountMenu()).some((row) => row.startsWith('Kept here')), false, 'nothing is kept before');
      await a.board(knotAddress);
      await a.offline();
      await a.rename('Tie a bowline', 'Tie a running bowline');
      await b.board(knotAddress);
      await b.deleteFromSwitcher('Learn to knot');
      if (mode === 'off') {
        await b.page.waitForURL((url) => !url.hash.endsWith(knot));
        await a.context.setOffline(false);
        await settle(5000);
        assert.deepEqual({ entry: (await a.accountMenu()).some((row) => row.startsWith('Kept here')), list: await a.page.locator('.st-kept').count() },
          { entry: false, list: 0 }, 'with the switch off nothing of the list appears');
        return;
      }
      await b.page.locator('.st-board-toast').waitFor();
      await b.page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15_000 });
      const end = Date.now() + 45_000;
      let gone = false;
      while (!gone && Date.now() < end) {
        await c.page.goto(`${origin}/#/app/roadmaps`);
        await c.page.locator('.st-roadmaps').waitFor();
        await settle(1500);
        gone = await c.page.locator('.st-roadmaps-row').count() === 0;
      }
      assert.ok(gone, 'the deletion reached the server');
      await a.context.setOffline(false);
      assert.ok(await a.menuUntil((rows) => rows.includes('Kept here · 1')), 'the account menu offers Kept here with one change');

      await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await a.page.goto(`${origin}/app`);
      await a.page.locator('.wm-head-seat button[aria-expanded]').click();
      await a.page.getByRole('menuitem', { name: 'Kept here · 1', exact: true }).click();
      const list = a.page.getByRole('dialog', { name: 'Changes kept here', exact: true });
      await list.waitFor();
      assert.deepEqual(await list.locator('.st-kept-row').evaluateAll((rows) => rows.map((row) => [row.querySelector('.st-kept-row-title').textContent, row.querySelector('.st-kept-reason').textContent])),
        [['Tie a running bowline', 'Roadmap deleted elsewhere.']], 'the list shows the change with its reason');
      await shoot(a, 'kept-1440-list');
      await list.getByRole('button', { name: 'Copy', exact: true }).click();
      assert.equal(await a.page.evaluate(() => navigator.clipboard.readText()), 'Tie a running bowline', 'Copy put the change\'s words on the clipboard');
      await list.getByRole('button', { name: 'Close', exact: true }).click();
      await list.waitFor({ state: 'detached' });
      assert.equal(await a.page.evaluate(() => document.activeElement?.closest('.wm-head-seat') !== null), true, 'Close hands focus back to the account seat');

      await a.page.setViewportSize({ width: 390, height: 844 });
      await a.page.locator('.wm-head-seat button[aria-expanded]').click();
      await a.page.getByRole('menuitem', { name: 'Kept here · 1', exact: true }).click();
      const page = a.page.getByRole('dialog', { name: 'Kept here', exact: true });
      await page.locator('.st-kept-count').waitFor();
      assert.equal(await page.locator('.st-kept-count').innerText(), '1 change', 'the list\'s page counts one change');
      await shoot(a, 'kept-390-list');
      await page.locator('.st-kept-row').click();
      await page.getByRole('button', { name: 'Copy', exact: true }).click();
      await page.getByText('Copied', { exact: true }).waitFor();
      await shoot(a, 'kept-390-copied');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      const ask = a.page.getByRole('alertdialog', { name: 'Discard this change?', exact: true });
      await ask.waitFor();
      await shoot(a, 'kept-390-ask');
      await ask.getByRole('button', { name: 'Discard', exact: true }).click();
      await a.page.locator('.st-kept').waitFor({ state: 'detached' });
      await a.page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal((await a.accountMenu()).some((row) => row.startsWith('Kept here')), false, 'the entry left with the last change');
      await settle(6000);
    });
    await check('no device logged an error', async () => {
      assert.deepEqual(devices.flatMap((device) => device.errors), [], 'no page threw and no console logged an error');
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
  const second = randomBytes(24).toString('hex');
  const sql = (statement) => execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], { stdio: ['ignore', 'pipe', 'pipe'] });
  let server, web, created = false, passed = 0;
  const check = async (name, body) => {
    try { await body(); } catch (error) { console.error(`FAIL ${mode} · ${name}`); throw error; }
    passed++;
    console.log(`PASS ${mode} · ${name}`);
  };
  try {
    for (const port of [backendPort, webPort]) {
      try { execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']); throw new Error(`port ${port} is occupied`); }
      catch (error) { if (error.status !== 1) throw error; }
    }
    execFileSync('createdb', ['-h', host, database]); created = true;
    execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(repo, 'backend/db/schema.sql')], { stdio: ['ignore', 'pipe', 'pipe'] });
    sql(`insert into users(id,email,name) values('${account}','web-roadmap@example.com','Web Roadmap'); insert into sessions(token_hash,user_id,expires_ms) values('${hash(secret)}','${account}',99999999999999),('${hash(second)}','${account}',99999999999999);`);
    const dist = resolve(scratch, `dist-${mode}`);
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: process.cwd(), env: { ...process.env, VITE_ROADMAP_REPLICA_ROOM: mode === 'on' ? 'on' : '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    server = launch(resolve(binaries, 'windmill_server'), [], { cwd: resolve(repo, 'backend'), env: { ...process.env, DATABASE_URL: url,
      PORT: String(backendPort), WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin,
      ROADMAP_ENGINE_ENABLED: mode === 'on' ? '1' : '',
      RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '', SENTRY_DSN: '', AMPLITUDE_API_KEY: '' } });
    web = launch(process.execPath, ['scripts/serve-built.mjs', '--root', dist, '--port', String(webPort), '--backend', backend, '--duration', '1200'], { cwd: process.cwd() });
    await Promise.all([waitForServer(`${backend}/v1/me`, server), waitForServer(origin, web)]);
    await scenarios(mode, browser, { secret, second }, account, check);
    const events = Number(sql("select count(*) from events where name like 'roadmap_%'").toString().match(/\d+/)?.[0] ?? 0);
    assert.ok(events > 0, 'the room’s events reached the local intake');
    const kept = Number(sql("select count(distinct name) from events where name in ('roadmap_kept', 'roadmap_write_cannot_land')").toString().match(/\d+/)?.[0] ?? 0);
    assert.equal(kept, mode === 'on' ? 2 : 0, 'the kept list’s events reached the local intake only with the switch on');
    const undone = sql("select coalesce(string_agg(distinct (props->>'action') || ':' || (props->>'outcome'), ',' order by (props->>'action') || ':' || (props->>'outcome')), '') from events where name = 'roadmap_undo'")
      .toString().match(/(?:undo|redo):[a-z]+(?:,(?:undo|redo):[a-z]+)*/)?.[0] ?? '';
    assert.equal(undone, mode === 'on' ? 'redo:applied,undo:applied' : '', 'what the room’s Undo and Redo came to reached the local intake only with the switch on');
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
  assert.deepEqual({ on, off }, { on: 11, off: 6 }, 'every scenario of both runs must finish');
  console.log(`Roadmap replica local-stack e2e: ${on} passed with both switches on, ${off} with both off; local event intake verified`);
} catch (error) {
  log.write(`\n${error?.stack ?? error}\n`);
  console.error(error instanceof assert.AssertionError && !error.generatedMessage ? error.message : `${error?.name ?? 'Error'}, its message in the stack log`);
  console.error(`Stack diagnostics: ${logPath}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  log.end();
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
