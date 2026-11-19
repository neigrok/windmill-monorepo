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
window.served = await (await fetch('/v1/trees/' + tree)).json().then((body) => body.data);
const scope = new DocumentDataScope({ invalidate: () => stepDraftSession(document, { create: false })?.invalidate() });
scope.reconcile(engine);
createRoot(document.getElementById('root')).render(React.createElement(ProductSessions, {
  dataScope: scope.read, products: [{ session: { Provider: StepDraftProvider, Notice: StepDraftNotice } }],
}, React.createElement(SkillTreeView, { treeId: tree, replica: params.get('replica') === 'on' })));
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
    // The one difference is the read-only room's: the step document's Tree section offers no control while no write lands.
    assert.deepEqual(online, { ...lattice, step: lattice.step.replace('Tree\nNone\n', '') });
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
    assert.deepEqual(onCopy, { ...lattice, step: lattice.step.replace('Tree\nNone\n', '') });
    await reachesServer(() => serverRows(`overlay/${TREE}`).some((row) => row.t === 'progress' && row.id === 'wind')
      && serverRows(`overlay/${TREE}`).some((row) => row.t === 'subtask'));
  } finally {
    await replica.close();
    await today.close();
  }
});
