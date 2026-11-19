// The room on the device's copy against the room as it reads today, in Chromium: the real browser engine syncs with the
// JavaScript reference server under roadmap's binding, served by this test; today's room reads the same roadmap over
// its HTTP routes and its own session. Both must show the same screens and emit the same events.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { RoadmapProduct } from '../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { beacon, boardColumns } from './browserFixture.js';
import { scene } from './skillTreeViewHost.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryJson = readFileSync(new URL('../../../../packages/api-contract/sync/roadmap.registry.json', import.meta.url), 'utf8');
const registry = new Registry(JSON.parse(registryJson));
const TREE = 't_5a11000000000001';
const KNOT = 't_5a11000000000002';
const GENESIS = [['build', 'terracotta', 'Build', 'Things you make', 'a0'], ['learn', 'olive', 'Learn', 'Things you figure out', 'a1'],
  ['milestone', 'gold', 'Milestone', 'Moments that matter', 'a2']];
const STEPS = [['course', 'Choose a course', []], ['wind', 'Read the wind', ['course']], ['dock', 'Leave the dock', ['wind']]];

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Registry } from '${root}../packages/api-contract/sync/reference/core/registry.js';
import { HttpTransport } from '/src/platform/sync/transport.js';
import { syncSession } from '/src/platform/sync/session.js';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
import { SyncStore } from '/src/products/roadmap/sync/SyncStore.js';
import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
import { YourRoadmaps } from '/src/products/roadmap/identity/YourRoadmaps.jsx';
import { readNavigation, subscribeNavigation } from '/src/shell/navigation.js';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { StepDraftProvider, StepDraftNotice } from '/src/products/roadmap/step/StepDraftProvider.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { stepDraftSession } from '/src/products/roadmap/step/StepDraftSession.js';
import { getRoomStatus } from '/src/shell/roomStatus.js';
import { ActionRunner, EngineReplica } from '/src/platform/domain-kit/runner.js';
import { FixedZone } from '/src/platform/domain-kit/time.js';
import { ChangeStep } from '/src/products/roadmap/domain/steps.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
const account = params.get('account');
const tree = ${JSON.stringify(TREE)};
Object.assign(window, { events: [], issues: [], syncFailures: [], ceremonies: [], revealed: [], revealFrames: [], cameraCalls: [], roomStatus: getRoomStatus });
// The device's connection, cut from the start with \`offline\` and at any moment by \`connect(false)\`, as the browser tells
// it: the engine hears the browser go offline and stops its sync, and the transport answers nothing while it is cut. The
// room's own files still load.
let online = !params.has('offline');
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
window.connect = (state) => {
  online = state;
  window.dispatchEvent(new Event(state ? 'online' : 'offline'));
};
// Today's room: its own session stands on the roadmap the server answers, the owner's marks set as the server holds them.
SyncSession.prototype.start = async function () {
  this.store = new SyncStore();
  this.scheduleReconnect = () => {};
  this.forceReconnect = () => {};
  this.registry = null;
  this.seed(window.served);
  if (account === 'u_owner') this.markProgress(['course'], 'complete');
  this.phase = 'live';
  this.ackedServerVector = this.lattice.frontier();
  this.receiveState({ ...this.lattice.toFrame(), seq: 1, reach: account === 'u_owner' ? 'writer' : 'reader' });
  this.receiveProgressGraft(this.progress.toFrame());
  this.ready = false;
  await this.persistNow();
  this.ready = true;
  this.emitTree();
  this.emitStatus();
};
const boot = crypto.randomUUID();
const transport = new HttpTransport({ schema: 13, base: '', reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot }),
  socket: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  fetch: (url, options) => (online ? fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-account': account ?? '' } })
    : Promise.reject(new TypeError('Failed to fetch'))) });
const engine = await syncSession.open({ registry: new Registry(${registryJson}), transport, appVersion: '1',
  credentials: { clear: async () => {} }, telemetry: { event() {}, failure(operation) { window.syncFailures.push(operation); } } });
window.engine = engine;
// The domain's change of a step on this device's engine, as the room's save runs it.
window.changeStep = async (tree, step, changes) => (await new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0))
  .runAct(new ChangeStep(tree, step, changes))).kind;
if (account && engine.device.activeReplica.meta.state !== 'bound') await engine.signIn(account);
syncSession.publish({ signedIn: Boolean(account) });
if (params.has('seed')) {
  await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: tree }]);
  await engine.commit('tree/' + tree, [
    { op: 'write', t: 'meta', id: 'meta', f: { title: 'Learn to sail', visibility: 'public' } },
    ...${JSON.stringify(GENESIS)}.map(([id, hue, label, description, ord]) => ({ op: 'create', t: 'kind', id, f: { hue, label, description, ord } })),
    ...${JSON.stringify(STEPS)}.map(([id, label]) => ({ op: 'create', t: 'node', id, f: { label, ord: 'a0' } })),
    ...${JSON.stringify(STEPS)}.flatMap(([id, , after]) => after.map((from) => ({ op: 'put', t: 'edge', id: [from, id] }))),
  ], { atomic: true });
  await engine.commit('self/overlay/' + tree, [{ op: 'write', t: 'progress', id: 'course', f: { mark: { status: 'complete', outOfOrder: false } } }]);
  for (let turn = 0; engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked') || !engine.device.activeReplica.confirmedRows('tree/' + tree).length; turn++) {
    if (turn === 200) throw new Error('the seed never settled');
    await new Promise((settle) => setTimeout(settle, 50));
  }
}
if (params.has('knot')) {
  await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: ${JSON.stringify(KNOT)} }]);
  await engine.commit('tree/' + ${JSON.stringify(KNOT)}, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Learn to knot' } },
    { op: 'create', t: 'node', id: 'bowline', f: { label: 'Tie a bowline', ord: 'a0' } }], { atomic: true });
}
window.served = await (await fetch('/v1/trees/' + tree)).json().then((body) => body.data);
const scope = new DocumentDataScope({ invalidate: () => stepDraftSession(document, { create: false })?.invalidate() });
scope.reconcile(engine);
// The route table's share of the host: the person's roadmaps at their address, any other roadmap's room at its own.
function Host() {
  const [hash, setHash] = React.useState(() => readNavigation().hash);
  React.useEffect(() => subscribeNavigation(() => setHash(readNavigation().hash)), []);
  const path = hash.split('?')[0];
  if (path === '#/app/roadmaps') return React.createElement(YourRoadmaps);
  const shown = path.startsWith('#/app/') ? path.slice('#/app/'.length) : tree;
  return React.createElement(SkillTreeView, { key: shown, treeId: shown, replica: params.get('replica') === 'on' });
}
createRoot(document.getElementById('root')).render(React.createElement(ProductSessions, {
  dataScope: scope.read, products: [{ session: { Provider: StepDraftProvider, Notice: StepDraftNotice } }],
}, React.createElement(Host)));
`;

const auth = `
const account = new URLSearchParams(location.search).get('account');
export const useAuth = () => ({ status: account ? 'signed-in' : 'ghost', user: account ? { name: 'Ada' } : null,
  account: account ? { id: account } : null, confirmed: true, lapsed: false, refresh: async () => null });
`;

const plugin = { name: 'roadmap-replica-host', enforce: 'pre',
  resolveId(id) {
    if (id === '/replica-host-entry.js') return '\0replica-entry';
    if (id.endsWith('/scene/SkillTreeScene.js')) return '\0replica-scene';
    if (id.endsWith('/shell/auth/AuthProvider.jsx')) return '\0replica-auth';
    if (id.endsWith('/shell/auth/SignInDoor.jsx')) return '\0replica-signin';
    if (id.endsWith('/telemetry/beacon.js')) return '\0replica-events';
    if (id.endsWith('/telemetry/sentry.js')) return '\0replica-issues';
  },
  load(id) {
    if (id === '\0replica-entry') return entry;
    if (id === '\0replica-scene') return scene;
    if (id === '\0replica-auth') return auth;
    if (id === '\0replica-signin') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
    if (id === '\0replica-events') return beacon;
    if (id === '\0replica-issues') return 'export function captureError(product, operation) { window.issues.push(operation); }';
  },
};

const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development', plugins: [plugin],
  build: { write: false, minify: false, sourcemap: false, cssCodeSplit: false, modulePreload: false, target: 'es2022',
    rollupOptions: { input: '/replica-host-entry.js', output: { entryFileNames: 'host-entry.js' } } } });
const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
const stylesheet = [...files.keys()].find((path) => path.endsWith('.css'));

// The model server: roadmap's records as the engine's reference server keeps them, and today's routes over the same
// roadmap. The owner's marks are what both rooms show a reader.
let state = null;
const product = new RoadmapProduct();
const served = { id: TREE, title: 'Learn to sail', kinds: GENESIS.map(([id, hue, label, description]) => ({ id, hue, label, description })),
  nodes: STEPS.map(([id, label, prerequisites]) => ({ id, label, color: 'terracotta', order: 'a0', prerequisites })) };
const http = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/v1/sync/')) {
    const account = request.headers['x-fixture-account'] || null;
    const endpoint = url.pathname.slice('/v1/sync/'.length);
    let text = '';
    for await (const chunk of request) text += chunk;
    const serverNow = Date.now();
    if (endpoint === 'hello') {
      const answer = hello({ state, registry, account, serverTime: serverNow });
      return json(answer.status, answer.body);
    }
    const out = (endpoint === 'push' ? push : pull)({ state, registry, product, account, request: JSON.parse(text), serverNow });
    state = out.state;
    return json(out.response.status, out.response.body);
  }
  if (url.pathname === `/v1/trees/${TREE}`) {
    const mine = request.headers.cookie?.includes('owner') ?? false;
    return json(200, { data: served, root: TREE, parent: null, path: [], depth: 0, mine, visibility: 'public' });
  }
  if (url.pathname === `/v1/trees/${TREE}/progress`) return json(200, { marks: [{ node: 'course', status: 'complete', at: `${Date.now()}:0:srv` }] });
  if (url.pathname.endsWith('/activity')) return json(200, { events: [] });
  if (url.pathname.endsWith('/guides')) return json(200, { guides: [] });
  if (url.pathname.startsWith('/v1/')) return json(200, {});
  if (url.pathname === '/room') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"><div id="root" style="height:100vh"></div><script type="module" src="/host-entry.js"></script>`);
    return;
  }
  const file = files.get(url.pathname) ?? (() => {
    const path = join(root, 'public', url.pathname);
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
  })();
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(url.pathname)] ?? 'application/octet-stream' });
  response.end(file);
});
await new Promise((listening) => http.listen(0, '127.0.0.1', listening));
const origin = `http://127.0.0.1:${http.address().port}`;
const browser = await chromium.launch({ headless: true });
// A context of the test's, each page's CPU slowed by WM_TEST_CPU_THROTTLE (as 6) where it is set, to stand as a slow CI
// runner does.
async function newContext(options) {
  const context = await browser.newContext(options);
  const rate = Number(process.env.WM_TEST_CPU_THROTTLE ?? 0);
  if (rate > 1) context.on('page', (page) => context.newCDPSession(page).then((cdp) => cdp.send('Emulation.setCPUThrottlingRate', { rate })));
  return context;
}
after(async () => {
  await browser.close();
  http.close();
});

// A room opened and read: what its row says, its Board's columns, the open step's page, the room's status line and every
// event it emitted. `account` is who is signed in, `address` the room's hash.
async function readRoom(context, { account, replica, address, seed = false, offline = false }) {
  if (account === 'u_owner') await context.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  const params = new URLSearchParams({ account, replica: replica ? 'on' : 'off' });
  if (seed) params.set('seed', '1');
  if (offline) params.set('offline', '1');
  await page.goto(`${origin}/room?${params}${address}`);
  await page.locator('.st-roadmap-progress').waitFor();
  if (await page.getByRole('button', { name: 'Board', exact: true }).getAttribute('aria-pressed') !== 'true') {
    await page.getByRole('button', { name: 'Board', exact: true }).click();
  }
  await page.locator('[data-column]').first().waitFor();
  const row = await page.locator('.st-roadmap-identity').innerText();
  const columns = await boardColumns(page);
  await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).click();
  const step = await page.getByRole('article', { name: 'Read the wind', exact: true }).innerText();
  const read = await page.evaluate(() => ({ status: window.roomStatus(), events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`),
    issues: window.issues, syncFailures: window.syncFailures }));
  await page.close();
  return { row, columns, step, ...read, failures };
}

test('an owner’s roadmap opens from the replica, and again from the device’s copy offline, with the screens and events of today’s room', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    const online = await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const fromCopy = await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, offline: true });
    const lattice = await readRoom(today, { account: 'u_owner', replica: false, address: `#/app/${TREE}` });
    assert.deepEqual(online.columns, ['locked: Leave the dock', 'upNext: Read the wind', 'done: Choose a course']);
    assert.deepEqual(lattice.failures, []);
    assert.deepEqual(online, lattice);
    assert.deepEqual(fromCopy, { ...online, status: { line: 'Offline · changes will sync', short: 'Offline', icon: 'offline', narrow: 'icon', connectivity: 'offline' },
      events: [...online.events.slice(0, 1), 'roadmap_sync_offline {"step":"shown","pending":"0"}', ...online.events.slice(1)] });
  } finally {
    await replica.close();
    await today.close();
  }
});

test('a signed-in reader opens a shared roadmap from the replica as they do today: its owner’s marks, the reader’s verbs', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const owner = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const replica = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(owner, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const shared = await readRoom(replica, { account: 'u_reader', replica: true, address: `#/t/${TREE}` });
    const lattice = await readRoom(today, { account: 'u_reader', replica: false, address: `#/t/${TREE}` });
    assert.deepEqual(shared.columns, ['locked: Leave the dock', 'upNext: Read the wind', 'done: Choose a course']);
    assert.deepEqual(shared, { ...lattice, failures: [] });
  } finally {
    await owner.close();
    await replica.close();
    await today.close();
  }
});

// The rows the reference server holds of every scope whose key names `part`, as it stands after the last push.
const serverRows = (part) => Object.entries(state.rows).filter(([key]) => key.includes(part)).flatMap(([, rows]) => Object.values(rows));

async function reachesServer(check) {
  for (let turn = 0; turn < 600; turn++) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  throw new Error('the write never reached the server');
}

// One owner's script on a room: open a step, complete it and add it a subtask, then what the room shows and told. A room
// whose writes are to reach the server (`landed`) stays open until they have: its device sends them.
async function markAndNote(context, { replica, landed = null }) {
  await context.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(`${origin}/room?account=u_owner&replica=${replica ? 'on' : 'off'}#/app/${TREE}`);
  await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).click();
  const step = page.getByRole('article', { name: 'Read the wind', exact: true });
  await step.getByRole('button', { name: 'Complete', exact: true }).click();
  await page.locator('[data-column="done"] .st-board-card-title', { hasText: 'Read the wind' }).waitFor();
  await step.getByRole('button', { name: 'Add subtask', exact: true }).click();
  await page.keyboard.type('Check the forecast');
  await page.keyboard.press('Enter');
  await step.getByText('Check the forecast', { exact: true }).waitFor();
  // The pointer leaves the step's buttons, so no hover preview stands in what is read.
  await page.mouse.move(0, 0);
  await page.locator('.st-board-step-preview').waitFor({ state: 'detached' });
  const read = { columns: await boardColumns(page), step: await step.innerText(),
    ...await page.evaluate(() => ({ events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues })), failures };
  if (landed) await reachesServer(landed);
  await page.close();
  return read;
}

test('with the switch on the owner’s marks and workspace land on the device’s copy, with the screens and events of today’s room', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await markAndNote(replica, { replica: true, landed: () => serverRows(`overlay/${TREE}`).some((row) => row.t === 'progress' && row.id === 'wind')
      && serverRows(`overlay/${TREE}`).some((row) => row.t === 'subtask') });
    const lattice = await markAndNote(today, { replica: false });
    assert.deepEqual(onCopy.columns, ['locked: ', 'upNext: Leave the dock', 'done: Read the wind, Choose a course']);
    assert.deepEqual(onCopy, lattice);
  } finally {
    await replica.close();
    await today.close();
  }
});

// One owner's script of step gestures on a room: a new step and its toast's Undo, a new step undone and redone by the
// keyboard, a held delete undone in its hold, and one written once its toast has stood the nine-second hold, then undone by
// the keyboard. The room on the device's copy tells what each Undo and Redo of a written act came to once the engine knows,
// so the script goes on from one once it is told. A room whose writes are to reach the server (`landed`) stays open until
// they have.
async function makeAndTakeBack(context, { replica, landed = null }) {
  await context.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(`${origin}/room?account=u_owner&replica=${replica ? 'on' : 'off'}#/app/${TREE}`);
  const card = (label) => page.locator('.st-board-card-title', { hasText: label });
  const toastUndo = () => page.locator('.st-board-toast').getByRole('button', { name: 'Undo', exact: true });
  const keys = async (combination) => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(combination);
  };
  const told = async (count) => {
    if (replica) await page.waitForFunction((count) => window.events.filter(({ name }) => name === 'roadmap_undo').length === count, count);
  };
  const create = async (label) => {
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
    const composer = page.getByRole('dialog', { name: 'New step', exact: true });
    await composer.locator('input').first().fill(label);
    await composer.getByRole('button', { name: 'Create step', exact: true }).click();
    await card(label).waitFor();
  };
  const remove = async (label) => {
    await card(label).click();
    await page.locator('.st-board-step-layer').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete step' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await card(label).waitFor({ state: 'detached' });
  };
  await card('Read the wind').waitFor();
  await create('Tie a bowline');
  await toastUndo().click();
  await card('Tie a bowline').waitFor({ state: 'detached' });
  await told(1);
  await create('Reef the sail');
  await keys('ControlOrMeta+z');
  await card('Reef the sail').waitFor({ state: 'detached' });
  await told(2);
  await keys('ControlOrMeta+Shift+z');
  await card('Reef the sail').waitFor();
  await told(3);
  await remove('Leave the dock');
  await toastUndo().click();
  await card('Leave the dock').waitFor();
  await remove('Leave the dock');
  await page.locator('.st-board-toast').waitFor();
  await page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_board_delete' && props.step === 'sent'));
  const released = await boardColumns(page);
  await keys('ControlOrMeta+z');
  await card('Leave the dock').waitFor();
  await told(4);
  const read = { released, columns: await boardColumns(page),
    ...await page.evaluate(() => ({ events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues })), failures };
  if (landed) await reachesServer(landed);
  await page.close();
  return read;
}

test('with the switch on the owner’s step gestures, their toasts’ Undo and the keyboard’s Undo and Redo land on the device’s copy as they do today', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await makeAndTakeBack(replica, { replica: true, landed: () => serverRows(`tree:${TREE}`)
      .some((row) => row.t === 'node' && row.f?.label?.[0] === 'Reef the sail')
      && serverRows(`tree:${TREE}`).some((row) => row.t === 'node' && row.id === 'dock' && row.life?.[0] === 'alive') });
    const lattice = await makeAndTakeBack(today, { replica: false });
    const events = [
      'roadmap_view_open {"view":"board","band":"desktop","role":"owner","door":"default","trees":"none"}',
      'roadmap_verb {"verb":"newStep","door":"row","view":"board","band":"desktop"}',
      'roadmap_board_create {"step":"open","door":"verbs","view":"board"}',
      'roadmap_board_create {"step":"saved","column":"upNext","filterCleared":false}',
      'roadmap_board_undo {"act":"create"}',
      'roadmap_undo {"action":"undo","outcome":"applied"}',
      'roadmap_verb {"verb":"newStep","door":"row","view":"board","band":"desktop"}',
      'roadmap_board_create {"step":"open","door":"verbs","view":"board"}',
      'roadmap_board_create {"step":"saved","column":"upNext","filterCleared":false}',
      'roadmap_board_undo {"act":"undoKey"}',
      'roadmap_undo {"action":"undo","outcome":"applied"}',
      'roadmap_board_undo {"act":"redoKey"}',
      'roadmap_undo {"action":"redo","outcome":"applied"}',
      'roadmap_board_step_open {"surface":"document","column":"locked","door":"card"}',
      'roadmap_board_step_action {"surface":"document","action":"delete"}',
      'roadmap_board_delete {"step":"confirm","view":"board"}',
      'roadmap_board_delete {"step":"held","door":"menu","view":"board"}',
      'roadmap_board_undo {"act":"delete"}',
      'roadmap_board_step_open {"surface":"document","column":"locked","door":"card"}',
      'roadmap_board_step_action {"surface":"document","action":"delete"}',
      'roadmap_board_delete {"step":"confirm","view":"board"}',
      'roadmap_board_delete {"step":"held","door":"menu","view":"board"}',
      'roadmap_board_delete {"step":"sent","via":"timer","view":"board"}',
      'roadmap_board_undo {"act":"undoKey"}',
      'roadmap_undo {"action":"undo","outcome":"applied"}',
    ];
    assert.deepEqual(onCopy, {
      released: ['locked: ', 'upNext: Read the wind, Reef the sail', 'done: Choose a course'],
      columns: ['locked: Leave the dock', 'upNext: Read the wind, Reef the sail', 'done: Choose a course'],
      events, issues: [], failures: [],
    });
    // Today's room tells the intake nothing of what an Undo or a Redo came to.
    assert.deepEqual(lattice, { ...onCopy, events: events.filter((event) => !event.startsWith('roadmap_undo ')) });
  } finally {
    await replica.close();
    await today.close();
  }
});

// §6, flow 48: the device tells its owner once, under the step on the Board and on its page, of their own changes that met
// another device's, and nothing else is shown as refused (INV-3). Device B is the owner's second browser. The engine keeps
// nothing of a step deleted elsewhere but its spent id (engine.md §7.5), and the room's editor goes unavailable on a step it
// no longer holds, so the change that finds the step deleted is the domain's own act on this device's engine, as a save
// decided in the moment the delete lands runs it. Each write of the note lets go of every entry that has landed and says
// nothing, so a link that landed before another device's delete of its step is not told of it; a link made while the device
// still held the step, that reaches the server after the delete, is, and its line names the removed step from the note.
test('with the switch on the owner is told once, under the card and on the step’s page, of their changes that met another device’s delete', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const other = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const room = `${origin}/room?account=u_owner&replica=on#/app/${TREE}`;
  const settled = (on) => on.waitForFunction(() => !window.engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'));
  const landed = (on) => on.evaluate(() => [...document.querySelectorAll('.st-board-landed')]
    .map((line) => [line.previousElementSibling.querySelector('.st-board-card-title').textContent, line.textContent]));
  // A new step's entry in the device's note: the step, its link from the step it follows, and that step's name.
  const entry = (step, [from, name]) => ({ nodes: [step], edges: [[from, step]], revived: [], names: [{ id: from, name }] });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const card = (label) => page.locator('.st-board-card-title', { hasText: label });
    // The device's note of the roadmap, null where it holds none. Saying a line clears its entry from the note in a write of
    // its own, which `cleared` waits for; `told` is what the page emitted of the lines it said.
    const note = () => page.evaluate((tree) => window.engine.readMetadata(`tree/${tree}`).devices[`landing:${tree}`] ?? null, TREE);
    const cleared = (part, id) => page.waitForFunction(([tree, part, id]) => !(window.engine.readMetadata(`tree/${tree}`)
      .devices[`landing:${tree}`]?.[part] ?? []).includes(id), [TREE, part, id]);
    const told = () => page.evaluate(() => ({ events: window.events.filter(({ name }) => name === 'roadmap_landing').map(({ props }) => JSON.stringify(props)).sort(),
      issues: window.issues }));
    // A new step that needs `after`, made in the room's composer: answers the id the domain gave it.
    const create = async (label, after) => {
      await page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
      const composer = page.getByRole('dialog', { name: 'New step', exact: true });
      await composer.locator('input').first().fill(label);
      await composer.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: after }).click();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await composer.getByRole('button', { name: 'Create step', exact: true }).click();
      await card(label).waitFor();
      return page.locator('.st-board-card[data-step-id]', { has: card(label) }).getAttribute('data-step-id');
    };
    await page.goto(room);
    const reef = await create('Reef the sail', /Leave the dock/);
    await settled(page);
    const made = await note();

    // B deletes 'Leave the dock' after the link to 'Reef the sail' from it landed: the delete met nothing of the owner's,
    // so no line says it, though the owner's note still holds the link when the delete reaches the device.
    const b = await other.newPage();
    b.setDefaultTimeout(15000);
    await b.goto(room);
    await b.locator('.st-board-card-title', { hasText: 'Leave the dock' }).waitFor();
    await b.evaluate((tree) => window.engine.commit(`tree/${tree}`, [{ op: 'delete', t: 'node', id: 'dock' }]), TREE);
    await settled(b);
    await page.evaluate(() => window.engine.kickPull());
    await card('Leave the dock').waitFor({ state: 'detached' });
    const afterDelete = await landed(page);
    const changed = await page.evaluate((tree) => window.changeStep(tree, 'dock', { description: 'Cast off the lines' }), TREE);
    await page.locator('.st-board-landed').waitFor();
    const cameBack = { changed, lines: await landed(page) };
    await card('Leave the dock').click();
    const onPage = await page.getByRole('article', { name: 'Leave the dock', exact: true }).locator('.st-step-landed').innerText();
    await settled(page);
    await b.evaluate(() => window.engine.kickPull());
    await b.locator('.st-board-card-title', { hasText: 'Leave the dock' }).click();
    const onB = await b.getByRole('article', { name: 'Leave the dock', exact: true }).innerText();
    await cleared('revived', 'dock');
    const toldBack = { note: await note(), ...await told() };
    await page.reload();
    await card('Leave the dock').waitFor();
    const quiet = await page.locator('.st-board-landed').count();

    // B deletes 'Read the wind' while this device, with no connection, still holds it and links a new step from it. The
    // link reaches the server after the delete, and the delete reaches the device while no room of it is open.
    await page.goto(room);
    await page.evaluate(() => window.connect(false));
    await b.evaluate((tree) => window.engine.commit(`tree/${tree}`, [{ op: 'delete', t: 'node', id: 'wind' }]), TREE);
    await settled(b);
    const trim = await create('Trim the sail', /Read the wind/);
    const linked = await note();
    await page.goto(`${origin}/room?account=u_owner&replica=on#/app/roadmaps`);
    await page.locator('.st-roadmaps-row').first().waitFor();
    await page.evaluate(() => window.connect(true));
    await settled(page);
    await page.waitForFunction((tree) => window.engine.readMetadata(`tree/${tree}`).spent.some((row) => row.id === 'wind'), TREE);
    const met = await note();
    await page.goto(room);
    await page.locator('.st-board-landed').waitFor();
    const follows = await landed(page);
    await cleared('nodes', trim);
    const toldFollows = { note: await note(), ...await told() };
    await page.reload();
    await card('Trim the sail').waitFor();
    const later = await page.locator('.st-board-landed').count();
    assert.deepEqual({ made, afterDelete, cameBack, onPage, onB: onB.includes('Cast off the lines'), toldBack, quiet, linked, met, follows, toldFollows, later, failures }, {
      made: entry(reef, ['dock', 'Leave the dock']),
      afterDelete: [],
      cameBack: { changed: 'committed', lines: [['Leave the dock', 'Your edit brought this step back.']] },
      onPage: 'Your edit brought this step back.',
      onB: true,
      toldBack: { note: null, events: ['{"rule":"cameBack","place":"board"}'], issues: [] },
      quiet: 0,
      linked: entry(trim, ['wind', 'Read the wind']),
      met: entry(trim, ['wind', 'Read the wind']),
      follows: [['Trim the sail', 'Read the wind was removed. This now follows Choose a course.']],
      toldFollows: { note: null, events: ['{"rule":"follows","place":"board"}'], issues: [] },
      later: 0,
      failures: [],
    });
  } finally {
    await context.close();
    await other.close();
  }
});

test('with the switch on the step document’s Tree section lists the person’s roadmaps from the device’s copy and attaches one, with its Undo', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    await page.goto(`${origin}/room?account=u_owner&replica=on&knot=1#/app/${TREE}`);
    await page.locator('.st-board-card-title', { hasText: 'Leave the dock' }).click();
    const step = page.getByRole('article', { name: 'Leave the dock', exact: true });
    await step.getByRole('button', { name: 'Attach a tree' }).click();
    const picker = page.getByRole('dialog', { name: 'Attach a tree' });
    await picker.getByRole('radio', { name: /Learn to knot/ }).click();
    const choices = await picker.getByRole('radio').allInnerTexts();
    await picker.getByRole('button', { name: 'Attach', exact: true }).click();
    const toast = page.locator('.st-board-toast');
    await toast.getByText('Tree attached', { exact: true }).waitFor();
    await step.getByText('Learn to knot').first().waitFor();
    await toast.getByRole('button', { name: 'Undo', exact: true }).click();
    await step.getByText('Learn to knot').first().waitFor({ state: 'detached' });
    const told = await page.evaluate(() => ({ events: window.events.filter(({ name }) => name === 'roadmap_tree_attach').map(({ props }) => JSON.stringify(props)), issues: window.issues }));
    assert.deepEqual({ choices, ...told, failures }, {
      choices: ['Learn to knot\n0 of 1 done'],
      events: [
        '{"step":"open","band":"desktop","view":"board","place":"account"}',
        '{"step":"attach","band":"desktop","view":"board","place":"account","mark":"none"}',
        '{"step":"undo","band":"desktop","view":"board","place":"account"}',
      ],
      issues: [], failures: [],
    });
    await page.close();
  } finally {
    await context.close();
  }
});

test('with the switch on a roadmap’s deletion lands on the person’s roadmaps with its Undo for nine seconds, and is permanent after', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const phone = await newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    await page.goto(`${origin}/room?account=u_owner&replica=on&knot=1#/app/${TREE}`);
    const roadmaps = page.locator('.st-roadmaps');
    const toast = page.locator('.st-board-toast');
    const deleteOpen = async () => {
      await page.locator('.st-roadmap-switcher [aria-haspopup="menu"]').click();
      await page.getByRole('button', { name: 'Delete Learn to sail', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('[data-switcher-action="confirm"]').focus();
      await page.keyboard.press('Enter');
      await roadmaps.waitFor();
    };
    const listed = () => roadmaps.locator('.st-roadmaps-row').allInnerTexts();
    const treeRecord = () => serverRows('acct:u_owner/roadmap').find((row) => row.t === 'tree' && row.id === TREE);

    await deleteOpen();
    await toast.getByText('Roadmap deleted', { exact: true }).waitFor();
    const held = { title: await roadmaps.getByRole('heading', { level: 1 }).innerText(), rows: await listed(), address: await page.evaluate(() => location.hash) };
    await toast.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.locator('.st-board-toast', { hasText: 'Deletion undone' }).waitFor();
    const back = { address: await page.evaluate(() => location.hash), columns: await boardColumns(page) };

    await deleteOpen();
    await toast.waitFor();
    await toast.waitFor({ state: 'detached', timeout: 14000 });
    const shown = await page.evaluate(() => window.events.filter(({ name }) => ['roadmap_sheet', 'roadmap_deletion', 'roadmap_your_roadmaps'].includes(name))
      .map(({ name, props }) => `${name} ${JSON.stringify(props)}`));
    await reachesServer(() => treeRecord()?.life?.[0] === 'dead');
    await page.reload();
    await roadmaps.locator('.st-roadmaps-row').first().waitFor();
    const after = { rows: await listed(), toasts: await toast.count() };
    const told = await page.evaluate(() => ({ reloaded: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues }));

    const narrow = await phone.newPage();
    await phone.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
    await narrow.goto(`${origin}/room?account=u_owner&replica=on#/app/roadmaps`);
    await narrow.locator('.st-roadmaps-row', { hasText: 'Learn to knot' }).waitFor();
    const phoneRows = { rows: await narrow.locator('.st-roadmaps-row').allInnerTexts(), chevrons: await narrow.locator('.st-roadmaps-row-open').evaluateAll((marks) => marks.filter((mark) => mark.checkVisibility()).length) };
    assert.deepEqual({ held, back, after, phoneRows, shown, told, failures }, {
      held: { title: 'Your roadmaps', rows: ['Learn to knot'], address: '#/app/roadmaps' },
      back: { address: `#/app/${TREE}`, columns: ['locked: Leave the dock', 'upNext: Read the wind', 'done: Choose a course'] },
      after: { rows: ['Learn to knot'], toasts: 0 },
      phoneRows: { rows: ['Learn to knot'], chevrons: 0 },
      shown: [
        'roadmap_sheet {"step":"open","door":"switcher"}',
        'roadmap_sheet {"step":"delete","door":"switcher","openers":"none","place":"account"}',
        'roadmap_deletion {"step":"held"}',
        'roadmap_your_roadmaps {"step":"shown","count":"1"}',
        'roadmap_deletion {"step":"undo","outcome":"cancelled"}',
        'roadmap_sheet {"step":"open","door":"switcher"}',
        'roadmap_sheet {"step":"delete","door":"switcher","openers":"none","place":"account"}',
        'roadmap_deletion {"step":"held"}',
        'roadmap_your_roadmaps {"step":"shown","count":"1"}',
      ],
      told: { reloaded: ['roadmap_your_roadmaps {"step":"shown","count":"1"}'], issues: [] },
      failures: [],
    });
    await page.close();
    await narrow.close();
  } finally {
    await context.close();
    await phone.close();
  }
});

// One owner's script on the Graph: a kind set, a link made, removed and moved, a reorder, a step made on the canvas and a
// step deleted there with its toast's Undo, which the room on the device's copy tells once the engine knows what it came
// to; then the Board the Graph's writes leave, and what the room told.
async function onTheGraph(context, { replica }) {
  await context.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(`${origin}/room?account=u_owner&replica=${replica ? 'on' : 'off'}#/app/${TREE}`);
  await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).waitFor();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.waitForFunction(() => window.scene?.options?.onSetKind);
  // Each gesture once the one before it has said it saved, as a person makes them.
  const saved = async (run) => {
    const before = await page.evaluate(() => window.events.length);
    await page.evaluate(run);
    await page.waitForFunction((before) => window.events.slice(before).some(({ props }) => props?.step === 'saved'), before);
  };
  await saved(() => window.scene.options.onSetKind('wind', 'olive'));
  await saved(() => window.scene.options.onConnectNodes('course', 'dock'));
  await saved(() => window.scene.options.onDeleteEdge('course', 'dock'));
  await saved(() => window.scene.options.onReconnectEdge('course', 'wind', 'course', 'dock'));
  await saved(() => window.scene.options.onSetNodeOrder('dock', 'Zz'));
  await saved(() => window.scene.options.onCreateChild('course'));
  await page.evaluate(() => window.scene.options.onDeleteNode('wind'));
  await page.locator('.st-graph-toast .st-board-toast-undo').click();
  await page.locator('.st-graph-toast').waitFor({ state: 'detached' });
  if (replica) await page.waitForFunction(() => window.events.some(({ name }) => name === 'roadmap_undo'));
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.st-board-card').length === 4);
  const read = { columns: await boardColumns(page),
    ...await page.evaluate(() => ({ events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues })), failures };
  await page.close();
  return read;
}

test('with the switch on the Graph’s gestures land on the device’s copy as they do today', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await onTheGraph(replica, { replica: true });
    const lattice = await onTheGraph(today, { replica: false });
    const events = [
      'roadmap_view_open {"view":"board","band":"desktop","role":"owner","door":"default","trees":"none"}',
      'roadmap_view_switch {"view":"graph"}',
      'roadmap_board_edit {"step":"saved","view":"graph","name":false,"description":false,"kind":true,"prerequisites":false,"order":false}',
      'roadmap_board_edit {"step":"saved","view":"graph","name":false,"description":false,"kind":false,"prerequisites":true,"order":false}',
      'roadmap_board_edit {"step":"saved","view":"graph","name":false,"description":false,"kind":false,"prerequisites":true,"order":false}',
      'roadmap_board_edit {"step":"saved","view":"graph","name":false,"description":false,"kind":false,"prerequisites":true,"order":false}',
      'roadmap_board_edit {"step":"saved","view":"graph","name":false,"description":false,"kind":false,"prerequisites":false,"order":true}',
      'roadmap_board_create {"step":"saved","door":"canvas","view":"graph"}',
      'roadmap_graph_toast {"act":"delete","step":"shown"}',
      'roadmap_board_delete {"step":"sent","via":"direct","view":"graph"}',
      'roadmap_graph_toast {"act":"delete","step":"undo"}',
      'roadmap_undo {"action":"undo","outcome":"applied"}',
      'roadmap_view_switch {"view":"board"}',
    ];
    assert.deepEqual(onCopy, { columns: ['locked: Leave the dock', 'upNext: Read the wind, ', 'done: Choose a course'], events, issues: [], failures: [] });
    // Today's room tells the intake nothing of what an Undo came to.
    assert.deepEqual(lattice, { ...onCopy, events: events.filter((event) => !event.startsWith('roadmap_undo ')) });
  } finally {
    await replica.close();
    await today.close();
  }
});

// A replica room open on the owner's roadmap, with what it says and emits.
async function replicaPage(context) {
  await context.addCookies([{ name: 'fixture', value: 'owner', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(`${origin}/room?account=u_owner&replica=on#/app/${TREE}`);
  await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).waitFor();
  const told = (names) => page.evaluate((names) => window.events.filter(({ name }) => names.includes(name)).map(({ name, props }) => `${name} ${JSON.stringify(props)}`), names);
  return { page, failures, told };
}

test('with the switch on a gesture the domain refuses shows no success: a loop is said in today’s words, and a name past its bound keeps its draft as today’s failure does', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const { page, failures, told } = await replicaPage(context);
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await page.waitForFunction(() => window.scene?.options?.onConnectNodes);
    await page.evaluate(() => window.scene.options.onConnectNodes('dock', 'course'));
    await page.locator('.st-board-toast', { hasText: 'This would create a loop' }).waitFor();
    const loop = { toasts: await page.locator('.st-board-toast').allInnerTexts(), events: await told(['roadmap_board_edit', 'roadmap_write_refused']) };
    // The loop's words leave after their hold, so what stands after the name is the name's own.
    await page.locator('.st-board-toast', { hasText: 'This would create a loop' }).waitFor({ state: 'detached', timeout: 15000 });

    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
    const composer = page.getByRole('dialog', { name: 'New step', exact: true });
    await composer.locator('input').first().fill('x'.repeat(201));
    await composer.getByRole('button', { name: 'Create step', exact: true }).click();
    await composer.getByText('Couldn’t save. Your draft is kept.', { exact: true }).waitFor();
    const named = { columns: await boardColumns(page), toasts: await page.locator('.st-board-toast').count(),
      events: await told(['roadmap_board_create', 'roadmap_write_refused']) };
    assert.deepEqual({ loop, named, failures }, {
      loop: { toasts: ['This would create a loop'], events: ['roadmap_write_refused {"write":"AddEdge","refusal":"invalid"}'] },
      named: {
        columns: ['locked: Leave the dock', 'upNext: Read the wind', 'done: Choose a course'], toasts: 0,
        events: [
          'roadmap_write_refused {"write":"AddEdge","refusal":"invalid"}',
          'roadmap_board_create {"step":"open","door":"verbs","view":"board"}',
          'roadmap_write_refused {"write":"CreateNode","refusal":"invalid"}',
          'roadmap_board_create {"step":"failed"}',
        ],
      },
      failures: [],
    });
    await page.close();
  } finally {
    await context.close();
  }
});

test('with the switch on a pasted plan’s steps are pulsed and told under the ids the domain gave them, once they have landed', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const { page, failures, told } = await replicaPage(context);
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await page.waitForFunction(() => window.scene?.options?.onSetKind);
    await page.evaluate(() => {
      window.pulses = [];
      window.scene.pulseNode = (id) => window.pulses.push(id);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '- Rent a boat\n- Find a crew');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.locator('.pc-plant').click();
    await page.locator('.st-board-toast', { hasText: 'Added 2 steps' }).waitFor();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card-title', { hasText: 'Find a crew' }).waitFor();
    const pasted = await page.evaluate(() => [...document.querySelectorAll('.st-board-card')]
      .filter((card) => ['Rent a boat', 'Find a crew'].includes(card.querySelector('.st-board-card-title').textContent)).map((card) => card.dataset.stepId).sort());
    const pulses = await page.evaluate(() => [...window.pulses].sort());
    assert.deepEqual({ minted: pasted.every((id) => /^[0-9a-z]{16}$/.test(id)), pulses: pulses.join() === pasted.join() && pulses.length === 2,
      events: await told(['roadmap_board_create', 'roadmap_graph_toast']), failures }, {
      minted: true, pulses: true,
      events: [
        'roadmap_board_create {"step":"open","door":"paste","view":"graph"}',
        'roadmap_graph_toast {"act":"graft","step":"shown"}',
        'roadmap_board_create {"step":"saved","door":"paste","view":"graph","count":"2-5"}',
      ],
      failures: [],
    });
    await page.close();
  } finally {
    await context.close();
  }
});
