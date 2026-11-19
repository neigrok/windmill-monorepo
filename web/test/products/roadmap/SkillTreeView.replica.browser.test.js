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
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
const account = params.get('account');
const offline = params.has('offline');
const tree = ${JSON.stringify(TREE)};
Object.assign(window, { events: [], issues: [], syncFailures: [], ceremonies: [], revealed: [], revealFrames: [], cameraCalls: [], roomStatus: getRoomStatus });
if (offline) Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
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
  fetch: (url, options) => (offline ? Promise.reject(new TypeError('Failed to fetch'))
    : fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-account': account ?? '' } })) });
const engine = await syncSession.open({ registry: new Registry(${registryJson}), transport, appVersion: '1',
  credentials: { clear: async () => {} }, telemetry: { event() {}, failure(operation) { window.syncFailures.push(operation); } } });
window.engine = engine;
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
  const replica = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
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
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const replica = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
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
  for (let turn = 0; turn < 200; turn++) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  throw new Error('the write never reached the server');
}

// One owner's script on a room: open a step, complete it and add it a subtask, then what the room shows and told.
async function markAndNote(context, { replica }) {
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
  await page.close();
  return read;
}

test('with the switch on the owner’s marks and workspace land on the device’s copy, with the screens and events of today’s room', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await markAndNote(replica, { replica: true });
    const lattice = await markAndNote(today, { replica: false });
    assert.deepEqual(onCopy.columns, ['locked: ', 'upNext: Leave the dock', 'done: Read the wind, Choose a course']);
    assert.deepEqual(onCopy, lattice);
    await reachesServer(() => serverRows(`overlay/${TREE}`).some((row) => row.t === 'progress' && row.id === 'wind')
      && serverRows(`overlay/${TREE}`).some((row) => row.t === 'subtask'));
  } finally {
    await replica.close();
    await today.close();
  }
});

// One owner's script of step gestures on a room: a new step and its toast's Undo, a new step undone and redone by the
// keyboard, a held delete undone in its hold, and one released after its nine seconds and undone by the keyboard.
async function makeAndTakeBack(context, { replica }) {
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
  await create('Reef the sail');
  await keys('ControlOrMeta+z');
  await card('Reef the sail').waitFor({ state: 'detached' });
  await keys('ControlOrMeta+Shift+z');
  await card('Reef the sail').waitFor();
  await remove('Leave the dock');
  await toastUndo().click();
  await card('Leave the dock').waitFor();
  await remove('Leave the dock');
  await page.locator('.st-board-toast').waitFor({ state: 'detached', timeout: 15000 });
  const released = await boardColumns(page);
  await keys('ControlOrMeta+z');
  await card('Leave the dock').waitFor();
  const read = { released, columns: await boardColumns(page),
    ...await page.evaluate(() => ({ events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues })), failures };
  await page.close();
  return read;
}

test('with the switch on the owner’s step gestures, their toasts’ Undo and the keyboard’s Undo and Redo land on the device’s copy as they do today', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const replica = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await makeAndTakeBack(replica, { replica: true });
    const lattice = await makeAndTakeBack(today, { replica: false });
    assert.deepEqual({ released: onCopy.released, columns: onCopy.columns }, {
      released: ['locked: ', 'upNext: Read the wind, Reef the sail', 'done: Choose a course'],
      columns: ['locked: Leave the dock', 'upNext: Read the wind, Reef the sail', 'done: Choose a course'],
    });
    assert.deepEqual(onCopy, lattice);
    await reachesServer(() => serverRows(`tree:${TREE}`).some((row) => row.t === 'node' && row.f?.label?.[0] === 'Reef the sail')
      && serverRows(`tree:${TREE}`).some((row) => row.t === 'node' && row.id === 'dock' && row.life?.[0] === 'alive'));
  } finally {
    await replica.close();
    await today.close();
  }
});

// §6, flow 48: the device tells its owner once, under the step on the Board and on its page, of their own changes that met
// another device's, and nothing else is shown as refused (INV-3). The engine keeps nothing of a step deleted elsewhere (engine.md §7.5), so no edit made here finds one
// absent: the revival the domain notes is written to the device's note as the domain writes it.
test('with the switch on the owner is told once, under the card and on the step’s page, of their changes that met a delete', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    await page.goto(`${origin}/room?account=u_owner&replica=on#/app/${TREE}`);
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
    const composer = page.getByRole('dialog', { name: 'New step', exact: true });
    await composer.locator('input').first().fill('Reef the sail');
    await composer.locator('.st-board-draft-needs').click();
    await page.getByRole('checkbox', { name: /Read the wind/ }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await composer.getByRole('button', { name: 'Create step', exact: true }).click();
    await page.locator('.st-board-card-title', { hasText: 'Reef the sail' }).waitFor();
    await page.evaluate(async (tree) => {
      const scope = `tree/${tree}`;
      await window.engine.commit(scope, [{ op: 'delete', t: 'node', id: 'wind' }]);
      const note = window.engine.readMetadata(scope).devices[`landing:${tree}`];
      await window.engine.commit(scope, [], { local: { [`landing:${tree}`]: { ...note, revived: ['dock'] } } });
    }, TREE);
    await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).waitFor({ state: 'detached' });
    await page.locator('.st-board-landed').nth(1).waitFor();
    const board = { columns: await boardColumns(page), lines: await page.evaluate(() => [...document.querySelectorAll('.st-board-landed')]
      .map((line) => [line.previousElementSibling.querySelector('.st-board-card-title').textContent, line.textContent])),
    // Flow 43's refused card and the Restore offer for a step whose link a delete hid retire with the old sync.
    retired: await page.locator('.board-refused-sync').count() + await page.getByRole('button', { name: 'Restore', exact: true }).count() };
    await page.locator('.st-board-card-title', { hasText: 'Leave the dock' }).click();
    const step = page.getByRole('article', { name: 'Leave the dock', exact: true });
    const onPage = await step.locator('.st-step-landed').innerText();
    const told = await page.evaluate((tree) => ({ note: window.engine.readMetadata(`tree/${tree}`).devices[`landing:${tree}`] ?? null,
      events: window.events.filter(({ name }) => name === 'roadmap_landing').map(({ props }) => JSON.stringify(props)), issues: window.issues }), TREE);
    await page.reload();
    await page.locator('.st-board-card-title', { hasText: 'Reef the sail' }).waitFor();
    const later = await page.locator('.st-board-landed').count();
    assert.deepEqual({ board, onPage, ...told, later, failures }, {
      board: {
        columns: ['locked: ', 'upNext: Leave the dock, Reef the sail', 'done: Choose a course'],
        lines: [['Leave the dock', 'Your edit brought this step back.'], ['Reef the sail', 'Read the wind was removed. This now follows Choose a course.']],
        retired: 0,
      },
      onPage: 'Your edit brought this step back.',
      note: null,
      events: ['{"rule":"follows","place":"board"}', '{"rule":"cameBack","place":"board"}'],
      issues: [],
      later: 0,
      failures: [],
    });
  } finally {
    await context.close();
  }
});

test('with the switch on the step document’s Tree section lists the person’s roadmaps from the device’s copy and attaches one, with its Undo', async () => {
  state = ServerState.empty({ epoch: 'ep-room', accounts: { u_owner: { name: 'Owner' }, u_reader: { name: 'Reader' } } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
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
// step deleted there with its toast's Undo; then the Board the Graph's writes leave, and what the room told.
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
  const replica = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const today = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(replica, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const onCopy = await onTheGraph(replica, { replica: true });
    const lattice = await onTheGraph(today, { replica: false });
    assert.deepEqual(onCopy, lattice);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await readRoom(context, { account: 'u_owner', replica: true, address: `#/app/${TREE}`, seed: true });
    const { page, failures, told } = await replicaPage(context);
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await page.waitForFunction(() => window.scene?.options?.onConnectNodes);
    await page.evaluate(() => window.scene.options.onConnectNodes('dock', 'course'));
    await page.locator('.st-board-toast', { hasText: 'This would create a loop' }).waitFor();
    const loop = { toasts: await page.locator('.st-board-toast').allInnerTexts(), events: await told(['roadmap_board_edit', 'roadmap_write_refused']) };

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
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
