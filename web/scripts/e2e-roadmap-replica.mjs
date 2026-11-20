// The roadmap room's writes end to end on a local stack, once with the server's roadmap engine and the web's switch on
// (the room on the device's copy) and once with both off (today's room). One owner on several devices, each a browser
// context with its own store: Undo and Redo, edits made offline syncing once the connection returns, Settings' export of
// every roadmap read from the device's copy with no connection (with the switch on), a change made without knowing of
// another device's delete (INV-1), a change made on a device that already holds that delete (INV-1, the server keeping
// the step's other fields), the line that tells the person once of a link of theirs that reached the server after another
// device's delete of its step, named from the device's note in a room opened after a reload (§6), a roadmap's deletion and
// a sign-out that leave no step's name in the device's store (§6), a roadmap's deletion from the switcher, a change to a
// roadmap another device deleted, kept in the one list of what cannot land (§6, flow 49), and the sign-in and sign-out
// questions of flow 50 (§5 Signed out): a browser's signed-out roadmaps added without asking to an account that holds
// none, Add, Discard and Escape where it holds some, and Keep and Discard at a sign-out with a change unsent, only with the
// switch on; with it off, today's silent claim and plain sign-out; and the carry-over of what the last old bundle kept in
// a browser (§8.2), its stores written by the old bundle's own code: with the switch on, a roadmap made signed out, its
// marks and workspace carried and kept through a sign-in, its old stores kept until the server takes it, and a signed-in
// browser's unsent changes carried to the server, its old stores gone once carried; with it off, the old stores untouched.
// With the switch on, also readers and signed-out births (§5): a stranger, signed out and signed in, opening a public
// roadmap and its subtree by link, each followed on the live socket as the room opens it (a signed-in reader's own overlay
// with it), and dropped as the signed-in one leaves; a private roadmap no stranger can read; a browser that keeps nothing shown the
// room's load error (E-5 is not built); and a roadmap made at the birth door signed out, held in the browser's anon replica
// and joining at sign-in an account that holds none. The home card, the landing and the room's switcher list the person's
// roadmaps: with the switch on from the device's copy, the account's signed in and the browser's own signed out; with it
// off from today's list, which holds none signed out. With the switch on every page meets the server as the move leaves it
// (§7, §8.3): each route the move retires answers 410 and the old socket refuses, and the run holds that no page asked for
// one. Last, every person leaves the app, and the run waits, within its
// bound, until the local intake holds the room's events, those only the switch emits only with it on. Each run has its
// own database, server and built app on the given ports, and stops and drops them.
// It prints no id and no roadmap text: a check that passes prints its name, and a failure prints the failing check's
// name, the words of the assertion that failed (none of which names a roadmap, a step or an id) or else only the kind of
// error, and the path of the stack log, which holds the full error and the stack's output and stays on this machine.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';

const repo = resolve('..');
const binaries = resolve(process.argv[2] ?? '../backend/build');
const backendPort = Number(process.env.WM_E2E_PORT ?? 8095);
const webPort = Number(process.env.WM_E2E_WEB_PORT ?? 5183);
const prefix = process.env.WM_E2E_DB_PREFIX ?? 'wm_web_';
const host = process.env.PGHOST ?? (process.platform === 'darwin' ? '/tmp' : '127.0.0.1');
const origin = `http://127.0.0.1:${webPort}`;
const backend = `http://127.0.0.1:${backendPort}`;
// A page of the app's origin that runs no app: a browser's stores are written from it while nothing else writes them.
const outsideApp = `${origin}/privacy.html`;
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

const source = (path) => import(pathToFileURL(resolve(path)).href);

// The routes roadmap's move onto the engine retires or answers 410 (roadmap-on-the-engine.md §7, §8.3), each by its method,
// its path's shape and the name it is counted under. The fork, the activity and progress reads and tending stay.
const RETIRED = [
  ['GET', /^\/v1\/trees$/, 'GET /v1/trees'],
  ['POST', /^\/v1\/trees$/, 'POST /v1/trees'],
  ['GET', /^\/v1\/trees\/[^/]+$/, 'GET /v1/trees/{id}'],
  ['PATCH', /^\/v1\/trees\/[^/]+$/, 'PATCH /v1/trees/{id}'],
  ['DELETE', /^\/v1\/trees\/[^/]+$/, 'DELETE /v1/trees/{id}'],
  ['GET', /^\/v1\/trees\/[^/]+\/guides$/, 'GET /v1/trees/{id}/guides'],
  ['GET', /^\/v1\/trees\/[^/]+\/diagnostics$/, 'GET /v1/trees/{id}/diagnostics'],
  ['PUT', /^\/v1\/trees\/[^/]+\/subtree$/, 'PUT /v1/trees/{id}/subtree'],
];

// The server as the move leaves it (§7, §8.3), standing between the built app and the backend in a run with the switch
// on: each route of `RETIRED` answers 410 `client-update-required` and `/v1/socket` refuses its upgrade so, each refusal
// counted in `refused` under its route's name, never its id. Every other request and upgrade passes to the backend as it
// came, an upgrade on a connection of its own, as Drogon needs. It listens on a port the system picks.
async function afterTheMove(refused) {
  const count = (name) => refused.set(name, (refused.get(name) ?? 0) + 1);
  const gone = JSON.stringify({ code: 'client-update-required' });
  const toBackend = (request, agent) => forward({ host: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers: request.headers, agent });
  const statusLine = (answer) => `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${answer.rawHeaders
    .flatMap((value, index) => (index % 2 ? [] : [`${value}: ${answer.rawHeaders[index + 1]}`])).join('\r\n')}\r\n\r\n`;
  const server = createServer((request, response) => {
    const retired = RETIRED.find(([method, path]) => method === request.method && path.test(request.url.split('?')[0]));
    if (retired) {
      count(retired[2]);
      request.resume();
      response.writeHead(410, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(gone) }).end(gone);
      return;
    }
    const passed = toBackend(request);
    passed.once('response', (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    passed.once('error', () => response.destroy());
    request.pipe(passed);
  });
  server.on('upgrade', (request, socket, head) => {
    socket.once('error', () => socket.destroy());
    if (request.url.split('?')[0] === '/v1/socket') {
      count('WS /v1/socket');
      socket.end(`HTTP/1.1 410 Gone\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(gone)}\r\nconnection: close\r\n\r\n${gone}`);
      return;
    }
    const passed = toBackend(request, false);
    passed.once('upgrade', (answer, peer, tail) => {
      socket.write(statusLine(answer));
      if (tail.length) socket.write(tail);
      if (head.length) peer.write(head);
      peer.once('error', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      peer.pipe(socket).pipe(peer);
    });
    passed.once('response', (answer) => {
      socket.write(statusLine(answer));
      answer.pipe(socket);
    });
    passed.once('error', () => socket.destroy());
    passed.end();
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  return server;
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

// The browser engine and roadmap's domain built for a page, once a run: a browser makes its signed-out roadmaps through it
// (`Device.plantSignedOut`).
let planter = null;
function signedOutPlanter() {
  planter ??= (async () => {
    const entry = resolve(scratch, 'plant-signed-out.mjs');
    const specifier = (path) => JSON.stringify(resolve(path));
    writeFileSync(entry, `
      import { BrowserSyncEngine } from ${specifier('src/platform/sync/engine.js')};
      import { registry } from ${specifier('src/platform/sync/schema.js')};
      import { ActionRunner, EngineReplica } from ${specifier('src/platform/domain-kit/runner.js')};
      import { FixedZone } from ${specifier('src/platform/domain-kit/time.js')};
      import { CreateRoadmap } from ${specifier('src/products/roadmap/domain/roadmaps.js')};
      window.plantSignedOut = async (plans) => {
        const engine = await BrowserSyncEngine.open({ telemetry: { event() {}, failure() {} } });
        try {
          const runner = new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0));
          const trees = [];
          for (const { title, steps } of plans) {
            const outcome = await runner.runAct(new CreateRoadmap(title, { steps: steps.map((label) => ({ key: label, label })), links: [] }));
            if (outcome.kind !== 'committed') throw new Error('a signed-out roadmap was not made');
            trees.push(String(outcome.result.tree));
          }
          return { state: engine.device.activeReplica.meta.state, trees };
        } finally {
          engine.close();
        }
      };`);
    const { build } = await import('vite');
    const result = await build({ configFile: false, logLevel: 'error', build: { write: false, target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'plant-signed-out' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
    return (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output).find((item) => item.type === 'chunk').code;
  })();
  return planter;
}

// A device of the owner's with no screen: the browser engine on an in-memory store over the local server, and roadmap's
// domain actions on it, as the room runs them.
class OwnerDevice {
  static async open(name, secret, account) {
    const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
    const { BrowserSyncEngine } = await source('src/platform/sync/engine.js');
    const { registry } = await source('src/platform/sync/schema.js');
    const { HttpTransport } = await source('src/platform/sync/transport.js');
    const { FakeLocks } = await source('test/platform/sync/fakes.js');
    const { ActionRunner, EngineReplica } = await source('src/platform/domain-kit/runner.js');
    const { FixedZone } = await source('src/platform/domain-kit/time.js');
    const { CreateRoadmap, CreateSubtree, Roadmap, RoadmapMeta, SetVisibility } = await source('src/products/roadmap/domain/roadmaps.js');
    const { ChangeStep, CreateStep, RoadmapStep } = await source('src/products/roadmap/domain/steps.js');
    const { StepMark } = await source('src/products/roadmap/domain/progress.js');
    const { StepNote, Subtask } = await source('src/products/roadmap/domain/workspace.js');
    const { Id } = await source('src/platform/domain-kit/entities.js');
    const transport = new HttpTransport({ schema: registry.version, base: backend, reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: name }),
      scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name),
      socket: () => ({ readyState: 0, close() { this.readyState = 3; } }),
      fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) }) });
    const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, name, registry, transport,
      navigator: { onLine: true, locks: new FakeLocks() }, document: null, window: null,
      telemetry: { event() {}, failure(operation) { throw new Error(`the ${name} device's engine failed: ${operation}`); } } });
    await engine.signIn(account);
    return new OwnerDevice(engine, new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0)),
      { CreateRoadmap, CreateSubtree, SetVisibility, ChangeStep, CreateStep, RoadmapStep, Roadmap, RoadmapMeta, StepMark, StepNote, Subtask, Id });
  }

  constructor(engine, runner, domain) {
    this.engine = engine;
    this.runner = runner;
    this.domain = domain;
  }

  async plant(act) {
    return (await this.write(act)).tree;
  }

  // One of the domain's acts on this device, which must commit; its result.
  async write(act) {
    const outcome = await this.runner.runAct(act);
    assert.equal(outcome.kind, 'committed', 'the device took the write');
    return outcome.result;
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

  // The device pulls until `seen` holds of its replica, or the bound passes.
  async pulledWithin(bound, seen) {
    const end = Date.now() + bound;
    while (Date.now() < end) if (await this.pulled(seen)) return true;
    return false;
  }

  // The titles of the roadmaps of the account's list this device holds.
  titles() {
    const { Roadmap, RoadmapMeta, Id } = this.domain;
    const roadmaps = this.runner.read('self/roadmap', (read) => read.repository(Roadmap).all('drawn'));
    return roadmaps.map((roadmap) => this.runner.read(`tree/${roadmap.id.record}`, (read) => read.repository(RoadmapMeta).find(new Id('meta', RoadmapMeta), 'drawn')?.title ?? ''));
  }

  // The id of the step of the roadmap this device draws under `label`, or null.
  step(tree, label) {
    const { RoadmapStep } = this.domain;
    return this.runner.read(`tree/${tree}`, (read) => read.repository(RoadmapStep).all('drawn').find((step) => step.label === label)?.id.record ?? null);
  }

  // What `body` reads of the person's own layer over a roadmap, its marks and workspace, or null while the device holds none.
  overlay(tree, body) {
    try { return this.runner.read(`self/overlay/${tree}`, body); } catch { return null; }
  }
}

// The owner's room as one device shows it.
class Device {
  static async open(browser, secret, viewport = { width: 1440, height: 1000 }) {
    const device = await Device.signedOut(browser, viewport);
    await device.context.addCookies([{ name: 'wm_session', value: secret, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    return device;
  }

  // A browser no account has signed in to. Each page counts the account decisions it showed (`decisionsShown`).
  static async signedOut(browser, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      window.decisionsShown = 0;
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains('wm-decision')) window.decisionsShown += 1;
      }).observe(document, { childList: true, subtree: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const device = new Device(context, page);
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/v1/sync/live')) return;
      device.following.clear();
      socket.on('framesent', ({ payload }) => {
        let frame = null;
        try { frame = JSON.parse(payload); } catch { return; }
        for (const scope of frame.scopes ?? []) {
          const named = typeof scope === 'string' ? scope : JSON.stringify(scope);
          if (frame.op === 'sub') device.following.add(named);
          if (frame.op === 'unsub') device.following.delete(named);
        }
      });
      socket.on('close', () => device.following.clear());
    });
    page.on('pageerror', () => device.errors.push('pageerror'));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) device.errors.push('console'); });
    return device;
  }

  // Roadmaps made on this browser signed out, in its engine's anonymous replica through roadmap's domain, as the room
  // makes them, before the app loads.
  async plantSignedOut(plans) {
    await this.page.goto(outsideApp);
    await this.page.addScriptTag({ content: await signedOutPlanter(), type: 'module' });
    await this.page.waitForFunction(() => typeof window.plantSignedOut === 'function');
    const { state, trees } = await this.page.evaluate((plans) => window.plantSignedOut(plans), plans);
    assert.equal(state, 'anon', 'the roadmaps were made signed out');
    return trees;
  }

  // The old bundle's stores (`oldBundle`) written into this browser before the app loads.
  async holdOld({ records, storage }) {
    await this.page.goto(outsideApp);
    await this.page.evaluate(async ({ records, storage }) => {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
      const database = await new Promise((done, fail) => {
        const request = indexedDB.open('windmill-sync', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('trees');
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      await new Promise((done, fail) => {
        const write = database.transaction('trees', 'readwrite');
        for (const [key, value] of records) write.objectStore('trees').put(value, key);
        write.oncomplete = done;
        write.onerror = () => fail(write.error);
      });
      database.close();
    }, { records, storage });
  }

  async signIn(secret, address = 'app') {
    await this.context.addCookies([{ name: 'wm_session', value: secret, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await this.page.goto(`${origin}/${address}`);
  }

  async signOut() {
    await this.page.goto(`${origin}/app`);
    await this.page.locator('.wm-head-seat button[aria-expanded]').click();
    await this.page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  }

  // The account decision under `title` once it shows, and what it says: its sentence, the names it lists, its notes and
  // its answers in order.
  async decision(title) {
    const dialog = this.page.getByRole('dialog', { name: title, exact: true });
    await dialog.locator('.wm-decision-lead').waitFor();
    return { dialog, said: {
      lead: await dialog.locator('.wm-decision-lead').innerText(),
      items: await dialog.locator('.wm-decision-items li').allInnerTexts(),
      notes: await dialog.locator('.wm-decision-note').allInnerTexts(),
      answers: await dialog.getByRole('button').allInnerTexts(),
    } };
  }

  constructor(context, page) {
    this.context = context;
    this.page = page;
    this.errors = [];
    // The scopes this page's live socket follows, as the frames it sent say: each it sent `sub` for and no `unsub` since.
    this.following = new Set();
  }

  // Which of a roadmap's scopes the live socket follows: its tree scope, and the person's own overlay of it.
  follows(tree) {
    const named = [...this.following].filter((scope) => scope.includes(tree));
    return { tree: named.some((scope) => !scope.includes('overlay')), overlay: named.some((scope) => scope.includes('overlay')) };
  }

  // The live socket's following of a roadmap, read again until it is `wanted` or the bound passes.
  async followsUntil(tree, wanted, bound = 30_000) {
    const end = Date.now() + bound;
    while (JSON.stringify(this.follows(tree)) !== JSON.stringify(wanted) && Date.now() < end) await settle(250);
    return this.follows(tree);
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

  // What the old bundle's stores hold in this browser, as counts: the sync database's records, the device index's rows,
  // and the workspaces' and undrained marks' keys.
  old() {
    return this.page.evaluate(async () => {
      const records = await new Promise((done) => {
        const request = indexedDB.open('windmill-sync');
        request.onupgradeneeded = () => request.result.createObjectStore('trees');
        request.onsuccess = () => {
          const count = request.result.transaction('trees').objectStore('trees').count();
          count.onsuccess = () => { request.result.close(); done(count.result); };
        };
      });
      let rows = 0;
      try { rows = Object.keys(JSON.parse(localStorage.getItem('windmill:device-trees') ?? '{}')).length; } catch { rows = -1; }
      return { records, rows, keys: Object.keys(localStorage).filter((key) => /^windmill:(workspace|progress):/.test(key)).length };
    });
  }

  // The old stores read again until `seen` holds of them or the bound passes.
  async oldUntil(seen, bound = 45_000) {
    const end = Date.now() + bound;
    for (;;) {
      if (seen(await this.old())) return true;
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
const headOf = (store) => store.records.find(({ key }) => key === '["head"]')?.value.meta ?? {};
// The replicas a device's store holds, each by its state with how many entries of its outbox are not yet acked.
const replicasIn = (store) => store.records.filter(({ key }) => key.startsWith('["replica"')).map(({ key, value }) => {
  const handle = JSON.parse(key)[1];
  const unsent = store.records.filter(({ key: other, value: entry }) => other.startsWith('["outbox"') && JSON.parse(other)[1] === handle && entry.state !== 'acked');
  return [value.state, unsent.length];
}).sort();
// The titles of an account's roadmaps as the server lists them today (GET /v1/trees).
async function listedTitles(secret) {
  const response = await fetch(`${backend}/v1/trees`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, 'the server listed the account\'s roadmaps');
  return (await response.json()).trees.map((tree) => tree.title ?? '');
}

// The files of a stored zip, as the export writes one, in its order.
function filesIn(bytes) {
  const files = [];
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    files.push({ name: bytes.toString('utf8', at + 30, at + 30 + nameLength), text: bytes.toString('utf8', at + 30 + nameLength, at + 30 + nameLength + size) });
    at += 30 + nameLength + size;
  }
  return files;
}

// A screenshot of what a device shows, for comparing with the boards, where WM_E2E_SHOTS names a folder; never printed.
async function shoot(device, name) {
  if (!process.env.WM_E2E_SHOTS) return;
  await device.page.evaluate(() => Promise.all([...document.querySelectorAll('.st-kept, .wm-decision')]
    .flatMap((layer) => layer.getAnimations({ subtree: true })).map((animation) => animation.finished)));
  await device.page.screenshot({ path: resolve(process.env.WM_E2E_SHOTS, `${name}.png`) });
}

async function scenarios(mode, browser, { secret, second, session, intake, empty, carrier, stranger, climber, lister, refused }, account, check) {
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

    if (mode === 'on') {
      await check('Settings’ export reads every roadmap from the device’s copy with no connection: a file each, with every step and mark', async () => {
        assert.ok(await a.storeUntil((store) => [sail, knot, row].every((tree) => rowsOf(store, 'confirmed', `tree/${tree}`).some((each) => each.t === 'node'))),
          'the device holds every roadmap of the account');
        await a.page.goto(`${origin}/app/settings`);
        const exportAll = a.page.getByRole('button', { name: 'Export my trees', exact: true });
        await exportAll.waitFor();
        await a.offline();
        const [download] = await Promise.all([a.page.waitForEvent('download'), exportAll.click()]);
        const files = filesIn(readFileSync(await download.path()));
        const lines = files.flatMap((file) => file.text.split('\n'));
        assert.deepEqual({ files: files.length, steps: lines.filter((line) => /^\s*- /.test(line)).length, marks: lines.filter((line) => /^\s*- \[x\] /.test(line)).length },
          { files: 3, steps: 7, marks: 1 }, 'the archive holds a file for each roadmap, every step and the one mark');
        await a.page.getByText('Exported 3 roadmaps.', { exact: true }).waitFor();
        await a.context.setOffline(false);
      });
      await a.board(address);
    }

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
        let trim = null;
        assert.ok(await a.storeUntil((store) => (trim = stepIn(store, sail, 'Trim the sail')) !== null), 'the device holds the step it links from');
        await a.offline();
        await b.board(address);
        await b.deleteStep('Trim the sail');
        assert.ok(await c.until(address, async () => await c.card('Trim the sail').count() === 0), 'the delete reached the server');
        await a.create('Ease the sheet', /Trim the sail/);
        await a.page.goto(`${origin}/#/app/roadmaps`);
        await a.page.locator('.st-roadmaps-row').first().waitFor();
        await a.context.setOffline(false);
        let ease = null;
        assert.ok(await a.storeUntil((store) => (ease = stepIn(store, sail, 'Ease the sheet')) !== null
          && spentIn(store, sail, trim) && stepIn(store, sail, 'Trim the sail') === null),
          'the new step reached the server after the delete, and the device holds the delete, the step\'s spent id alone');
        assert.deepEqual(notesIn(await a.store())[`landing:${sail}`], { nodes: [ease], edges: [[trim, ease]], revived: [], names: [{ id: trim, name: 'Trim the sail' }] },
          'the device\'s note holds the new step, its link, and the name of the step the link comes from');
        await a.page.reload();
        await a.board(address);
        await a.page.locator('.st-board-landed').waitFor({ timeout: 45_000 });
        assert.deepEqual(await a.landed(), [['Ease the sheet', 'Trim the sail was removed. This now follows Choose a course.']],
          'a room that never read the deleted step names it from the device\'s note');
        assert.ok(await a.storeUntil((store) => !(`landing:${sail}` in notesIn(store))), 'saying the line takes the note');
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
        await d.signOut();
        const ask = d.page.getByRole('dialog', { name: 'Sign out?', exact: true });
        await ask.getByRole('button', { name: 'Sign out', exact: true }).click();
        await ask.waitFor({ state: 'detached' });
        assert.ok(await d.storeUntil((store) => store.records.some(({ key, value }) => key.startsWith('["replica"') && value.state === 'dormant')
          && !headOf(store).signOut && !headOf(store).deviceCleanup), 'the sign-out finished with Keep and the products\' cleanup ran');
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
    });
    if (mode === 'on') await accountChoices(browser, { session, empty }, account, check, devices);
    else await todaysAccountChoices(browser, { secret, session }, check, devices);
    if (mode === 'on') await readersAndBirths(browser, { session, stranger, climber }, account, check, devices);
    await carryScenario(mode, browser, { session, carrier }, account, check, devices);
    await yourRoadmaps(mode, browser, { session, lister }, check, devices);
    await check('no device logged an error', async () => {
      assert.deepEqual(devices.flatMap((device) => device.errors), [], 'no page threw and no console logged an error');
    });
    if (mode === 'on') {
      await check('§7: with the switch on, no page asked the server for a route the move retires', async () => {
        assert.deepEqual(Object.fromEntries(refused), {}, 'the pages asked the server for none of them');
      });
    }
    await check(mode === 'on' ? 'as each person leaves, the intake holds the room’s events, with those only the switch emits'
      : 'as each person leaves, the intake holds the room’s events, and none of those only the switch emits', async () => {
      for (const device of devices) await device.page.goto('about:blank');
      const on = mode === 'on';
      const expected = {
        room: true,
        kept: on ? ['roadmap_kept', 'roadmap_write_cannot_land'] : [],
        carry: on ? ['carried', 'cleared', 'found'] : [],
        undo: on ? ['redo:applied', 'undo:applied'] : [],
        questions: on ? ['roadmap_signin:add', 'roadmap_signin:cancel', 'roadmap_signin:discard', 'roadmap_signin:shown',
          'roadmap_signout:discard', 'roadmap_signout:keep', 'roadmap_signout:shown'] : [],
        unshown: on ? ['missing', 'unkept'] : [],
        exported: on ? 1 : 0,
      };
      let arrived = intake();
      for (const end = Date.now() + 30_000; !isDeepStrictEqual(arrived, expected) && Date.now() < end; arrived = intake()) await settle(500);
      assert.deepEqual(arrived, expected, `the intake held ${JSON.stringify(arrived)}`);
    });
  } finally {
    for (const device of devices) await device.context.close();
  }
}

// What an owner's device that signs in as `account` with a fresh session pulls of the account, once `seen` holds of it or
// the bound passes: `read` of the device.
async function pulledFrom(session, account, seen, read) {
  const device = await OwnerDevice.open('account-reader', session(account), account);
  try {
    await device.engine.start();
    await device.pulled(() => seen(device));
    return read(device);
  } finally {
    device.engine.close();
  }
}

// §5 Signed out and flow 50, with the switch on: the sign-in and sign-out questions on a browser's own copy. Each browser
// signs in with a session of its own, as a sign-out or Escape ends the one it signed in with.
async function accountChoices(browser, { session, empty }, account, check, devices) {
  const owner = await OwnerDevice.open('flow-50-seed', session(account), account);
  let swim;
  try {
    swim = await owner.plant(new owner.domain.CreateRoadmap('Learn to swim', { steps: [{ key: 'float', label: 'Float on your back' }], links: [] }));
    await owner.engine.start();
    await owner.sent();
  } finally {
    owner.engine.close();
  }
  const titlesOf = (user, seen) => pulledFrom(session, user, (device) => seen(device.titles()), (device) => device.titles().sort());
  const steps = (seen) => pulledFrom(session, account, (device) => seen(device), (device) => ['Float on your back', 'Float face up', 'Float with a kick']
    .filter((label) => device.step(swim, label) !== null));

  await check('§5: a browser’s signed-out roadmap joins an account that holds none, and no question is asked', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.plantSignedOut([{ title: 'Learn to dive', steps: ['Hold your breath'] }]);
    await d.signIn(session(empty));
    const titles = await titlesOf(empty, (held) => held.includes('Learn to dive'));
    assert.deepEqual({ titles, shown: await d.page.evaluate(() => window.decisionsShown) }, { titles: ['Learn to dive'], shown: 0 },
      'the account holds the browser\'s roadmap, and no question was shown');
  });

  await check('§5, flow 50: a browser’s signed-out roadmaps meet an account that holds roadmaps; Add your roadmaps? names them, and Add takes both to the account', async () => {
    const d = await Device.signedOut(browser, { width: 1440, height: 960 });
    devices.push(d);
    await d.plantSignedOut([{ title: 'A quieter home', steps: [] }, { title: 'Learn to cook', steps: ['Boil an egg'] }]);
    await d.signIn(session(account));
    const { dialog, said } = await d.decision('Add your roadmaps?');
    assert.deepEqual(said, { lead: '2 roadmaps on this browser can join your account.', items: ['A quieter home', 'Learn to cook'],
      notes: ['Choosing Discard removes these browser roadmaps.'], answers: ['Discard', 'Add'] }, 'the question names both roadmaps, Discard before Add');
    await shoot(d, 'decision-1440-add');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const titles = await titlesOf(account, (held) => held.includes('A quieter home') && held.includes('Learn to cook'));
    assert.deepEqual(titles.filter((title) => ['A quieter home', 'Learn to cook'].includes(title)), ['A quieter home', 'Learn to cook'], 'Add took both roadmaps to the account');
  });

  await check('flow 50: on a phone the question is a page of its own, and Discard takes the roadmap from the browser without it reaching the account, with what the browser kept beside it', async () => {
    const d = await Device.signedOut(browser, { width: 390, height: 844 });
    devices.push(d);
    const [morning] = await d.plantSignedOut([{ title: 'A slower morning', steps: [] }]);
    await d.page.evaluate((tree) => {
      localStorage.setItem(`windmill:return:${tree}`, JSON.stringify({ completed: [], at: 1 }));
      localStorage.setItem(`windmill:milestones:${tree}`, JSON.stringify([]));
    }, morning);
    await d.signIn(session(account));
    const { dialog, said } = await d.decision('Add your roadmaps?');
    assert.deepEqual(said, { lead: '1 roadmap on this browser can join your account.', items: ['A slower morning'],
      notes: ['Choosing Discard removes this browser roadmap.'], answers: ['Add', 'Discard'] }, 'the page names the roadmap, Add over Discard');
    await shoot(d, 'decision-390-add');
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await d.storeUntil((store) => JSON.stringify(replicasIn(store)) === JSON.stringify([['anon', 0], ['bound', 0]])),
      'the browser holds nothing of the discarded roadmap');
    await d.page.waitForFunction((tree) => Object.keys(localStorage).every((key) => !key.endsWith(`:${tree}`)), morning, { timeout: 10_000 });
    const titles = await titlesOf(account, (held) => held.includes('Learn to swim'));
    assert.equal(titles.includes('A slower morning'), false, 'the discarded roadmap never reached the account');
  });

  await check('flow 50: Escape cancels the question: the account is signed out of the browser, and its signed-out roadmap stays there, unsent', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.plantSignedOut([{ title: 'Learn to knit', steps: [] }]);
    const token = session(account);
    await d.signIn(token);
    const { dialog } = await d.decision('Add your roadmaps?');
    await d.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await d.storeUntil((store) => JSON.stringify(replicasIn(store)) === JSON.stringify([['anon', 2]])
      && !headOf(store).pendingSignIn && !headOf(store).clearCredential), 'the browser keeps its roadmap unsent, with no sign-in pending and no cookie owed');
    const me = await fetch(`${backend}/v1/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(me.status, 401, 'the account\'s session on the browser ended');
  });

  // A sign-out with the connection cut after a change, its question read and screenshot, then `answer` chosen. The
  // browser comes back online and lets its cookie go before it signs in again with a new session, so the cleanup it owes
  // the old one cannot end the new one.
  const signOutWith = async (d, viewport, answer, shot) => {
    await d.signOut();
    if (viewport) await d.page.setViewportSize(viewport);
    const asked = await d.decision('Keep unsent changes?');
    await shoot(d, shot);
    await asked.dialog.getByRole('button', { name: answer, exact: true }).click();
    await asked.dialog.waitFor({ state: 'detached' });
    const left = await d.store();
    await d.context.setOffline(false);
    assert.ok(await d.storeUntil((store) => !headOf(store).clearCredential && !headOf(store).deviceCleanup), 'the sign-out let its cookie go once online');
    await d.signIn(session(account));
    return { said: asked.said, left: replicasIn(left) };
  };

  await check('§5, flow 50: a sign-out with a change unsent asks Keep unsent changes?, naming its roadmap; Keep holds it on the browser, and the next sign-in sends it', async () => {
    const d = await Device.open(browser, session(account), { width: 1440, height: 960 });
    devices.push(d);
    await d.board(`#/app/${swim}`);
    await d.offline();
    await d.rename('Float on your back', 'Float face up');
    const { said, left } = await signOutWith(d, null, 'Keep', 'decision-1440-keep');
    assert.deepEqual({ said, left }, {
      said: { lead: '1 change hasn’t reached your account.', items: ['Learn to swim · 1 change'],
        notes: ['Keep it for your next sign-in. Discard removes it from this browser.'], answers: ['Discard', 'Keep'] },
      left: [['anon', 0], ['dormant', 1]],
    }, 'the question names the roadmap and its change, and Keep left the account\'s replica on the browser with it');
    assert.deepEqual(await steps((device) => device.step(swim, 'Float face up') !== null), ['Float face up'], 'the next sign-in sent the change Keep held');
  });

  await check('flow 50: on a phone the sign-out question is a page of its own, and Discard takes the unsent change from the browser so it never reaches the account', async () => {
    const d = await Device.open(browser, session(account), { width: 1440, height: 960 });
    devices.push(d);
    await d.board(`#/app/${swim}`);
    await d.offline();
    await d.rename('Float face up', 'Float with a kick');
    const { said, left } = await signOutWith(d, { width: 390, height: 844 }, 'Discard', 'decision-390-keep');
    assert.deepEqual({ said, left }, {
      said: { lead: '1 change hasn’t reached your account.', items: ['Learn to swim · 1 change'],
        notes: ['Keep it for your next sign-in. Discard removes it from this browser.'], answers: ['Keep', 'Discard'] },
      left: [['anon', 0]],
    }, 'the page names the roadmap and its change, Keep over Discard, and Discard left no replica of the account\'s');
    assert.ok(await d.storeUntil((store) => JSON.stringify(replicasIn(store)) === JSON.stringify([['anon', 0], ['bound', 0]])),
      'the next sign-in found nothing of the discarded change to send');
    assert.deepEqual(await steps((device) => device.step(swim, 'Float face up') !== null), ['Float face up'], 'the discarded change never reached the account');
  });
}

// Flow 50's questions with the switch off: today's room claims a roadmap planted signed out at sign-in without a question,
// and asks the shell's plain question at a sign-out after a change made offline.
async function todaysAccountChoices(browser, { secret, session }, check, devices) {
  await check('today: a roadmap planted signed out is claimed at sign-in, and no question is asked', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.page.goto(`${origin}/#/app/new`);
    const name = d.page.getByRole('textbox', { name: 'Name your roadmap', exact: true });
    await name.fill('Learn to dive');
    await name.press('Enter');
    await d.page.waitForURL((url) => /^#\/app\/t_/.test(url.hash));
    await d.signIn(secret, new URL(d.page.url()).hash);
    const end = Date.now() + 45_000;
    while (!(await listedTitles(secret)).includes('Learn to dive') && Date.now() < end) await settle(1000);
    assert.deepEqual({ claimed: (await listedTitles(secret)).includes('Learn to dive'), shown: await d.page.evaluate(() => window.decisionsShown) },
      { claimed: true, shown: 0 }, 'the account holds the roadmap, and no question was shown');
  });

  await check('today: a sign-out after a change made offline asks the shell’s plain question', async () => {
    const response = await fetch(`${backend}/v1/trees`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ title: 'Learn to swim', nodes: [{ id: 'float', label: 'Float on your back', color: 'terracotta', prerequisites: [] }] }),
      signal: AbortSignal.timeout(10_000) });
    assert.ok(response.ok, 'the roadmap was planted');
    const { treeId } = await response.json();
    const d = await Device.open(browser, session());
    devices.push(d);
    await d.board(`#/app/${treeId}`);
    await d.offline();
    await d.create('Kick your legs');
    await d.signOut();
    const ask = d.page.getByRole('dialog', { name: 'Sign out?', exact: true });
    await ask.getByRole('button', { name: 'Sign out', exact: true }).click();
    await ask.waitFor({ state: 'detached' });
    assert.equal(await d.page.evaluate(() => window.decisionsShown), 0, 'no account decision was shown');
  });
}

// §5 A reader and Signed out, with the switch on. A stranger opens the owner's public roadmap and the subtree its step owns
// by their link, signed out and signed in: the room follows each tree scope as it opens it, the signed-in reader's own
// overlay with it (E-3) and the signed-out reader's none, and drops both as the person leaves. A private roadmap is in
// no address for them, and the browser keeps none of it. A browser that keeps nothing is shown the room's load error, as
// the web holds no replica in memory yet (E-5). A roadmap made signed out at the birth door lives in the browser's anon
// replica, the old stores untouched, and joins at sign-in an account that holds none, with no question.
async function readersAndBirths(browser, { session, stranger, climber }, account, check, devices) {
  const owner = await OwnerDevice.open('readers-seed', session(account), account);
  let year, sub, closed;
  try {
    const { CreateRoadmap, CreateSubtree, CreateStep, SetVisibility } = owner.domain;
    const made = await owner.write(new CreateRoadmap('A year at sea', { steps: [{ key: 'sail', label: 'Learn to sail' }, { key: 'bay', label: 'Cross the bay' }],
      links: [['sail', 'bay']] }));
    year = String(made.tree);
    sub = String((await owner.write(new CreateSubtree(year, made.steps.sail))).subtree);
    closed = await owner.plant(new CreateRoadmap('A private plan', { steps: [{ key: 'start', label: 'Keep it to myself' }], links: [] }));
    await owner.engine.start();
    await owner.sent();
    await owner.write(new CreateStep(sub, { label: 'Tie a bowline' }, []));
    await owner.write(new SetVisibility(year, 'public'));
    await owner.sent();
  } finally {
    owner.engine.close();
  }
  const NONE = { tree: false, overlay: false };
  // The stranger opens the roadmap by its link and goes into the subtree from its step's page; each roadmap's scopes are
  // followed on the live socket as the room opens it. Leaving for the journal drops them, where `leaves` asks it.
  const readsAndLeaves = async (d, overlay, leaves) => {
    devices.push(d);
    await d.board(`t/${year}`);
    await d.card('Cross the bay').waitFor();
    const opened = await d.followsUntil(year, { tree: true, overlay });
    const step = await d.openStep('Learn to sail');
    await step.getByRole('button', { name: 'Open subtree', exact: true }).click();
    await d.card('Tie a bowline').waitFor();
    const inside = await d.followsUntil(sub, { tree: true, overlay });
    assert.deepEqual({ opened, inside }, { opened: { tree: true, overlay }, inside: { tree: true, overlay } },
      'the room follows the roadmap and the subtree as the person opens each');
    if (!leaves) return;
    await d.page.locator('.wm-switch-btn[data-label="Journal"]').click();
    await d.page.waitForURL((url) => url.pathname === '/app/journal');
    assert.deepEqual({ year: await d.followsUntil(year, NONE), sub: await d.followsUntil(sub, NONE) }, { year: NONE, sub: NONE },
      'leaving drops both');
  };

  await check('§5: a stranger signed out opens a public roadmap by its link and goes into the subtree its step owns, each followed as it opens', async () => {
    await readsAndLeaves(await Device.signedOut(browser), false, false);
  });

  await check('§5, E-3: a stranger signed in reads it the same way, their own overlay followed with each roadmap, and leaving drops them all', async () => {
    await readsAndLeaves(await Device.open(browser, session(stranger)), true, true);
  });

  await check('§5: a stranger cannot read a private roadmap, signed out or signed in: the room says it cannot load it, and the browser keeps none of it', async () => {
    for (const d of [await Device.signedOut(browser), await Device.open(browser, session(stranger))]) {
      devices.push(d);
      await d.page.goto(`${origin}/t/${closed}`);
      await d.page.getByText('Couldn’t load this roadmap', { exact: false }).first().waitFor();
      const store = await d.store();
      assert.deepEqual({ rows: rowsOf(store, 'confirmed', `tree/${closed}`).length, words: holds(store, 'Keep it to myself') || holds(store, 'A private plan') },
        { rows: 0, words: false }, 'the browser holds nothing of the private roadmap');
    }
  });

  await check('E-5 is not built: a reader whose browser keeps nothing is shown the room’s load error for a public roadmap, and the bare roadmap door stays where it is', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }));
    await d.page.goto(`${origin}/t/${year}`);
    await d.page.getByText('Couldn’t load this roadmap', { exact: false }).first().waitFor();
    await d.page.goto(`${origin}/#/app`);
    await d.page.waitForURL((url) => url.pathname === '/app/roadmap');
    await settle(3000);
    assert.equal(new URL(d.page.url()).hash, '#/app', 'the door cannot say which roadmap is the person’s, so it sends them nowhere');
  });

  await check('§5 Signed out: a roadmap made at the birth door lives in the browser’s anon replica, the old stores untouched, and joins at sign-in an account that holds none, with no question', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.page.goto(`${origin}/#/app/new`);
    const name = d.page.getByRole('textbox', { name: 'Name your roadmap', exact: true });
    await name.fill('Learn to climb');
    await name.press('Enter');
    await d.page.waitForURL((url) => /^#\/app\/t_/.test(url.hash));
    const born = new URL(d.page.url()).hash;
    await d.board(born);
    await d.card('Learn to climb').waitFor();
    const store = await d.store();
    assert.deepEqual({ replicas: replicasIn(store).map(([state]) => state), held: holds(store, 'Learn to climb'), old: await d.old() },
      { replicas: ['anon'], held: true, old: NOTHING_OLD }, 'the anon replica holds the roadmap, and the old stores nothing');
    await d.signIn(session(climber), born);
    const titles = await pulledFrom(session, climber, (device) => device.titles().includes('Learn to climb'), (device) => device.titles());
    assert.deepEqual({ titles, shown: await d.page.evaluate(() => window.decisionsShown) }, { titles: ['Learn to climb'], shown: 0 },
      'the account holds the roadmap made signed out, and no question was shown');
  });
}

// §7, §8.4 The person's roadmaps where the home card, the landing and the room's switcher list them. With the switch on,
// every page of the run meeting the server as the move leaves it (`afterTheMove`), they are the device's copy's: the
// account's signed in and the browser's own signed out. With it off they are today's list signed in, and signed out it
// holds none. An account holds two roadmaps, the newer planted last; a browser signed out holds one.
async function yourRoadmaps(mode, browser, { session, lister }, check, devices) {
  const planted = [['Learn to sail', ['Choose a course']], ['Learn to row', ['Grip the oars', 'Pull together']]];
  const trees = [];
  if (mode === 'on') {
    const owner = await OwnerDevice.open('lister-seed', session(lister), lister);
    try {
      await owner.engine.start();
      for (const [title, steps] of planted) {
        trees.push(await owner.plant(new owner.domain.CreateRoadmap(title, { steps: steps.map((label) => ({ key: label, label })), links: [] })));
        await owner.sent();
        await settle(1100);
      }
    } finally {
      owner.engine.close();
    }
  } else {
    for (const [title, steps] of planted) {
      const response = await fetch(`${backend}/v1/trees`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session(lister)}` },
        body: JSON.stringify({ title, nodes: steps.map((label, index) => ({ id: `s${index}`, label, color: 'terracotta', prerequisites: [] })) }), signal: AbortSignal.timeout(10_000) });
      assert.ok(response.ok, 'the roadmap was planted');
      trees.push((await response.json()).treeId);
      await settle(1100);
    }
  }
  // What the home card, the landing and, where `room` names a roadmap, its room's switcher say once the home card's link
  // reads `link`: the card's link and line, the landing's offers and line, and each switcher row's name and line, with
  // how long ago a roadmap was tended said as `recently`.
  const recently = (text) => text.replace(/just now|\d+ minutes? ago|\d+m ago/, 'recently');
  const offered = async (d, link, room) => {
    await d.page.goto(`${origin}/app`);
    const card = d.page.locator('.wm-rhc');
    await card.locator('.wm-rhc-link', { hasText: link }).waitFor();
    const home = [await card.locator('.wm-rhc-link').innerText(), recently(await card.locator('.wm-rhc-body').innerText())];
    await d.page.goto(`${origin}/`);
    await d.page.locator('a[href="/roadmap"]').first().click();
    await d.page.waitForURL((url) => url.pathname === '/roadmap');
    const hero = d.page.locator('section', { has: d.page.locator('h1') }).first();
    await hero.getByRole('button', { name: link.replace(' →', ''), exact: true }).waitFor();
    const landing = { offers: await hero.getByRole('button').allInnerTexts(), line: recently(await hero.locator('.wrap > div').last().innerText()) };
    if (!room) return { home, landing };
    await d.board(`#/app/${room}`);
    await d.page.locator('.st-roadmap-switcher [aria-haspopup="menu"]').click();
    // Until its list arrives the switcher holds the open roadmap alone, as the room knows it, with no tag of where it lives.
    await d.page.waitForFunction(() => {
      const shown = [...document.querySelectorAll('.st-switcher-row')];
      return shown.length > 0 && shown.every((row) => row.querySelector('.st-switcher-tag'));
    });
    const rows = await d.page.locator('.st-switcher-row').evaluateAll((each) => each.map((row) => {
      const name = row.querySelector('span[title]');
      return [name.textContent, name.nextElementSibling.textContent];
    }));
    await d.page.keyboard.press('Escape');
    return { home, landing, switcher: rows.map(([name, line]) => [name, recently(line)]) };
  };
  const NONE_SIGNED_OUT = 'No account needed — your first tree lives in your browser.';

  await check(mode === 'on' ? '§7: with the routes the move retires refused, the home card, the landing and the switcher list the account’s roadmaps from the device’s copy, newest first'
    : 'today: the home card, the landing and the switcher list the account’s roadmaps from the server’s list, newest first', async () => {
    const d = await Device.open(browser, session(lister));
    devices.push(d);
    assert.deepEqual(await offered(d, 'Resume Learn to row →', trees[0]), {
      home: ['Resume Learn to row →', 'Learn to row · 0/2 done · last tended recently'],
      landing: { offers: ['Resume Learn to row', 'My trees'], line: 'Learn to row · 0/2 done · last tended recently' },
      switcher: [['Learn to row', '0 of 2 · recently · synced'], ['Learn to sail', '0 of 1 · recently · synced']],
    }, 'each lists the account’s roadmaps in today’s words');
  });

  if (mode === 'off') {
    await check('today: signed out, the home card and the landing offer a first roadmap, as the server lists nobody’s', async () => {
      const d = await Device.signedOut(browser);
      devices.push(d);
      assert.deepEqual(await offered(d, 'Start your tree →', null), {
        home: ['Start your tree →', NONE_SIGNED_OUT],
        landing: { offers: ['Start your tree', 'Try the live demo'], line: NONE_SIGNED_OUT },
      }, 'each offers a first roadmap');
    });
    return;
  }
  await check('§7: signed out, with the routes the move retires refused, the home card, the landing and the switcher list the browser’s own roadmap from its anon replica', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    const [swim] = await d.plantSignedOut([{ title: 'Learn to swim', steps: ['Float on your back'] }]);
    assert.deepEqual(await offered(d, 'Resume Learn to swim →', swim), {
      home: ['Resume Learn to swim →', 'Learn to swim · 0/1 done'],
      landing: { offers: ['Resume Learn to swim', 'My trees'], line: 'Learn to swim · 0/1 done' },
      switcher: [['Learn to swim', '0 of 1 · on this device']],
    }, 'each lists the browser’s roadmap in today’s words');
  });
}

// What the last old bundle wrote in a browser (roadmap-on-the-engine.md §8.2): its own code, run here over a stand-in
// browser's storage, offline, and read back as the browser keeps it: the sync database's records and the storage's keys.
async function oldBundle(write) {
  const { IDBFactory } = await import('fake-indexeddb');
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => (Object.hasOwn(storage, key) ? storage[key] : null) },
    setItem: { value: (key, value) => { storage[key] = String(value); } },
    removeItem: { value: (key) => { delete storage[key]; } },
    key: { value: (index) => Object.keys(storage)[index] ?? null },
    length: { get: () => Object.keys(storage).length },
  });
  const listening = { addEventListener() {}, removeEventListener() {} };
  const stand = { indexedDB: new IDBFactory(), localStorage: storage, window: { localStorage: storage, ...listening }, document: { visibilityState: 'visible', ...listening },
    WebSocket: class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} },
    fetch: async () => { throw new TypeError('the old bundle runs offline'); } };
  const prior = Object.fromEntries(Object.keys(stand).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(stand)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const old = { ...await source('src/products/roadmap/sync/localTrees.js'), ...await source('src/products/roadmap/sync/SyncSession.js'),
      ...await source('src/products/roadmap/persistence/WorkspaceStore.js'), ...await source('src/products/roadmap/model/NodeWorkspace.js'),
      ...await source('src/products/roadmap/model/Legend.js') };
    const id = await write(old);
    const database = await new Promise((done, fail) => {
      const request = indexedDB.open('windmill-sync');
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    const all = (method) => new Promise((done, fail) => {
      const request = database.transaction('trees').objectStore('trees')[method]();
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    const [keys, values] = [await all('getAllKeys'), await all('getAll')];
    database.close();
    return { id, records: keys.map((key, index) => [key, values[index]]), storage: { ...storage } };
  } finally {
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

// A roadmap the old bundle planted with nobody signed in, its first step marked in its room, a workspace on it and a mark
// left undrained on the second.
const plantedSignedOut = () => oldBundle(async ({ bearImportedTree, SyncSession, WorkspaceStore, DEFAULT_KINDS, addSubtask, emptyWorkspace, setNote }) => {
  globalThis.window.wmDeviceConfirmation = { owner: null };
  const id = await bearImportedTree({ title: 'Learn to swim', kinds: DEFAULT_KINDS, nodes: [
    { id: 'float', label: 'Float on your back', color: 'olive', prerequisites: [] },
    { id: 'kick', label: 'Kick from the hips', color: 'terracotta', prerequisites: ['float'] },
  ] });
  const room = new SyncSession({ treeId: id, title: 'Learn to swim' });
  await room.start();
  room.markProgress(['float'], 'complete');
  await room.persistNow();
  room.close();
  new WorkspaceStore().save(id, { float: setNote(addSubtask(emptyWorkspace(), 'Relax the neck'), 'Breathe out through the nose.') });
  globalThis.window.localStorage.setItem(`windmill:progress:${id}`, JSON.stringify({ completed: ['kick'], completedAt: { kick: 1_700_000_000_000 } }));
  return id;
});

const NOTHING_OLD = { records: 0, rows: 0, keys: 0 };

// §8.2 on a browser holding old stores: with the switch on, one signed out and then signed in as an account that holds no
// roadmaps (so its anonymous work joins without a question), and one signed in whose roadmap kept changes it never sent;
// with the switch off, a browser whose old stores nothing changes.
async function carryScenario(mode, browser, { session, carrier }, account, check, devices) {
  const signedOut = await plantedSignedOut();
  if (mode === 'off') {
    await check('§8.2 with the switch off: a browser holding the old bundle’s stores keeps them as they are', async () => {
      const d = await Device.signedOut(browser);
      devices.push(d);
      await d.holdOld(signedOut);
      const before = await d.old();
      await d.page.goto(`${origin}/app`);
      await settle(6000);
      assert.deepEqual({ before, after: await d.old(), ledger: holds(await d.store(), '"carry:') },
        { before: { records: 1, rows: 1, keys: 2 }, after: { records: 1, rows: 1, keys: 2 }, ledger: false }, 'the old stores stand untouched and no ledger is written');
    });
    return;
  }

  await check('§8.2 signed out, then signed in: a roadmap made signed out, its marks and its workspace are carried, and its old stores go once a sign-in adds it to the account and the server takes it', async () => {
    const d = await Device.signedOut(browser);
    devices.push(d);
    await d.holdOld(signedOut);
    await d.page.goto(`${origin}/app`);
    assert.ok(await d.storeUntil((anon) => holds(anon, 'Float on your back') && holds(anon, 'Relax the neck')), 'the anon replica holds the roadmap and its workspace');
    await settle(2000);
    assert.deepEqual(await d.old(), { records: 1, rows: 1, keys: 2 }, 'signed out, the old stores stay until the server takes the roadmap');
    await d.signIn(session(carrier));
    const phone = await OwnerDevice.open('carrier', session(carrier), carrier);
    try {
      await phone.engine.start();
      const { Id, StepMark, StepNote, Subtask } = phone.domain;
      const tree = signedOut.id;
      const carried = await phone.pulledWithin(45_000, () => phone.step(tree, 'Float on your back') !== null && phone.step(tree, 'Kick from the hips') !== null
        && phone.overlay(tree, (read) => ['float', 'kick'].every((step) => read.repository(StepMark).find(new Id(step, StepMark), 'drawn')?.status === 'complete'))
        && phone.overlay(tree, (read) => read.repository(Subtask).all('drawn').some((subtask) => subtask.label === 'Relax the neck')
          && read.repository(StepNote).find(new Id('float', StepNote), 'drawn')?.text === 'Breathe out through the nose.'));
      assert.ok(carried, 'once signed in, the account’s other device holds the roadmap under its id, both marks, the subtask and the note');
    } finally {
      phone.engine.close();
    }
    assert.ok(await d.oldUntil((held) => JSON.stringify(held) === JSON.stringify(NOTHING_OLD)), 'the old stores went once the server took the roadmap');
  });

  await check('§8.2 signed in: changes the browser had not sent are carried after the roadmap’s first pull and reach the server, and the old stores go', async () => {
    const owner = await OwnerDevice.open('diver', session(account), account);
    try {
      const { CreateRoadmap, Id, StepMark, Subtask } = owner.domain;
      const planted = await owner.runner.runAct(new CreateRoadmap('Learn to dive', { steps: [{ key: 'breathe', label: 'Breathe in' }, { key: 'sink', label: 'Sink down' }],
        links: [['breathe', 'sink']] }));
      assert.equal(planted.kind, 'committed', 'the roadmap was planted');
      await owner.engine.start();
      await owner.sent();
      const { tree, steps } = planted.result;
      const unsent = await oldBundle(async ({ SyncSession, WorkspaceStore, DEFAULT_KINDS, addSubtask, emptyWorkspace }) => {
        globalThis.window.wmDeviceConfirmation = { owner: account };
        const at = '1700000000000:0:server';
        const room = new SyncSession({ treeId: tree, title: 'Learn to dive' });
        await room.start();
        room.receiveState({ t: 'subgraph', intent: 'graft', seq: 3, reach: 'writer', title: { v: 'Learn to dive', at },
          nodes: [{ id: steps.breathe, createdAt: at, label: 'Breathe in', labelAt: at, order: 'a0', orderAt: at },
            { id: steps.sink, createdAt: at, label: 'Sink down', labelAt: at, order: 'a0', orderAt: at }],
          edges: [{ from: steps.breathe, to: steps.sink, addedAt: at }],
          kinds: DEFAULT_KINDS.map((kind, rank) => ({ id: kind.id, createdAt: at, hue: kind.hue, hueAt: at, label: kind.label, labelAt: at,
            description: kind.description, descriptionAt: at, rank, rankAt: at })) });
        room.receiveProgressGraft({ marks: [] });
        room.dispatch({ kind: 'RenameNode', id: steps.breathe, label: 'Breathe in slowly' });
        room.dispatch({ kind: 'CreateNode', id: 'hold', label: 'Hold your breath', prerequisites: [steps.breathe] });
        room.markProgress([steps.breathe], 'complete');
        await room.persistNow();
        room.close();
        new WorkspaceStore().save(tree, { [steps.breathe]: addSubtask(emptyWorkspace(), 'Count to four') });
        return tree;
      });
      const d = await Device.open(browser, session(account));
      devices.push(d);
      await d.holdOld(unsent);
      await d.page.goto(`${origin}/app`);
      assert.ok(await d.oldUntil((held) => held.records === 0 && held.keys === 0), 'the old stores went once carried');
      const carried = await owner.pulledWithin(45_000, () => owner.step(tree, 'Breathe in slowly') === steps.breathe && owner.step(tree, 'Hold your breath') !== null
        && owner.overlay(tree, (read) => read.repository(StepMark).find(new Id(steps.breathe, StepMark), 'drawn')?.status === 'complete')
        && owner.overlay(tree, (read) => read.repository(Subtask).all('drawn').some((subtask) => subtask.label === 'Count to four')));
      assert.ok(carried, 'another device of the account holds the rename, the new step, the mark and the subtask');
    } finally {
      owner.engine.close();
    }
  });
}

// One run: its database and owner, the server with the engine as the mode says, the app built with the switch as it
// says and served on the given port; the scenarios; then everything it started stopped and dropped.
async function run(mode, browser) {
  const database = `${prefix}roadmap_replica_${mode}_${process.pid}`;
  const url = `postgresql:///${database}?host=${encodeURIComponent(host)}`;
  const account = randomUUID();
  const empty = randomUUID();
  const carrier = randomUUID();
  const stranger = randomUUID();
  const climber = randomUUID();
  const lister = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const second = randomBytes(24).toString('hex');
  const sql = (statement) => execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], { stdio: ['ignore', 'pipe', 'pipe'] });
  // What the intake holds of the room's events, as bounded labels and counts, never an id or a person's words: whether
  // any came, the kept list's, the carry-over's stages, what Undo and Redo came to, each step of the sign-in and sign-out
  // questions, why a room could not show its roadmap, and Settings' exports once it had a connection again.
  const labels = (statement) => execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(Boolean).sort();
  const intake = () => ({
    room: labels("select count(*) > 0 from events where name like 'roadmap_%'")[0] === 't',
    kept: labels("select distinct name from events where name in ('roadmap_kept', 'roadmap_write_cannot_land')"),
    carry: labels("select distinct props->>'stage' from events where name = 'roadmap_carry' and props->>'stage' in ('carried', 'cleared', 'discarded', 'found')"),
    undo: labels("select distinct (props->>'action') || ':' || (props->>'outcome') from events where name = 'roadmap_undo'"),
    questions: labels("select distinct name || ':' || (props->>'step') from events where name in ('roadmap_signin', 'roadmap_signout')"),
    unshown: labels("select distinct props->>'outcome' from events where name = 'roadmap_load' and props->>'outcome' in ('missing', 'unkept')"),
    exported: Number(labels("select count(*) from events where name = 'roadmap_export' and props->>'door' = 'settings' and props->>'outcome' = 'done'")[0]),
  });
  // A new session of `user`, the owner by default, whose secret a browser or a device signs in with.
  const session = (user = account) => {
    const token = randomBytes(24).toString('hex');
    sql(`insert into sessions(token_hash,user_id,expires_ms) values('${hash(token)}','${user}',99999999999999);`);
    return token;
  };
  let server, web, moved, created = false, passed = 0;
  const refused = new Map();
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
    sql(`insert into users(id,email,name) values('${account}','web-roadmap@example.com','Web Roadmap'),('${empty}','web-roadmap-empty@example.com','Web Roadmap Empty'),('${carrier}','web-roadmap-carry@example.com','Web Roadmap Carry'),('${stranger}','web-roadmap-stranger@example.com','Web Roadmap Stranger'),('${climber}','web-roadmap-climb@example.com','Web Roadmap Climb'),('${lister}','web-roadmap-list@example.com','Web Roadmap List'); insert into sessions(token_hash,user_id,expires_ms) values('${hash(secret)}','${account}',99999999999999),('${hash(second)}','${account}',99999999999999);`);
    const dist = resolve(scratch, `dist-${mode}`);
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: process.cwd(), env: { ...process.env, VITE_ROADMAP_REPLICA_ROOM: mode === 'on' ? 'on' : '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    server = launch(resolve(binaries, 'windmill_server'), [], { cwd: resolve(repo, 'backend'), env: { ...process.env, DATABASE_URL: url,
      PORT: String(backendPort), WINDMILL_HOST: '127.0.0.1', WINDMILL_APP_URL: origin, WINDMILL_ALLOWED_ORIGINS: origin,
      ROADMAP_ENGINE_ENABLED: mode === 'on' ? '1' : '',
      RESEND_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JOURNAL_EMBEDDER_URL: '', SENTRY_DSN: '', AMPLITUDE_API_KEY: '' } });
    moved = mode === 'on' ? await afterTheMove(refused) : null;
    const served = moved ? `http://127.0.0.1:${moved.address().port}` : backend;
    web = launch(process.execPath, ['scripts/serve-built.mjs', '--root', dist, '--port', String(webPort), '--backend', served, '--duration', '1200'], { cwd: process.cwd() });
    await Promise.all([waitForServer(`${backend}/v1/me`, server), waitForServer(origin, web)]);
    await scenarios(mode, browser, { secret, second, session, intake, empty, carrier, stranger, climber, lister, refused }, account, check);
    return passed;
  } finally {
    if (web) { stopPort(webPort); web.kill('SIGTERM'); }
    if (server) { stopPort(backendPort); server.kill('SIGTERM'); }
    if (moved) { moved.closeAllConnections(); moved.close(); }
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
  assert.deepEqual({ on, off }, { on: 29, off: 12 }, 'every scenario of both runs must finish');
  console.log(`Roadmap replica local-stack e2e: ${on} passed with both switches on, ${off} with both off; local event intake verified`);
} catch (error) {
  log.write(`\n${error?.stack ?? error}\n${error instanceof assert.AssertionError ? inspect({ actual: error.actual, expected: error.expected }, { depth: 6 }) : ''}\n`);
  console.error(error instanceof assert.AssertionError && !error.generatedMessage ? error.message : `${error?.name ?? 'Error'}, its message in the stack log`);
  console.error(`Stack diagnostics: ${logPath}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  log.end();
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
