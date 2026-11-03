import test, { after } from 'node:test';
import assert from 'node:assert/strict';
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
import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
window.fixture = ${JSON.stringify(treeData)};
if (params.has('milestone')) window.fixture.nodes[1].status = 'complete';
if (params.has('single')) window.fixture.nodes = [{ ...window.fixture.nodes[0], status: 'none' }];
if (params.has('large')) window.fixture.nodes.push(...Array.from({ length: 997 }, (_, index) => ({ id: 'extra-' + index, label: 'Practice ' + index, prerequisites: ['wind'], color: 'terracotta' })));
if (params.has('empty')) window.fixture.nodes = [];
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
const owner = new URLSearchParams(location.search).get('role') === 'owner';
const account = owner ? { id: 'u_fixture' } : null;
const refresh = async () => {};
export const useAuth = () => ({ status: owner ? 'signed-in' : 'ghost', account, refresh });
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-roadmap-host-test`,
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
        if (id === '\0host-signin') return 'export const useSignInDoor = () => () => { window.signInOpened = (window.signInOpened ?? 0) + 1; }; export const useSignInDoorHost = () => () => {};';
        if (id === '\0host-events') return beacon;
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

const runningTest = new AsyncLocalStorage();
function hostTest(name, run) {
  test(name, async () => {
    let fail;
    const failure = new Promise((_resolve, reject) => { fail = reject; });
    await runningTest.run({ fail }, () => Promise.race([run(), failure]));
  });
}

async function openHost({ width = 1440, role = 'owner', gate = 'open', surface = 'tree', milestone = false, single = false, crash = false, demo = false, clipboardRefused = false, large = false, empty = false, shell = false } = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
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
      body = { data, mine: role !== 'reader', visibility: 'public' };
    }
    if (path === '/v1/trees') body = { trees: [{ id: 't_other', title: 'Spanish basics', done: 12, total: 40, dominantKind: 'sky' }] };
    if (path.endsWith('/activity')) body = { events: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const params = new URLSearchParams({ role, gate, surface });
  if (role === 'reader') params.set('view', '1');
  for (const [name, enabled] of Object.entries({ milestone, single, crash, demo, clipboardRefused, large, empty, shell })) {
    if (enabled) params.set(name, '1');
  }
  await page.goto(`${origin}/roadmap-host-test?${params}#/app/t_sail`);
  await page.waitForFunction(() => !!window.session?.ready);
  if (gate === 'open' && !crash && !demo) await page.locator('.st-roadmap-progress').waitFor();
  return { page, errors };
}

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1024, 'desktop'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    for (const surface of ['tree', 'board']) {
      hostTest(`Chromium: host identity contract ${width}px ${role} ${surface}`, async () => {
        const { page, errors } = await openHost({ width, role, surface });
        try {
          await page.waitForFunction((surface) => document.querySelector('.st-roadmap-identity')?.dataset.view === surface, surface);
          assert.deepEqual(await page.locator('.st-roadmap-identity').evaluate((row) => ({
            band: ['phone', 'tablet', 'desktop'].find((value) => row.classList.contains('st-roadmap-identity--' + value)),
            role: row.dataset.role, view: row.dataset.view,
            title: row.querySelector('.st-roadmap-context').textContent,
            progress: row.querySelector('.st-roadmap-progress').getAttribute('aria-label'),
            next: row.querySelector('[aria-label="Next · 1"]') !== null,
            sheet: row.querySelector('.st-roadmap-title-button') !== null,
          })), {
            band, role, view: surface, title: 'Learn to sail', progress: '1 of 3 steps done',
            next: surface === 'tree' && role === 'owner' && band !== 'phone',
            sheet: band === 'phone' && role === 'owner',
          });
          assert.equal(await page.locator('.st-roadmap-identity').count(), 1);
          assert.equal(await page.locator('.st-action-lane').count(), 0);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    hostTest(`Chromium: gate-closed host keeps legacy ${band} ${role} chrome`, async () => {
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

hostTest('Chromium: Graph Find hands off without replacing the row or losing input focus; G keeps switch focus', async () => {
  const { page, errors } = await openHost();
  try {
    await page.evaluate(() => { window.originalRow = document.querySelector('.st-roadmap-identity'); });
    await page.keyboard.press('/');
    const find = page.getByRole('searchbox');
    await find.fill('wind');
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
    assert.deepEqual(await find.evaluate((input) => [input.value, document.activeElement === input, window.originalRow === document.querySelector('.st-roadmap-identity')]), ['wind', true, true]);
    await find.press('Escape');
    await find.press('Escape');
    await page.locator('.st-board-switch-option[aria-pressed="true"]').focus();
    await page.keyboard.press('g');
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'tree');
    assert.equal(await page.locator('.st-board-switch-option[aria-pressed="true"]').evaluate((button) => document.activeElement === button), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_find')), [{ name: 'roadmap_graph_find', props: { step: 'handoff' } }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: row Share, Ask AI and More shortcuts return focus; Export downloads and Settings navigates', async () => {
  const { page, errors } = await openHost();
  try {
    const row = page.locator('.st-roadmap-identity');
    assert.equal(await row.locator('.st-roadmap-switcher [aria-haspopup="menu"]').count(), 1);
    await row.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: 'Share roadmap' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Share');
    await row.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Tell the tree what to change' });
    await prompt.waitFor();
    await prompt.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ask AI');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export' }).click();
    assert.equal((await download).suggestedFilename(), 'learn-to-sail-sail.md');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_export')), [{ name: 'roadmap_export', props: { outcome: 'done', door: 'more' } }]);
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.waitForFunction(() => location.pathname === '/app/settings');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Next picks and reveals a Graph step; completion toast Undo restores its mark', async () => {
  const { page, errors } = await openHost();
  try {
    await page.getByRole('button', { name: 'Next · 1', exact: true }).click();
    await page.getByRole('dialog', { name: '1 up next' }).locator('.st-roadmap-next-card').filter({ hasText: 'Read the wind' }).click();
    assert.deepEqual(await page.evaluate(() => [window.revealed.at(-1), document.activeElement?.textContent]), ['wind', 'Next · 1']);
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    assert.equal(await page.locator('.st-board-toast-message').textContent(), 'Read the wind done · Leave the dock up next');
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 3 steps done');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_toast')), [
      { name: 'roadmap_graph_toast', props: { act: 'complete', step: 'shown' } },
      { name: 'roadmap_graph_toast', props: { act: 'complete', step: 'undo' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Graph create reveals the step and Undo removes only that create', async () => {
  const { page, errors } = await openHost();
  try {
    const create = page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true });
    await create.click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Practice knots');
    await page.getByRole('button', { name: 'Create step', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    assert.equal(await page.locator('.st-roadmap-progress').getAttribute('aria-label'), '1 of 4 steps done');
    const created = await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ label }) => label === 'Practice knots').id);
    await page.waitForFunction((id) => window.revealFrames.at(-1)?.id === id, created);
    assert.deepEqual(await page.evaluate(() => {
      const frame = window.revealFrames.at(-1);
      return { id: frame.id, installed: frame.installed, right: frame.insets.right };
    }), { id: created, installed: true, right: 408 });
    const previousReveals = await page.evaluate(() => window.revealed.length);
    await page.locator('.st-board-toast-message').click();
    await page.waitForFunction((previous) => window.revealed.length > previous, previousReveals);
    assert.equal(await page.evaluate(() => window.revealed.at(-1)), created);
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 3 steps done');
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort()), ['course', 'dock', 'wind']);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'New step');
    assert.equal(await create.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a Graph milestone keeps the canvas ceremony and reader Share/Fork reach their doors', async () => {
  const owner = await openHost({ milestone: true });
  try {
    await owner.page.evaluate(() => window.scene.select('dock'));
    await owner.page.getByRole('button', { name: 'Complete', exact: true }).click();
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
    await reader.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Fork');
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
});

for (const width of [744, 1440]) {
  hostTest(`Chromium: the Graph camera clears the selected-step dock at ${width}px`, async () => {
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

hostTest('Chromium: one unfinished step has Next · 1 and a completed roadmap has no Next chip', async () => {
  const { page, errors } = await openHost({ single: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 1);
    await page.evaluate(() => window.scene.select('course'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 1 step done');
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [label, expected] of [['Spanish basics', '#/app/t_other'], ['New roadmap', '#/app/new'], ['Planted in public', '#/browse']]) {
  hostTest(`Chromium: real phone sheet navigates via ${label}`, async () => {
    const { page, errors } = await openHost({ width: 390 });
    try {
      await page.locator('.st-roadmap-title-button').click();
      const sheet = page.getByRole('dialog', { name: 'Roadmap', exact: true });
      await sheet.waitFor();
      assert.deepEqual(await sheet.locator('[aria-current="true"]').evaluate((row) => ({
        title: row.querySelector('.st-roadmap-sheet-tree-name').textContent,
        count: row.querySelector('.st-roadmap-sheet-count').textContent,
      })), { title: 'Learn to sail', count: '1/3' });
      await sheet.getByRole('button', { name: label, exact: label !== 'Spanish basics' }).click();
      await page.waitForFunction((hash) => location.hash === hash, expected);
      assert.equal(await page.getByRole('dialog', { name: 'Roadmap', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const [width, role] of [[390, 'owner'], [744, 'reader'], [1440, 'owner']]) {
  hostTest(`Chromium: identity crash restores legacy home and a switch at ${width}px for ${role}`, async () => {
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

for (const key of ['?', 'Meta+k']) {
  hostTest(`Chromium: ${key} opened from a Board card restores that card rather than a stale row trigger`, async () => {
    const { page, errors } = await openHost({ surface: 'board' });
    try {
      const more = page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true });
      await more.click();
      await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
      await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
      const card = page.locator('.st-board-card[data-step-id="wind"]');
      await card.focus();
      await page.keyboard.press(key);
      if (key === '?') await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
      else await page.getByRole('textbox', { name: 'Tell the tree what to change' }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.matches('.st-board-card[data-step-id="wind"]'));
      assert.equal(await card.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: Graph completion Undo returns to its Complete action after unrelated row activity', async () => {
  const { page, errors } = await openHost();
  try {
    await page.evaluate(() => window.scene.select('wind'));
    const complete = page.getByRole('button', { name: 'Complete', exact: true });
    await complete.click();
    await page.locator('.st-graph-toast').waitFor();
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('.st-board-toast-undo').click();
    await complete.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Complete');
    assert.equal(await complete.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: clipboard refusal emits no successful share beacon or link toast', async () => {
  const { page, errors } = await openHost({ role: 'reader', clipboardRefused: true });
  try {
    const share = page.locator('.st-roadmap-identity').getByRole('button', { name: 'Share', exact: true });
    await share.click();
    await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_graph_toast' && props.act === 'link' && props.outcome === 'failed'));
    assert.deepEqual(await page.evaluate(() => ({
      copies: window.copied,
      shares: window.events.filter(({ name }) => name === 'link_copy'),
      issues: window.issues,
      toasts: window.events.filter(({ name }) => name === 'roadmap_graph_toast'),
    })), { copies: [], shares: [], issues: [], toasts: [{ name: 'roadmap_graph_toast', props: { act: 'link', outcome: 'failed' } }] });
    assert.equal(await share.evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.locator('.st-graph-toast').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the demo Board slash shortcut focuses the displayed demo Find field', async () => {
  const { page, errors } = await openHost({ surface: 'board', demo: true });
  try {
    const find = page.locator('.st-demo-board-identity .st-board-find-input');
    await find.waitFor();
    await page.locator('.st-board-card').first().focus();
    await page.keyboard.press('/');
    assert.equal(await find.evaluate((element) => document.activeElement === element), true);
    await find.fill('wind');
    assert.equal(await find.inputValue(), 'wind');
    assert.equal(await page.locator('.st-roadmap-identity').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [320, 390, 744]) {
  hostTest(`Chromium: the device-only Graph keeps its honesty nudge reachable at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'ghost' });
    try {
      const nudge = page.getByRole('button', { name: 'Saved on this device — sign in to keep it →', exact: true });
      await nudge.waitFor();
      assert.equal(await nudge.count(), 1);
      assert.equal(await nudge.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
      }), true);
      await page.waitForFunction(() => {
        const notice = document.querySelector('.st-roadmap-device-nudge')?.getBoundingClientRect();
        const camera = document.querySelector('.st-mobile-chrome [aria-label="Camera"]')?.getBoundingClientRect();
        return notice && camera && (camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left);
      });
      assert.equal(await page.locator('.st-roadmap-device-nudge').evaluate((element) => {
        const notice = element.getBoundingClientRect();
        const camera = document.querySelector('.st-mobile-chrome [aria-label="Camera"]').getBoundingClientRect();
        return camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left;
      }), true);
      if (width === 744) {
        assert.equal(await page.locator('.st-roadmap-device-nudge').evaluate((element) => element.getBoundingClientRect().left), 24);
      }
      await nudge.click();
      assert.equal(await page.evaluate(() => window.signInOpened), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: the phone Fork pill restores focus to the pill after dismissal', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader' });
  try {
    const fork = page.getByRole('button', { name: 'Fork this tree', exact: true });
    await fork.click();
    await page.getByRole('heading', { name: 'Make it yours' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Fork this tree');
    assert.equal(await fork.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: phone roadmap sheet receives exact unfiltered state counts from the host', async () => {
  const { page, errors } = await openHost({ width: 390, large: true });
  try {
    await page.locator('.st-roadmap-title-button').click();
    const sheet = page.getByRole('dialog', { name: 'Roadmap', exact: true });
    await sheet.waitFor();
    assert.equal(await sheet.locator('.st-roadmap-sheet-progress').textContent(), '1 done · 1 up next · 998 locked');
    assert.equal(await sheet.locator('[aria-current="true"] .st-roadmap-sheet-count').textContent(), '1/1k');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: empty Board creation cancel returns to the empty-state New step trigger', async () => {
  const { page, errors } = await openHost({ surface: 'board', empty: true });
  try {
    const create = page.locator('.st-view-layer--board').getByRole('button', { name: 'New step', exact: true });
    await create.click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await create.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: crash fallback switch and Board inset follow the measured legacy chrome', async () => {
  const { page, errors } = await openHost({ crash: true, surface: 'board' });
  try {
    const fallback = page.locator('.st-roadmap-identity-fallback');
    await fallback.waitFor();
    assert.equal(await fallback.locator('.st-zoom-group').isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-fallback-switch [aria-pressed="true"]'));
    const geometry = () => page.evaluate(() => {
      const chrome = document.querySelector('.st-roadmap-identity-fallback .st-topbar');
      const control = document.querySelector('.st-roadmap-fallback-switch');
      const board = document.querySelector('.st-board');
      return {
        chromeBottom: chrome.offsetTop + chrome.offsetHeight,
        switchTop: control.offsetTop,
        switchBottom: control.offsetTop + control.offsetHeight,
        boardPadding: Number.parseFloat(getComputedStyle(board).paddingTop),
      };
    });
    const before = await geometry();
    assert.equal(before.switchTop >= before.chromeBottom, true);
    assert.equal(before.boardPadding > before.switchBottom, true);
    await page.locator('.st-roadmap-identity-fallback .st-topbar').evaluate((element) => {
      element.style.paddingBottom = `${Number.parseFloat(getComputedStyle(element).paddingBottom) + 40}px`;
    });
    await page.waitForFunction((before) => {
      const control = document.querySelector('.st-roadmap-fallback-switch');
      const board = document.querySelector('.st-board');
      return control.offsetTop > before.switchTop && Number.parseFloat(getComputedStyle(board).paddingTop) > before.boardPadding;
    }, before);
    const after = await geometry();
    const growth = after.chromeBottom - before.chromeBottom;
    assert.equal(growth > 0, true);
    assert.deepEqual({ switch: after.switchTop - before.switchTop, board: after.boardPadding - before.boardPadding }, { switch: growth, board: growth });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [744, 1024, 1440]) {
  for (const menu of [false, true]) {
    hostTest(`Chromium: Board identity precedes cards and Tab exits ${menu ? 'open menu' : 'More'} at ${width}px`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board' });
      try {
        assert.equal(await page.evaluate(() => {
          const row = document.querySelector('.st-roadmap-identity');
          const board = document.querySelector('.st-board');
          return Boolean(row.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), true);
        const more = page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true });
        if (menu) await more.click();
        else await more.focus();
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.querySelector('.st-board')?.contains(document.activeElement));
        assert.equal(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[inert]')), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const width of [744, 1024, 1280, 1440]) {
  hostTest(`Chromium: Graph completion toast clears the open panel and camera at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.getByRole('button', { name: width < 1024 ? 'Mark done' : 'Complete', exact: true }).click();
      await page.locator('.st-graph-toast .st-board-toast').waitFor();
      await page.waitForFunction(() => {
        const toast = document.querySelector('.st-graph-toast .st-board-toast').getBoundingClientRect();
        const camera = document.querySelector('.st-graph-camera').getBoundingClientRect();
        const panel = document.querySelector('.st-detail-panel--open').getBoundingClientRect();
        return toast.right <= panel.left && (toast.bottom <= camera.top || toast.right <= camera.left || toast.left >= camera.right);
      });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: phone legacy reader toast clears Focus, and editor completion clears the action row', async () => {
  for (const role of ['reader', 'owner']) {
    const { page, errors } = await openHost({ width: 390, role });
    try {
      if (role === 'reader') {
        await page.evaluate(() => window.scene.options.onCeremonyToast('A roadmap update'));
        await page.locator('.st-toast').waitFor();
      } else {
        await page.evaluate(() => window.scene.select('wind'));
        await page.getByRole('button', { name: 'Mark done', exact: true }).click();
        await page.locator('.st-graph-toast .st-board-toast').waitFor();
      }
      await page.waitForFunction((role) => {
        const toast = document.querySelector('.st-graph-toast .st-board-toast, .st-toast').getBoundingClientRect();
        const camera = document.querySelector('.st-view-actions').getBoundingClientRect();
        const action = [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === 'Mark not done');
        return toast.top >= camera.bottom && (role === 'reader' || toast.bottom <= action.getBoundingClientRect().top);
      }, role);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

hostTest('Chromium: Ask AI dims and covers navigation outside the real shell room', async () => {
  const { page, errors } = await openHost({ shell: true });
  try {
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.getByRole('textbox', { name: 'Tell the tree what to change' }).waitFor();
    assert.deepEqual(await page.locator('.st-tend-overlay').evaluate((overlay) => {
      const rect = overlay.getBoundingClientRect();
      const head = document.querySelector('.wm-head').getBoundingClientRect();
      return {
        parent: overlay.parentElement.className,
        frame: [rect.left, rect.top, rect.right, rect.bottom],
        viewport: [0, 0, window.innerWidth, window.innerHeight],
        dims: getComputedStyle(overlay).backgroundColor !== 'rgba(0, 0, 0, 0)',
        coversNavigation: document.elementFromPoint(head.left + head.width / 2, head.top + head.height / 2) === overlay,
      };
    }), { parent: 'wm-shell', frame: [0, 0, 1440, 1000], viewport: [0, 0, 1440, 1000], dims: true, coversNavigation: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 744]) {
  hostTest(`Chromium: reader Board crash fallback retains home without Graph camera at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', crash: true, surface: 'board' });
    try {
      const fallback = page.locator('.st-roadmap-identity-fallback');
      await fallback.waitFor();
      assert.equal(await fallback.getByRole('link', { name: 'Windmill — home' }).count(), 1);
      assert.equal(await fallback.getByRole('group', { name: 'Camera', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
