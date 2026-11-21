// The public demo on the engine against the demo of roadmap's own sync, in Chromium. Two builds of the route table: one
// with the room's replica switch on, served by a server past the cutover that refuses every retired route (410) and
// keeps the demo as an ordinary public roadmap of its house account, on the JavaScript reference server under roadmap's
// binding; and one with it off, served the rooms' routes and standing on its own session. Both must open, read and play
// the same demo and emit the same events, and the switch's build must ask nothing of a retired route.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { between } from '../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { RoadmapProduct } from '../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { DEMO_COPY } from '../../../src/products/roadmap/copy.js';
import { DEMO_TREE_ID } from '../../../src/products/roadmap/demo/demoStage.js';
import { beacon, boardColumns } from './browserFixture.js';
import { scene } from './skillTreeViewHost.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryJson = readFileSync(new URL('../../../../packages/api-contract/sync/roadmap.registry.json', import.meta.url), 'utf8');
const registry = new Registry(JSON.parse(registryJson));

// The demo as `backend/db/schema.sql` seeds it: its kinds, and its steps in the rooms' order (by id), each with what it
// follows.
const KINDS = [['build', 'terracotta', 'Milestones', 'The days you’ll remember'], ['learn', 'olive', 'Practice', 'Hands on the boat — drills until they’re reflex'],
  ['milestone', 'gold', 'Theory', 'What you learn ashore — wind, rules, weather']];
const STEPS = [
  ['boat-parts', 'Parts of the boat', 'anchor', 'gold', ['dream']],
  ['capsize', 'Capsize & recover', 'rotate-ccw', 'olive', ['jibing']],
  ['day-cruise', 'Day cruise with crew', 'users', 'terracotta', ['first-solo', 'forecast', 'water-rules']],
  ['docking', 'Docking under sail', 'anchor', 'olive', ['jibing', 'tacking']],
  ['dream', 'Dream of sailing', 'sparkles', 'terracotta', []],
  ['first-aboard', 'First time on board', 'sailboat', 'olive', ['boat-parts']],
  ['first-solo', 'First solo lap', 'flag', 'terracotta', ['capsize', 'mob-drill']],
  ['forecast', 'Read a forecast', 'cloud-sun', 'gold', ['points-of-sail']],
  ['jibing', 'Jibing', 'corner-down-right', 'olive', ['points-of-sail', 'rigging']],
  ['mob-drill', 'Man-overboard drill', 'life-buoy', 'olive', ['tacking']],
  ['night-sail', 'First night sail', 'moon', 'terracotta', ['day-cruise']],
  ['points-of-sail', 'Points of sail', 'compass', 'gold', ['wind-basics']],
  ['rigging', 'Rig the boat yourself', 'cable', 'olive', ['first-aboard']],
  ['skipper-weekend', 'Skipper a weekend trip', 'map', 'terracotta', ['day-cruise']],
  ['tacking', 'Tacking', 'corner-up-right', 'olive', ['points-of-sail', 'rigging']],
  ['water-rules', 'Rules of the water', 'scale', 'gold', ['points-of-sail']],
  ['wind-basics', 'How wind moves a boat', 'wind', 'gold', ['dream']],
];
// Each step's order key in the rooms' order, as the move gives a step that holds none (§8.1).
const ORDS = STEPS.reduce((keys) => [...keys, between(keys.at(-1) ?? null, null)], []);
// The rooms' answer of `GET /v1/trees/{demo}`, which its session stands on too.
const TODAYS_DEMO = {
  id: DEMO_TREE_ID, title: 'Learn to sail', kinds: KINDS.map(([id, hue, label, description]) => ({ id, hue, label, description })),
  nodes: STEPS.map(([id, label, icon, color, prerequisites], index) => ({ id, label, icon, color, order: ORDS[index], prerequisites })),
};

const entry = (switched) => `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Registry } from '${root}../packages/api-contract/sync/reference/core/registry.js';
import { HttpTransport } from '/src/platform/sync/transport.js';
import { syncSession } from '/src/platform/sync/session.js';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
import { SyncStore } from '/src/products/roadmap/sync/SyncStore.js';
import { roadmapRoutes } from '/src/products/roadmap/routes.js';
import { readNavigation, subscribeNavigation } from '/src/shell/navigation.js';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { stepDraftSession } from '/src/products/roadmap/step/StepDraftSession.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
const account = params.get('account');
const demo = ${JSON.stringify(DEMO_TREE_ID)};
Object.assign(window, { events: [], issues: [], syncFailures: [], ceremonies: [], revealed: [], revealFrames: [], cameraCalls: [], sessions: 0 });
${switched ? '' : `// Today's room: its own session stands on the demo today's server answers, as a reader's, where it would open the socket.
SyncSession.prototype.start = async function () {
  window.sessions += 1;
  this.store = new SyncStore();
  this.scheduleReconnect = () => {};
  this.forceReconnect = () => {};
  this.registry = null;
  this.seed(${JSON.stringify(TODAYS_DEMO)});
  this.phase = 'live';
  this.ackedServerVector = this.lattice.frontier();
  this.receiveState({ ...this.lattice.toFrame(), seq: 1, reach: 'reader' });
  this.receiveProgressGraft(this.progress.toFrame());
  this.ready = false;
  await this.persistNow();
  this.ready = true;
  this.emitTree();
  this.emitStatus();
};`}
const boot = crypto.randomUUID();
const transport = new HttpTransport({ schema: 13, base: '', reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot }),
  socket: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-account': account ?? '' } }) });
const engine = await syncSession.open({ registry: new Registry(${registryJson}), transport, appVersion: '1',
  credentials: { clear: async () => {} }, telemetry: { event() {}, failure(operation) { window.syncFailures.push(operation); } } });
if (account && engine.device.activeReplica.meta.state !== 'bound') await engine.signIn(account);
syncSession.publish({ signedIn: Boolean(account) });
// The house account's demo, as the move leaves it: a public roadmap of its list, its steps and links, and one mark of the
// account's own that the demo never shows.
if (params.has('seed')) {
  await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: demo }]);
  await engine.commit('tree/' + demo, [
    { op: 'write', t: 'meta', id: 'meta', f: { title: 'Learn to sail', visibility: 'public' } },
    ...${JSON.stringify(KINDS)}.map(([id, hue, label, description], index) => ({ op: 'create', t: 'kind', id, f: { hue, label, description, ord: 'a' + index } })),
    ...${JSON.stringify(TODAYS_DEMO.nodes)}.map(({ id, label, icon, color, order }) => ({ op: 'create', t: 'node', id, f: { label, icon, color, ord: order } })),
    ...${JSON.stringify(TODAYS_DEMO.nodes)}.flatMap(({ id, prerequisites }) => prerequisites.map((from) => ({ op: 'put', t: 'edge', id: [from, id] }))),
  ], { atomic: true });
  await engine.commit('self/overlay/' + demo, [{ op: 'write', t: 'progress', id: 'tacking', f: { mark: { status: 'complete', outOfOrder: true } } }]);
  for (let turn = 0; engine.device.activeReplica.outbox.some((entry) => entry.state !== 'acked'); turn++) {
    if (turn === 200) throw new Error('the demo never settled');
    await new Promise((settle) => setTimeout(settle, 50));
  }
  window.seeded = true;
} else {
  const scope = new DocumentDataScope({ invalidate: () => stepDraftSession(document, { create: false })?.invalidate() });
  scope.reconcile(engine);
  // The route table's answer at the page's address, inside roadmap's session, as the app mounts it.
  function Room() {
    const location = React.useSyncExternalStore(subscribeNavigation, readNavigation);
    const answer = roadmapRoutes.render(location);
    return React.createElement(answer.Component, answer.props);
  }
  createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: null },
    React.createElement(ProductSessions, { dataScope: scope.read, products: [roadmapRoutes] }, React.createElement(Room))));
}
`;

const auth = `
const account = new URLSearchParams(location.search).get('account');
export const useAuth = () => ({ status: account ? 'signed-in' : 'ghost', user: account ? { name: 'Ada' } : null,
  account: account ? { id: account } : null, confirmed: true, lapsed: false, refresh: async () => null });
`;

// One build of the app's roadmap with the switch on (`VITE_ROADMAP_REPLICA_ROOM=on`, as a build sets it) or off, served
// from memory.
async function bundle(switched) {
  const plugin = { name: 'roadmap-demo-host', enforce: 'pre',
    resolveId(id) {
      if (id === '/demo-host-entry.js') return '\0demo-entry';
      if (id.endsWith('/scene/SkillTreeScene.js')) return '\0demo-scene';
      if (id.endsWith('/shell/auth/AuthProvider.jsx')) return '\0demo-auth';
      if (id.endsWith('/shell/auth/SignInDoor.jsx')) return '\0demo-signin';
      if (id.endsWith('/telemetry/beacon.js')) return '\0demo-events';
      if (id.endsWith('/telemetry/sentry.js')) return '\0demo-issues';
    },
    load(id) {
      if (id === '\0demo-entry') return entry(switched);
      if (id === '\0demo-scene') return scene;
      if (id === '\0demo-auth') return auth;
      if (id === '\0demo-signin') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0demo-events') return beacon;
      if (id === '\0demo-issues') return 'export function captureError(product, operation) { window.issues.push(operation); }';
    },
  };
  const set = process.env.VITE_ROADMAP_REPLICA_ROOM;
  if (switched) process.env.VITE_ROADMAP_REPLICA_ROOM = 'on';
  else delete process.env.VITE_ROADMAP_REPLICA_ROOM;
  try {
    const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development', plugins: [plugin],
      build: { write: false, minify: false, sourcemap: false, cssCodeSplit: false, modulePreload: false, target: 'es2022',
        rollupOptions: { input: '/demo-host-entry.js', output: { entryFileNames: 'host-entry.js' } } } });
    return new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  } finally {
    if (set === undefined) delete process.env.VITE_ROADMAP_REPLICA_ROOM;
    else process.env.VITE_ROADMAP_REPLICA_ROOM = set;
  }
}

// What §7 retires: the list and the tree, its guides and diagnostics, the tree's writes and the socket.
const RETIRED = [/^\/v1\/socket$/, /^\/v1\/trees$/, /^\/v1\/trees\/[^/]+$/, /^\/v1\/trees\/[^/]+\/(guides|diagnostics|subtree)$/];
const retired = (pathname) => RETIRED.some((route) => route.test(pathname));

// The reference server's roadmap records, shared by both servers: the engine's server is the same before and after the
// cutover.
let state = null;
const serverRows = (part) => Object.entries(state.rows).filter(([key]) => key.includes(part)).flatMap(([, rows]) => Object.values(rows));
const product = new RoadmapProduct();
// How long the server takes to answer the owner's progress, as a slow network's first open of the demo waits on it.
let progressAfterMs = 0;

// A server of one build: past the cutover (`cutover`), where every retired route answers 410 and the owner's progress
// is read from the house account's overlay as the server keeps it, or the rooms' one, which answers the demo over its
// routes.
function serve(files, { cutover }) {
  const stylesheet = [...files.keys()].find((path) => path.endsWith('.css'));
  return createServer(async (request, response) => {
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
    if (cutover && retired(url.pathname)) return json(410, { error: 'This version of the app can no longer save; update it.', code: 'client-update-required' });
    if (url.pathname === `/v1/trees/${DEMO_TREE_ID}`) {
      return json(200, { data: TODAYS_DEMO, root: DEMO_TREE_ID, parent: null, path: [], depth: 0, mine: false, visibility: 'public' });
    }
    if (url.pathname === `/v1/trees/${DEMO_TREE_ID}/progress`) {
      await new Promise((settle) => setTimeout(settle, progressAfterMs));
      const marks = serverRows(`acct:u_house/overlay/${DEMO_TREE_ID}`).filter((row) => row.t === 'progress')
        .map((row) => ({ node: row.id, status: row.f.mark[0].status, at: `${Date.now()}:0:srv` }));
      return json(200, { marks, subtrees: [] });
    }
    if (url.pathname === '/v1/me') {
      const account = /(?:^|; )fixture=(u_[a-z]+)/.exec(request.headers.cookie ?? '')?.[1] ?? null;
      return json(200, { user: account ? { id: account } : null });
    }
    if (url.pathname === '/v1/trees') return json(200, { trees: [] });
    if (url.pathname.endsWith('/activity')) return json(200, { events: [] });
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
}

const servers = { engine: serve(await bundle(true), { cutover: true }), today: serve(await bundle(false), { cutover: false }) };
const origins = {};
for (const [name, server] of Object.entries(servers)) {
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  origins[name] = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ headless: true });
after(async () => {
  await browser.close();
  for (const server of Object.values(servers)) server.close();
});

// A context of the test's, each page's CPU slowed by WM_TEST_CPU_THROTTLE (as 6) where it is set, to stand as a slow CI
// runner does.
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const rate = Number(process.env.WM_TEST_CPU_THROTTLE ?? 0);
  if (rate > 1) context.on('page', (page) => context.newCDPSession(page).then((cdp) => cdp.send('Emulation.setCPUThrottlingRate', { rate })));
  return context;
}

// The house account plants the demo on the engine's server, through a browser's engine, as the move leaves it.
async function plantDemo() {
  state = ServerState.empty({ epoch: 'ep-demo', accounts: { u_house: { name: 'Windmill' }, u_reader: { name: 'Reader' } } });
  const context = await newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origins.engine}/room?account=u_house&seed=1`);
    await page.waitForFunction(() => window.seeded === true, null, { timeout: 30000 });
  } finally {
    await context.close();
  }
}

// One visit of the demo at `#/demo`, signed in as `account` or signed out, on one build: what it shows as it opens on the
// Graph, the coach's play there, which a visitor is shown once (Mark it done, and the unlock toast), the Board and the
// coached step's page after it, every event and issue, and every request the page made outside the engine's sync, with
// each socket.
async function visitDemo(build, { account = null } = {}) {
  const context = await newContext();
  try {
    if (account) await context.addCookies([{ name: 'fixture', value: account, url: origins[build] }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    const requests = [];
    const sockets = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v1/sync/')) requests.push(`${request.method()} ${url.pathname}`);
    });
    page.on('websocket', (socket) => sockets.push(new URL(socket.url()).pathname));
    await page.goto(`${origins[build]}/room${account ? `?account=${account}` : ''}#/demo`);
    const row = page.locator('.st-roadmap-identity[data-role="demo"]');
    const progress = page.locator('.st-roadmap-progress');
    await progress.waitFor();
    const opened = { view: await row.getAttribute('data-view'), row: await row.innerText(), progress: await progress.getAttribute('aria-label') };

    const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
    await mark.waitFor();
    const coach = await page.locator('.wm-coach-card').innerText();
    // The scene this test draws stands every step at (20, 300), so the coach stands beside its step there.
    const seat = await page.locator('.wm-coach').evaluate((chip) => [chip.style.left, chip.style.top]);
    await mark.click();
    const toast = page.locator('.st-board-toast-message').filter({ hasText: DEMO_COPY.unlockToast });
    await toast.waitFor();
    const said = await toast.innerText();
    const played = { coach, seat, said, progress: await progress.getAttribute('aria-label') };

    await row.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('[data-column="done"] .st-board-card-title', { hasText: 'Rig the boat yourself' }).waitFor();
    const board = await boardColumns(page);
    await page.locator('.st-board-card-title', { hasText: 'Rig the boat yourself' }).click();
    const step = await page.getByRole('article', { name: 'Rig the boat yourself', exact: true }).innerText();
    const told = await page.evaluate(() => ({ events: window.events.map(({ name, props }) => `${name} ${JSON.stringify(props)}`), issues: window.issues,
      syncFailures: window.syncFailures, sessions: window.sessions }));
    return { opened, played, board, step, ...told, failures, requests, sockets };
  } finally {
    await context.close();
  }
}

// What the two builds show alike, without what each asks of its server and how it follows the demo.
const shown = ({ requests, sockets, sessions, ...visit }) => visit;

for (const account of [null, 'u_reader']) {
  test(`${account ? 'signed in' : 'signed out'}, the demo with the switch on opens, reads and plays as today’s, on the engine’s copy of the house account’s roadmap, and asks nothing of a retired route`, async () => {
    await plantDemo();
    const engine = await visitDemo('engine', { account });
    const today = await visitDemo('today', { account });
    assert.deepEqual({ opened: engine.opened, played: engine.played, board: engine.board }, {
      opened: { view: 'tree', row: 'Learn to sail\nWindmill sample\n6/17\n/\nFork', progress: '6 of 17 steps done' },
      played: { coach: `${DEMO_COPY.coachSentence}\n\n×\n${DEMO_COPY.coachButton}`, seat: ['38px', '300px'], said: DEMO_COPY.unlockToast, progress: '7 of 17 steps done' },
      board: [
        'locked: Capsize & recover, Man-overboard drill, Docking under sail, First solo lap, Day cruise with crew, First night sail, Skipper a weekend trip',
        'upNext: Jibing, Tacking, Rules of the water',
        'done: Rig the boat yourself, Parts of the boat, Dream of sailing, First time on board, Read a forecast, Points of sail, How wind moves a boat',
      ],
    }, 'the demo shows its staged marks, not the house account’s, and its coach plays the step they leave up next');
    assert.deepEqual(shown(engine), { ...shown(today), failures: [], issues: [], syncFailures: [] });
    assert.deepEqual({ requests: engine.requests, sockets: engine.sockets, sessions: engine.sessions }, {
      requests: [`GET /v1/trees/${DEMO_TREE_ID}/progress`, `GET /v1/trees/${DEMO_TREE_ID}/activity`], sockets: [], sessions: 0,
    }, 'the switch’s demo reads the owner’s progress and the activity feed, and nothing retired');
    assert.deepEqual({ asked: [...new Set(today.requests)].sort(), sessions: today.sessions }, {
      asked: ['GET /v1/me', ...(account ? ['GET /v1/trees'] : []), `GET /v1/trees/${DEMO_TREE_ID}`, `GET /v1/trees/${DEMO_TREE_ID}/activity`], sessions: 1,
    }, 'today’s demo reads as it does today: the tree, the activity feed and its own session');
  });
}

test('a demo whose first open waits on a slow server still plays: its coach waits for the roadmap, and stands beside its step', async () => {
  await plantDemo();
  progressAfterMs = 2500;
  try {
    const engine = await visitDemo('engine');
    assert.deepEqual({ opened: engine.opened, played: engine.played, failures: engine.failures }, {
      opened: { view: 'tree', row: 'Learn to sail\nWindmill sample\n6/17\n/\nFork', progress: '6 of 17 steps done' },
      played: { coach: `${DEMO_COPY.coachSentence}\n\n×\n${DEMO_COPY.coachButton}`, seat: ['38px', '300px'], said: DEMO_COPY.unlockToast, progress: '7 of 17 steps done' },
      failures: [],
    });
  } finally {
    progressAfterMs = 0;
  }
});
