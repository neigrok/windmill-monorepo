import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The row stand-in exercises the pinned host contract; the scene and HTTP boundaries are deterministic fakes.
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
import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
window.fixture = ${JSON.stringify(treeData)};
if (params.has('milestone')) window.fixture.nodes[1].status = 'complete';
if (params.has('single')) window.fixture.nodes = [{ ...window.fixture.nodes[0], status: 'none' }];
SyncSession.prototype.start = function () {
  this.store = { save: () => Promise.resolve() };
  this.registry = null;
  this.seed(window.fixture);
  for (const node of window.fixture.nodes) if (node.status === 'complete') this.markProgress(node.id, 'complete');
  window.session = this;
};
window.events = [];
window.issues = [];
window.ceremonies = [];
window.revealed = [];
window.copied = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text) => { window.copied.push(text); },
} });
createRoot(document.getElementById('root')).render(React.createElement(SkillTreeView, { treeId: 't_sail' }));
`;
const identity = `
import React, { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { ViewSwitch } from '/src/products/roadmap/board/ViewSwitch.jsx';
import { FindStep } from '/src/products/roadmap/board/BoardControls.jsx';
export function RoadmapIdentity(props) {
  if (new URLSearchParams(location.search).has('crash')) throw new Error('Fixture row failure');
  const [menu, setMenu] = useState(false);
  const [nextOpen, setNextOpen] = useState(false);
  const nextRef = useRef(null);
  useEffect(() => { window.rowMounts = (window.rowMounts ?? 0) + 1; }, []);
  useLayoutEffect(() => props.onBottom(112), [props.onBottom]);
  window.sheetContract = props.sheet;
  window.identity = { band: props.band, role: props.role, view: props.view, title: props.title,
    progress: props.progress, next: props.next && { count: props.next.count, cards: props.next.cards.map(({ id }) => id) },
    sheet: props.sheet && props.sheet.current, find: !!props.find };
  const actions = [['Ask AI', props.onAskAI], ['Share', props.onShare], ['New step', props.onNewStep], ['Fork', props.onFork]];
  const more = [['Export', props.onExport], ['Settings', props.onSettings], ['Keyboard shortcuts', props.onShortcuts]];
  return React.createElement('header', { 'data-testid': 'identity-contract', style: { position: 'relative', zIndex: 40, display: 'flex', gap: 8, background: 'var(--surface-card)' } },
    React.createElement('h1', null, props.title),
    props.onSwitchView && React.createElement(ViewSwitch, { view: props.view, onSwitch: props.onSwitchView }),
    props.find && React.createElement(FindStep, props.find),
    ...actions.filter(([, callback]) => callback).map(([label, callback]) => React.createElement('button', { key: label, onClick: callback }, label)),
    props.next && React.createElement('button', { ref: nextRef, onClick: () => setNextOpen(!nextOpen) }, 'Next · ' + props.next.count),
    nextOpen && props.next && React.createElement('div', { role: 'dialog', 'aria-label': 'What is next' },
      ...props.next.cards.map((card) => React.createElement('button', { key: card.id, onClick: () => {
        props.next.onOpen(card.id); setNextOpen(false); nextRef.current.focus();
      } }, card.step.label))),
    props.onExport && React.createElement('button', { 'aria-haspopup': 'menu', onClick: () => setMenu(!menu) }, 'More'),
    menu && React.createElement('div', { role: 'menu' }, ...more.filter(([, callback]) => callback).map(([label, callback]) =>
      React.createElement('button', { key: label, role: 'menuitem', onClick: () => { setMenu(false); callback(); } }, label))),
  );
}
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
    this.setViewportInsets = (insets) => { window.cameraInsets = insets; };
    this.revealNode = (id) => { window.revealed.push(id); };
    this.announceCeremony = (message, options) => { window.ceremonies.push({ message, action: options?.action?.label ?? null }); };
    this.select = (id) => options.onNodePick(id);
    window.scene = new Proxy(this, { get(target, property) { return property in target ? target[property] : () => {}; } });
    return window.scene;
  }
}
`;
const auth = `
const owner = new URLSearchParams(location.search).get('role') !== 'reader';
const account = owner ? { id: 'u_fixture' } : null;
const refresh = async () => {};
export const useAuth = () => ({ status: owner ? 'signed-in' : 'ghost', account, refresh });
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-roadmap-host-test`,
    plugins: [{ name: 'roadmap-host-contract-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/roadmap-host-entry.js') return '\0host-entry';
        if (id.endsWith('/board/RoadmapIdentity.jsx')) return '\0host-identity';
        if (id.endsWith('/scene/SkillTreeScene.js')) return '\0host-scene';
        if (id.endsWith('/shell/auth/AuthProvider.jsx')) return '\0host-auth';
        if (id.endsWith('/shell/auth/SignInDoor.jsx')) return '\0host-signin';
        if (id.endsWith('/telemetry/beacon.js')) return '\0host-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0host-issues';
      },
      load(id) {
        if (id === '\0host-entry') return entry;
        if (id === '\0host-identity') return identity;
        if (id === '\0host-scene') return scene;
        if (id === '\0host-auth') return auth;
        if (id === '\0host-signin') return 'export const useSignInDoor = () => () => {};';
        if (id === '\0host-events') return 'export function track(name, props) { window.events.push({ name, props }); } export function reportError(error) { window.issues.push({ operation: "reportError" }); }';
        if (id === '\0host-issues') return 'export function captureError(product, operation, stack) { window.issues.push({ operation, stack: !!stack }); }';
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

async function openHost({ width = 1440, role = 'owner', gate = 'open', surface = 'tree', milestone = false, single = false, crash = false } = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/v1/me') body = { user: role === 'owner' ? { id: 'u_fixture' } : null };
    if (path === '/v1/tending') body = { enabled: true, runs: [] };
    if (path === '/v1/trees/t_sail') {
      const data = structuredClone(treeData);
      if (milestone) data.nodes[1].status = 'complete';
      if (single) data.nodes = [{ ...data.nodes[0], status: 'none' }];
      body = { data, mine: role === 'owner', visibility: 'public' };
    }
    if (path === '/v1/trees') body = { trees: [] };
    if (path.endsWith('/activity')) body = { events: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const params = new URLSearchParams({ role, gate, surface });
  if (role === 'reader') params.set('view', '1');
  if (milestone) params.set('milestone', '1');
  if (single) params.set('single', '1');
  if (crash) params.set('crash', '1');
  await page.goto(`${origin}/roadmap-host-test?${params}#/app/t_sail`);
  await page.waitForFunction(() => !!window.session?.ready);
  if (gate === 'open' && !crash) await page.waitForFunction(() => window.identity?.title === 'Learn to sail');
  return { page, errors };
}

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1024, 'desktop'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    for (const surface of ['tree', 'board']) {
      test(`Chromium: host identity contract ${width}px ${role} ${surface}`, async () => {
        const { page, errors } = await openHost({ width, role, surface });
        try {
          await page.waitForFunction((surface) => window.identity?.view === surface, surface);
          assert.deepEqual(await page.evaluate(() => ({
            band: window.identity.band, role: window.identity.role, view: window.identity.view,
            title: window.identity.title, progress: window.identity.progress,
            next: window.identity.next, sheet: !!window.identity.sheet,
          })), {
            band, role, view: surface, title: 'Learn to sail', progress: { done: 1, total: 3 },
            next: surface === 'tree' && role === 'owner' && band !== 'phone' ? { count: 1, cards: ['wind'] } : null,
            sheet: band === 'phone' && role === 'owner',
          });
          assert.equal(await page.locator('[data-testid="identity-contract"]').count(), 1);
          assert.equal(await page.locator('.st-action-lane').count(), 0);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    test(`Chromium: gate-closed host keeps legacy ${band} ${role} chrome`, async () => {
      const { page, errors } = await openHost({ width, role, gate: 'closed' });
      try {
        assert.deepEqual(await page.evaluate(() => ({
          identity: document.querySelectorAll('.st-roadmap-identity-host').length,
          topbar: document.querySelectorAll('.st-topbar').length,
          mobile: document.querySelectorAll('.st-mobile-chrome').length,
          camera: document.querySelectorAll('.st-graph-camera').length,
          hash: location.hash,
          gatedEvents: window.events.filter(({ name }) => ['roadmap_graph_find', 'roadmap_graph_toast', 'roadmap_verb', 'roadmap_sheet'].includes(name)),
        })), { identity: 0, topbar: band === 'desktop' && role === 'owner' ? 1 : 0,
          mobile: band === 'desktop' && role === 'owner' ? 0 : 1, camera: 0, hash: '#/app/t_sail', gatedEvents: [] });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

test('Chromium: Graph Find hands off without replacing the row or losing input focus; G keeps switch focus', async () => {
  const { page, errors } = await openHost();
  try {
    await page.keyboard.press('/');
    const find = page.getByRole('searchbox');
    await find.fill('wind');
    await page.waitForFunction(() => window.identity.view === 'board');
    assert.deepEqual(await find.evaluate((input) => [input.value, document.activeElement === input, window.rowMounts]), ['wind', true, 1]);
    await find.press('Escape');
    await find.press('Escape');
    await page.locator('.st-board-switch-option[aria-pressed="true"]').focus();
    await page.keyboard.press('g');
    await page.waitForFunction(() => window.identity.view === 'tree');
    assert.equal(await page.locator('.st-board-switch-option[aria-pressed="true"]').evaluate((button) => document.activeElement === button), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_find')), [{ name: 'roadmap_graph_find', props: { step: 'handoff' } }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: row Share, Ask AI and More shortcuts return focus; Export downloads and Settings navigates', async () => {
  const { page, errors } = await openHost();
  try {
    const row = page.getByTestId('identity-contract');
    await row.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('dialog', { name: 'Share roadmap' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Share');
    await row.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Tell the tree what to change' });
    await prompt.waitFor();
    await prompt.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Ask AI');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent === 'More');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export' }).click();
    assert.equal((await download).suggestedFilename(), 'learn-to-sail-sail.md');
    await page.waitForFunction(() => document.activeElement?.textContent === 'More');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_export')), [{ name: 'roadmap_export', props: { outcome: 'done', door: 'more' } }]);
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.waitForFunction(() => location.pathname === '/app/settings');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: Next picks and reveals a Graph step; completion toast Undo restores its mark', async () => {
  const { page, errors } = await openHost();
  try {
    await page.getByRole('button', { name: 'Next · 1', exact: true }).click();
    await page.getByRole('dialog', { name: 'What is next' }).getByRole('button', { name: 'Read the wind', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => [window.revealed.at(-1), document.activeElement?.textContent]), ['wind', 'Next · 1']);
    await page.getByRole('button', { name: 'Complete step', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    assert.equal(await page.locator('.st-board-toast-message').textContent(), 'Read the wind done · Leave the dock up next');
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => window.identity.progress.done === 1);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_toast')), [
      { name: 'roadmap_graph_toast', props: { act: 'complete', step: 'shown' } },
      { name: 'roadmap_graph_toast', props: { act: 'complete', step: 'undo' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: Graph create reveals the step and Undo removes only that create', async () => {
  const { page, errors } = await openHost();
  try {
    await page.getByTestId('identity-contract').getByRole('button', { name: 'New step', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Practice knots');
    await page.getByRole('button', { name: 'Create step', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    assert.equal(await page.evaluate(() => window.identity.progress.total), 4);
    const created = await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ label }) => label === 'Practice knots').id);
    assert.equal(await page.evaluate(() => window.revealed.at(-1)), created);
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => window.identity.progress.total === 3);
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort()), ['course', 'dock', 'wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: a Graph milestone keeps the canvas ceremony and reader Share/Fork reach their doors', async () => {
  const owner = await openHost({ milestone: true });
  try {
    await owner.page.evaluate(() => window.scene.select('dock'));
    await owner.page.getByRole('button', { name: 'Complete step', exact: true }).click();
    await owner.page.waitForFunction(() => window.ceremonies.length > 0);
    assert.deepEqual(await owner.page.evaluate(() => window.ceremonies), [{ message: 'Tree complete — 3/3 steps.', action: 'Share it' }]);
    assert.equal(await owner.page.locator('.st-graph-toast').count(), 0);
    assert.deepEqual(owner.errors, []);
  } finally { await owner.page.close(); }
  const reader = await openHost({ role: 'reader' });
  try {
    await reader.page.getByRole('button', { name: 'Share', exact: true }).click();
    await reader.page.locator('.st-graph-toast').waitFor();
    assert.equal(await reader.page.locator('.st-board-toast-message').textContent(), 'Link copied');
    assert.deepEqual(await reader.page.evaluate(() => window.copied), [`${origin}/t/t_sail`]);
    await reader.page.getByRole('button', { name: 'Fork', exact: true }).click();
    await reader.page.getByRole('heading', { name: 'Make it yours' }).waitFor();
    await reader.page.keyboard.press('Escape');
    await reader.page.waitForFunction(() => document.activeElement?.textContent === 'Fork');
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
});

for (const width of [744, 1440]) {
  test(`Chromium: the Graph camera clears the selected-step dock at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.waitForFunction(() => window.cameraInsets.right > 100);
      const camera = await page.locator('.st-graph-camera').evaluate((element) => ({
        right: Number.parseFloat(element.style.right), bottom: Number.parseFloat(element.style.bottom),
        width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      }));
      const insets = await page.evaluate(() => window.cameraInsets);
      assert.deepEqual(camera, { right: Math.max(24, insets.right), bottom: Math.max(24, insets.bottom), width: 248, height: 50 });
      assert.deepEqual(insets.blocks.at(-1), { right: camera.right, bottom: camera.bottom, width: 248, height: 50 });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test('Chromium: one unfinished step has Next · 1 and a completed roadmap has no Next chip', async () => {
  const { page, errors } = await openHost({ single: true });
  try {
    assert.deepEqual(await page.evaluate(() => window.identity.next), { count: 1, cards: ['course'] });
    await page.evaluate(() => window.scene.select('course'));
    await page.getByRole('button', { name: 'Complete step', exact: true }).click();
    await page.waitForFunction(() => window.identity.progress.done === 1);
    assert.equal(await page.evaluate(() => window.identity.next), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: phone sheet receives current roadmap data and navigation callbacks', async () => {
  const { page, errors } = await openHost({ width: 390 });
  try {
    assert.deepEqual(await page.evaluate(() => window.sheetContract.current), {
      id: 't_sail', title: 'Learn to sail', done: 1, total: 3, dominantKind: 'terracotta',
    });
    assert.deepEqual(await page.evaluate(() => window.sheetContract.listTrees()), []);
    for (const [action, expected] of [['onPickTree', '#/app/t_other'], ['onNewRoadmap', '#/app/new'], ['onBrowse', '#/browse']]) {
      await page.evaluate((action) => window.sheetContract[action]('t_other'), action);
      await page.waitForFunction((hash) => location.hash === hash, expected);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [width, role] of [[390, 'owner'], [744, 'reader'], [1440, 'owner']]) {
  test(`Chromium: identity crash restores legacy home and a switch at ${width}px for ${role}`, async () => {
    const { page } = await openHost({ width, role, crash: true });
    try {
      await page.locator('.st-roadmap-identity-fallback').waitFor();
      assert.equal(await page.getByRole('link', { name: 'Windmill — home' }).count(), 1);
      assert.equal(await page.locator('.st-roadmap-fallback-switch .st-board-switch-option').count(), 2);
      assert.deepEqual(await page.evaluate(() => window.issues.filter(({ operation }) => operation === 'roadmap-identity')),
        [{ operation: 'roadmap-identity', stack: true }]);
    } finally { await page.close(); }
  });
}
