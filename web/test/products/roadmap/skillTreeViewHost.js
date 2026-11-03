import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { beacon } from './board/composerFixture.js';

// The real identity row exercises the host contract; scene and HTTP boundaries are deterministic fakes.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const treeData = {
  id: 't_sail', title: 'Learn to sail', kinds: [], nodes: [
    { id: 'course', label: 'Choose a course', color: 'terracotta', prerequisites: [], status: 'complete' },
    { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['course'] },
    { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'] },
  ],
};
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
import { SyncStore } from '/src/products/roadmap/sync/SyncStore.js';
import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { getRoomStatus } from '/src/shell/roomStatus.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
window.fixture = ${JSON.stringify(treeData)};
if (params.has('milestone')) window.fixture.nodes[1].status = 'complete';
if (params.has('single')) window.fixture.nodes = [{ ...window.fixture.nodes[0], status: 'none' }];
if (params.has('large')) window.fixture.nodes.push(...Array.from({ length: 997 }, (_, index) => ({ id: 'extra-' + index, label: 'Practice ' + index, prerequisites: ['wind'], color: 'terracotta' })));
if (params.has('empty')) window.fixture.nodes = [];
if (params.has('legend')) {
  window.fixture.kinds = [{ id: 'build', hue: 'terracotta', label: 'Build' }, { id: 'learn', hue: 'olive', label: 'Learn' }];
  window.fixture.nodes[1].color = 'olive';
}
SyncSession.prototype.start = async function () {
  this.store = new SyncStore();
  this.scheduleReconnect = () => {};
  this.forceReconnect = () => { window.reconnects = (window.reconnects ?? 0) + 1; };
  this.registry = null;
  this.seed(window.fixture);
  for (const node of window.fixture.nodes) if (node.status === 'complete') this.markProgress(node.id, 'complete');
  this.phase = 'live';
  this.ackedServerVector = this.lattice.frontier();
  this.ackedProgressVector = this.progress.join(this.progress.toFrame());
  window.serverTree = this.lattice.toFrame();
  window.serverProgress = this.progress.toFrame();
  this.receiveState({ ...window.serverTree, seq: 1 });
  this.receiveProgressGraft(window.serverProgress);
  this.ready = false;
  await this.persistNow();
  this.ready = true;
  this.emitTree();
  this.emitStatus();
  window.session = this;
};
window.events = [];
window.issues = [];
window.ceremonies = [];
window.revealed = [];
window.revealFrames = [];
window.copied = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text) => {
    if (params.has('clipboardRefused')) throw new DOMException('Fixture clipboard refusal', 'NotAllowedError');
    window.copied.push(text);
  },
} });
if (params.has('crash')) {
  const Observer = window.ResizeObserver;
  window.ResizeObserver = class extends Observer {
    observe(element, options) {
      if (element.classList.contains('st-roadmap-identity')) throw new Error('Fixture identity measurement failure');
      super.observe(element, options);
    }
  };
}
window.roomStatus = getRoomStatus;
const props = { treeId: 't_sail', demo: params.has('demo') };
const content = params.has('shell')
  ? React.createElement(Shell, { location: { pathname: '/app', hash: location.hash, search: location.search }, neutral: { Component: SkillTreeView, props } })
  : React.createElement(SkillTreeView, props);
createRoot(document.getElementById('root')).render(content);
`;
const scene = `
export class SkillTreeScene {
  constructor(canvas, options) {
    this.options = options;
    this.nodesById = new Map();
    this.selectedIds = new Set();
    this.selectedEdge = null;
    this.getBounds = () => ({ minX: 0, minY: 0, maxX: 500, maxY: 500 });
    this.getViewpoint = () => ({ x: 0, y: 0, zoom: 1 });
    this.getViewport = this.getBounds;
    this.subscribeViewport = () => () => {};
    this.isPointerActive = () => false;
    this.setModel = (model) => { this.nodesById = new Map(model.nodes.map((node) => [node.id, node])); };
    this.applyModel = this.setModel;
    this.setViewportInsets = (insets) => { window.cameraInsets = insets; };
    this.revealNode = (id) => {
      window.revealed.push(id);
      window.revealFrames.push({ id, insets: window.cameraInsets, installed: this.nodesById.has(id) });
    };
    this.announceCeremony = (message, options) => { window.ceremonies.push({ message, action: options?.action?.label ?? null }); };
    this.select = (id) => options.onNodePick(id);
    window.scene = new Proxy(this, { get(target, property) { return property in target ? target[property] : () => {}; } });
    return window.scene;
  }
}
`;
const auth = `
import { useSyncExternalStore } from 'react';
const owner = new URLSearchParams(location.search).get('role') === 'owner';
const account = { id: 'u_fixture' };
const user = { name: 'Ada' };
const refresh = async () => null;
let status = owner ? 'signed-in' : 'ghost';
const listeners = new Set();
const subscribe = (handler) => { listeners.add(handler); return () => listeners.delete(handler); };
window.setFixtureAuth = (next) => { status = next; for (const listener of listeners) listener(); };
export const useAuth = () => {
  const current = useSyncExternalStore(subscribe, () => status);
  return { status: current, user: current === 'signed-in' ? user : null, account: current === 'signed-in' ? account : null, refresh };
};
`;
export let origin;
let server, browser, ready;

export function startRoadmapHost(concern) {
  ready = (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-roadmap-host-${concern}-test`,
      plugins: [{ name: 'roadmap-host-contract-test', enforce: 'pre',
        resolveId(id, importer) {
          if (id === '/roadmap-host-entry.js') return '\0host-entry';
          const file = id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
          if (file.endsWith('/scene/SkillTreeScene.js')) return '\0host-scene';
          if (file.endsWith('/shell/auth/AuthProvider.jsx')) return '\0host-auth';
          if (file.endsWith('/shell/auth/SignInDoor.jsx')) return '\0host-signin';
          if (file.endsWith('/telemetry/beacon.js')) return '\0host-events';
          if (file.endsWith('/telemetry/sentry.js')) return '\0host-issues';
        },
        load(id) {
          if (id === '\0host-entry') return entry;
          if (id === '\0host-scene') return scene;
          if (id === '\0host-auth') return auth;
          if (id === '\0host-signin') return 'const open = () => { window.signInOpened = (window.signInOpened ?? 0) + 1; }; export const useSignInDoor = () => open; export const useSignInDoorHost = () => () => {};';
          if (id === '\0host-events') return beacon;
          if (id === '\0host-issues') return 'export function captureError(product, operation, stack, route, tags) { window.issues.push({ operation, stack: !!stack, ...(tags ? { tags } : {}) }); }';
        },
        configureServer(server) {
          server.middlewares.use('/roadmap-host-test', (request, response) => {
            const params = new URL(request.url, 'http://localhost').searchParams;
            const gate = params.get('gate') !== 'closed';
            const view = params.get('surface') ?? 'tree';
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><script>localStorage.clear();localStorage.setItem("windmill:board:dev",' + JSON.stringify(gate ? '1' : '0') + ');localStorage.setItem("windmill:view:last",JSON.stringify({t_sail:' + JSON.stringify(view) + '}));</script><div id="root" style="height:100vh"></div><script type="module" src="/roadmap-host-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });
}

const runningTest = new AsyncLocalStorage();
export function hostTest(name, run) {
  test(name, async () => {
    let fail;
    const failure = new Promise((_resolve, reject) => { fail = reject; });
    await runningTest.run({ fail }, () => Promise.race([run(), failure]));
  });
}

export async function openHost({ width = 1440, height = 1000, role = 'owner', gate = 'open', surface = 'tree', milestone = false, single = false, crash = false, demo = false, clipboardRefused = false, large = false, empty = false, shell = false, legend = false, fixedClock = false } = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);

  const errors = [];
  const { fail } = runningTest.getStore();
  const report = (message) => {
    if (crash && (message.includes('Fixture identity measurement failure') || message.includes('The above error occurred in the <RoadmapIdentity> component'))) return;
    errors.push(message);
    fail(new Error(message));
    void page.close();
  };
  page.on('pageerror', (error) => report(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error') report(message.text()); });
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/v1/me') body = { user: role === 'owner' ? { id: 'u_fixture' } : null };
    if (path === '/v1/tending') body = { enabled: true, runs: [] };
    if (path === '/v1/trees/t_sail') {
      const data = structuredClone(treeData);
      if (milestone) data.nodes[1].status = 'complete';
      if (single) data.nodes = [{ ...data.nodes[0], status: 'none' }];
      if (large) data.nodes.push(...Array.from({ length: 997 }, (_, index) => ({ id: 'extra-' + index, label: 'Practice ' + index, prerequisites: ['wind'], color: 'terracotta' })));
      if (empty) data.nodes = [];
      if (legend) {
        data.kinds = [{ id: 'build', hue: 'terracotta', label: 'Build' }, { id: 'learn', hue: 'olive', label: 'Learn' }];
        data.nodes[1].color = 'olive';
      }
      body = { data, mine: role !== 'reader', visibility: 'public' };
    }
    if (path === '/v1/trees') body = { trees: [{ id: 't_other', title: 'Spanish basics', done: 12, total: 40, dominantKind: 'sky' }] };
    if (path.endsWith('/activity')) body = { events: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const params = new URLSearchParams({ role, gate, surface });
  if (role === 'reader') params.set('view', '1');
  for (const [name, enabled] of Object.entries({ milestone, single, crash, demo, clipboardRefused, large, empty, shell, legend })) {
    if (enabled) params.set(name, '1');
  }
  await page.goto(`${origin}/roadmap-host-test?${params}#/app/t_sail`);
  await page.waitForFunction(() => !!window.session?.ready);
  if (gate === 'open' && !crash && !demo) await page.locator('.st-roadmap-progress').waitFor();
  if (role === 'reader' && gate === 'open' && surface === 'board') await page.getByRole('button', { name: 'Board', exact: true }).click();
  if (fixedClock) {
    await page.clock.install({ time: new Date('2026-11-03T11:59:00Z') });
    await page.clock.pauseAt(new Date('2026-11-03T12:00:00Z'));
  }
  return { page, errors };
}
