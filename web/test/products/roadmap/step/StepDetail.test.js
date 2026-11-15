import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

import { STEP_DETAIL } from '../../../../src/products/roadmap/copy.js';
import { withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { startTransition, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { StepDetail } from '/src/products/roadmap/step/StepDetail.jsx';
import { StepComposer } from '/src/products/roadmap/step/StepComposer.jsx';
import { useStepAddress, stepIsStale } from '/src/products/roadmap/step/stepAddress.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { Openings } from '/src/products/roadmap/model/Opening.js';
import { TreeDoor } from '/src/products/roadmap/room/useTreeVisit.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { advanceProgress } from '/src/products/roadmap/model/progress.js';
import { toggleSubtask } from '/src/products/roadmap/model/NodeWorkspace.js';

const noop = () => {};
const call = (line) => (window.calls ??= []).push(line);
const bandOf = (width) => (width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop');
const without = (steps, id) => steps.filter((step) => step.id !== id).map((step) => ({ ...step, prerequisites: step.prerequisites.filter((need) => need !== id) }));

// Like the shell: the route follows the URL in a transition, and each roadmap is its own view, keyed by its id, that
// loads its tree a beat after it mounts.
window.openRoom = ({ nodes, completed, editable = true, workspaces = {}, kinds = [], linked = true, others = {}, editingEnabled = false, selectable = false, opens = {} }) => {
  const trees = { sail: nodes, ...others };
  const routeTree = () => window.location.hash.split('?')[0].replace('#/app/', '');
  function App() {
    const [treeId, setTreeId] = useState(routeTree);
    useEffect(() => {
      const follow = () => startTransition(() => setTreeId(routeTree()));
      window.addEventListener('hashchange', follow);
      window.addEventListener('popstate', follow);
      return () => {
        window.removeEventListener('hashchange', follow);
        window.removeEventListener('popstate', follow);
      };
    }, []);
    return React.createElement(Room, { key: treeId, treeId });
  }
  function Room({ treeId }) {
    const [steps, setSteps] = useState(null);
    useEffect(() => { Promise.resolve().then(() => setSteps(trees[treeId])); }, []);
    const tree = useMemo(() => (steps === null ? null : new SkillTree(Openings.fromWire(opens, steps).onto({ id: treeId, title: 'Learn to sail', nodes: steps }, { joined: true }))), [steps]);
    const [progress, setProgress] = useState({ completed: new Set(completed), completedAt: Object.fromEntries(completed.map((id, index) => [id, index + 1])) });
    const [selectedId, setSelectedId] = useState(null);
    const [editing, setEditing] = useState(null);
    const [spaces, setSpaces] = useState(workspaces);
    const [linkPrefix, setLinkPrefix] = useState(linked ? 'https://windmill.test/t/sail#?step=' : null);
    const [refusal, setRefusal] = useState(null);
    window.setLinkPrefix = setLinkPrefix;
    window.refuseSync = () => setRefusal({ code: 'server-error', count: 1, onRetry: () => setRefusal(null), onDiscard: () => setRefusal(null) });
    const [query, setQuery] = useState(() => new BoardQuery({ kinds }));
    const [quiet, setQuiet] = useState(0);
    const [breakpoint, setBreakpoint] = useState(() => bandOf(window.innerWidth));
    const address = useStepAddress();
    useEffect(() => {
      const follow = () => setBreakpoint(bandOf(window.innerWidth));
      window.addEventListener('resize', follow);
      return () => window.removeEventListener('resize', follow);
    }, []);
    useEffect(() => {
      if (editing && address.id !== editing) setEditing(null);
    }, [editing, address.id]);
    const stale = stepIsStale({ loading: tree === null, tree, treeId, stepId: address.id });
    useEffect(() => { if (stale) address.drop(); }, [stale]);
    const mark = (id, target) => setProgress((current) => advanceProgress(current, [id], target, Date.now()));
    window.restoreSteps = () => setSteps(trees[treeId]);
    if (tree === null) return null;
    const open = address.id !== null && tree.nodesById.has(address.id);
    return React.createElement(TreeDoor.Provider, { value: (id, door) => call('tree ' + id + ' ' + door) }, React.createElement('div', { style: { position: 'fixed', inset: 0 } },
      React.createElement('div', { className: 'st-view-layer--board is-active', inert: open ? '' : undefined, style: { position: 'absolute', inset: 0, zIndex: 18, visibility: open ? 'hidden' : undefined } },
        React.createElement(BoardView, { tree, completed: progress.completed, completedAt: progress.completedAt, selectedId,
          onSelect: (id) => { setSelectedId(id); address.open(id, 'card'); }, onAnchor: setSelectedId, breakpoint, active: true,
          onSwitchView: noop, query, onQuery: setQuery, quiet })),
      open && React.createElement(StepDetail, {
        tree, completed: progress.completed, completedAt: progress.completedAt, address, breakpoint, roadmapTitle: 'Learn to sail',
        editable, deletable: tree.roots().length !== 1 || tree.roots()[0].id !== address.id, stepLink: linkPrefix ? linkPrefix + address.id : null, refusal,
        workspace: spaces[address.id] ?? { subtasks: [], note: '', links: [] },
        workspaceActions: { onToggleSubtask: (nodeId, subtaskId) => setSpaces((current) => ({ ...current, [nodeId]: toggleSubtask(current[nodeId], subtaskId) })),
          onAddSubtask: noop, onEditSubtask: noop, onDeleteSubtask: noop, onSetNote: (nodeId) => call('note ' + nodeId), onAddLink: noop, onDeleteLink: noop },
        history: [],
        onEdit: editingEnabled ? (id) => setEditing(id) : undefined,
        onOpenStep: (id) => address.open(id, 'step'),
        onBack: address.back,
        onClose: () => { const origin = address.trail[0]; address.close(); setSelectedId(origin); },
        onComplete: (id) => { call('complete ' + id); mark(id, 'complete'); },
        onReset: (id) => { call('reset ' + id); mark(id, 'none'); },
        onRestore: (id, snapshot) => {
          if (window.restoreFails) throw new Error('private content');
          call('restore ' + id);
          setQuiet((current) => current + 1);
          mark(id, snapshot.completed.has(id) ? 'complete' : 'none');
        },
        onOpenInGraph: (id) => call('graph ' + id),
        onSelect: selectable ? (id) => call('select ' + id) : undefined,
        onViewBranch: (id) => { call('branch ' + id); address.close(); setQuery((current) => current.inBranch(id)); },
        onDelete: (id) => { call('delete ' + id); address.close(); setSteps((current) => without(current, id)); },
        onNotify: (message) => call('notify ' + message),
      }),
      open && editing === address.id && React.createElement(StepComposer, {
        tree, completed: progress.completed, legend: [], band: breakpoint, editing,
        onCreate: noop,
        onClose: () => setEditing(null),
        onEdit: (request) => {
          (window.editRequests ??= []).push(request);
          setQuiet((current) => current + 1);
          setSteps((current) => current.map((node) => node.id === request.id ? { ...node, ...request } : node));
          return { ok: true };
        },
      })));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;

let server, browser, webkitBrowser, origin;
let ready;
function start() {
  ready ??= (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-step-detail-test`,
    plugins: [{ name: 'step-detail-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/step-detail-entry.js') return '\0step-detail-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0step-detail-beacon';
        if (id.endsWith('/reportFailure.js')) return '\0step-detail-report';
      },
      load(id) {
        if (id === '\0step-detail-entry') return entry;
        if (id === '\0step-detail-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
        if (id === '\0step-detail-report') {
          return 'export function reportRoadmapFailure(operation) { (window.reports ??= []).push(operation); }\n'
            + 'export function reportUnexpectedFailure(operation) { (window.reports ??= []).push(operation); }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/step-detail-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Step detail test</title><div id="root"></div><script type="module" src="/step-detail-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: Number(process.env.WM_STEP_DETAIL_PORT ?? 0), fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  try { await ready; } finally { await browser?.close(); await webkitBrowser?.close(); await server?.close(); }
});

const learnToSailNodes = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', description: 'Identify the mast, boom, hull and rudder.' },
  { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta' },
  { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive' },
  { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', description: 'Learn to spot shifts in wind direction.',
    links: [{ url: 'https://example.com/sailing', label: 'Sailing basics' }] },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', description: 'Cast off safely and steer clear of the dock.' },
  { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive' },
  { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold' },
];

async function openRoom({ viewport, nodes = learnToSailNodes, editable = true, workspaces = {}, kinds = [], linked = true, others = {}, start = '#/app/sail', clock = false, permissions = [], editingEnabled = false, opens = {}, engine = 'Chromium' }, errors) {
  if (engine === 'WebKit') webkitBrowser ??= await webkit.launch({ headless: true });
  const context = await (engine === 'WebKit' ? webkitBrowser : browser).newContext({ viewport, permissions });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (clock) await page.clock.install();
  await page.goto(`${origin}/step-detail-test${start}`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((options) => openRoom(options), { nodes, completed: ['course', 'parts', 'rig'], editable, workspaces, kinds, linked, others, editingEnabled, opens });
  await page.locator('.st-board').waitFor({ state: 'attached' });
  return page;
}

const events = (page) => page.evaluate(() => window.events ?? []);
const calls = (page) => page.evaluate(() => window.calls ?? []);
const hash = (page) => page.evaluate(() => window.location.hash);
const focusedName = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element.getAttribute('aria-label') ?? element.querySelector('.st-board-card-title')?.textContent ?? element.textContent;
});
const status = (page) => page.evaluate(() => {
  const step = document.querySelector('.st-step-document');
  return ['.st-board-step-status-label', '.st-board-step-undo', '.st-board-step-outcome'].map((selector) => step.querySelector(selector)?.textContent).filter(Boolean);
});
const column = (page, name) => page.evaluate((name) => [...document.querySelectorAll(`[data-column="${name}"] .st-board-card-title`)].map((title) => title.textContent), name);
const waitForColumn = (page, name, titles) => page.waitForFunction(({ name, titles }) => {
  const shown = [...document.querySelectorAll(`[data-column="${name}"] .st-board-card-title`)].map((node) => node.textContent);
  return JSON.stringify(shown) === JSON.stringify(titles);
}, { name, titles });
const card = (page, label) => page.locator('.st-board-card:visible', { has: page.locator('.st-board-card-title', { hasText: new RegExp(`^${label}$`) }) });

// What the step detail shows of the tree a step opens, and every button where Complete and Reset would sit.
const treeParts = (page) => page.evaluate(() => {
  const layer = document.querySelector('.st-board-step-layer');
  const text = (selector) => layer.querySelector(selector)?.textContent ?? null;
  return {
    status: text('.st-board-step-status-label'),
    row: [text('.st-board-step-tree-title'), text('.st-board-step-tree-state')],
    rule: text('.st-board-step-tree-rule'),
    band: text('.st-board-step-tree-band'),
    actions: [...layer.querySelectorAll('.st-board-step-buttons button, .st-board-step-offer button')].map((button) => button.textContent),
  };
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test(`Chromium ${viewport.width}: a step that opens a tree offers no Complete, no Reset and no subtask offer: it says what completes it, and its row and Open tree go in`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({
      viewport,
      nodes: learnToSailNodes.map((node) => ({ wind: { ...node, opens: 't_wind' }, rig: { ...node, opens: 't_rig' }, bowline: { ...node, opens: 't_gone' }, dock: { ...node, opens: 'sail' } }[node.id] ?? node)),
      opens: {
        dock: { treeId: 'sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true },
        wind: { treeId: 't_wind', title: 'Wind drills', state: 'open', done: 3, total: 8, loop: false },
        rig: { treeId: 't_rig', title: 'Rig the boat', state: 'complete', done: 4, total: 4, loop: false },
        bowline: { treeId: 't_gone', missing: true },
      },
      workspaces: { wind: { subtasks: [{ id: 's1', label: 'Watch the flag', done: true }], note: '', links: [] } },
    }, errors);
    try {
      await card(page, 'Read the wind').locator('.st-board-card-title').click();
      await page.locator('.st-board-step-layer').waitFor();
      assert.deepEqual(await treeParts(page), {
        status: 'Up next', row: ['Wind drills', '3 of 8 done'], rule: 'Done when every step in Wind drills is done.',
        band: 'Completes with its tree', actions: ['Open tree'],
      });
      await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
      assert.deepEqual((await treeParts(page)).actions, ['Open tree']);

      await page.locator('.st-board-step-layer').getByRole('button', { name: 'Open Wind drills · 3 of 8 done', exact: true }).click();
      await page.locator('.st-board-step-buttons').getByRole('button', { name: 'Open tree', exact: true }).click();
      await page.keyboard.press('Escape');

      if (viewport.width < 744) await page.getByRole('tab', { name: /^Done/ }).click();
      await card(page, 'Rig the boat').locator('.st-board-card-title').click();
      assert.deepEqual(await treeParts(page), {
        status: 'Done', row: ['Rig the boat', '4 of 4 done'], rule: 'Done because every step in Rig the boat is done.',
        band: 'Completed by its tree', actions: ['Open tree'],
      });
      await page.keyboard.press('Escape');

      if (viewport.width < 744) await page.getByRole('tab', { name: /^Up next/ }).click();
      await card(page, 'Tie a bowline').locator('.st-board-card-title').click();
      assert.deepEqual(await treeParts(page), {
        status: 'Up next', row: ['Tree not found', 'Nothing at the other end'], rule: 'This tree can’t be found.',
        band: 'Can’t complete yet', actions: [],
      });
      assert.equal(await page.locator('button.st-board-step-tree').count(), 0);
      await page.keyboard.press('Escape');

      if (viewport.width < 744) await page.getByRole('tab', { name: /^Locked/ }).click();
      assert.equal(await card(page, 'Leave the dock').locator('.st-board-tree-pill--leads, .st-board-tree-pill-chevron').count(), 0);
      await card(page, 'Leave the dock').locator('.st-board-tree-pill').click();
      const own = await treeParts(page);
      assert.deepEqual({ row: own.row, rule: own.rule, band: own.band, actions: own.actions }, {
        row: ['Learn to sail', '3 of 8 done · opens Learn to sail back'], rule: 'A loop with Learn to sail: this never completes.',
        band: 'Won’t complete by itself', actions: [],
      });
      assert.equal(await page.locator('button.st-board-step-tree').count(), 0);
      assert.equal(await page.locator('.st-board-step-layer').getByRole('button', { name: /^Open tree$/ }).count(), 0);
      await page.keyboard.press('Escape');
      if (viewport.width < 744) await page.getByRole('tab', { name: /^Up next/ }).click();

      await card(page, 'Read the wind').locator('.st-board-tree-pill').click();
      assert.deepEqual(await calls(page), ['tree wind step', 'tree wind step', 'tree wind pill']);
      assert.equal(await hash(page), '#/app/sail');
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test(`Chromium ${viewport.width}: a step that owns a subtree says how far it is beside Open subtree, to its owner and to a reader, and has no Tree section`, async () => {
    await start();
    const owned = { rig: { id: 't_rig', done: 1, total: 2, state: 'open' }, wind: { id: 't_wind', done: 0, total: 0, state: 'open' } };
    const nodes = learnToSailNodes.map((node) => (owned[node.id] ? { ...node, opens: 't_old', subtree: owned[node.id] } : node));
    for (const editable of [true, false]) {
      const errors = [];
      const page = await openRoom({ viewport, nodes, editable, start: '#/app/sail?step=wind' }, errors);
      try {
        await page.locator('.st-board-step-layer').waitFor();
        assert.deepEqual({ ...await treeParts(page), heading: await page.locator('.st-board-step-layer .st-board-step-heading', { hasText: /^Tree/ }).count() }, {
          status: 'Up next', row: [null, null], rule: null, band: 'No steps yet',
          actions: ['Open subtree'],
          heading: 0,
        });
        await page.locator('.st-board-step-buttons').getByRole('button', { name: 'Open subtree', exact: true }).click();
        await page.keyboard.press('Escape');
        await card(page, 'Rig the boat').locator('.st-board-card-title').click();
        assert.deepEqual({ status: (await treeParts(page)).status, band: (await treeParts(page)).band }, { status: 'Up next', band: '1 of 2 done' });
        assert.deepEqual(await calls(page), ['tree wind step']);
        assert.deepEqual(errors, []);
      } finally {
        await page.context().close();
      }
    }
  });
}

test('Chromium: the real step menu places Select after Graph and before Delete and dispatches its step once', async () => {
  await start();
  for (const selectable of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/step-detail-test#/app/sail`);
        await page.waitForFunction(() => window.entryReady);
        await page.evaluate((options) => window.openRoom(options), {
          nodes: learnToSailNodes, completed: ['course', 'parts', 'rig'], selectable,
        });
        await card(page, 'Read the wind').click();
        await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
        assert.deepEqual(await page.getByRole('menuitem').allTextContents(), selectable
          ? [STEP_DETAIL.copyLink, STEP_DETAIL.openInGraph, STEP_DETAIL.select, STEP_DETAIL.deleteStep]
          : [STEP_DETAIL.copyLink, STEP_DETAIL.openInGraph, STEP_DETAIL.deleteStep]);
        if (!selectable) return;
        await page.getByRole('menuitem', { name: STEP_DETAIL.select, exact: true }).click();
        await page.getByRole('menu').waitFor({ state: 'detached' });
        assert.deepEqual(await calls(page), ['select wind']);
        assert.deepEqual(await events(page), [
          'roadmap_board_step_open {"surface":"document","column":"upNext","door":"card"}',
          'roadmap_board_step_action {"surface":"document","action":"select"}',
        ]);
      });
    } finally { await page.close(); }
  }
});

test('Chromium: the named document keeps Coach reachable and closes to its originating card', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').focus();
    await page.keyboard.press('Enter');
    const document = page.getByRole('article', { name: 'Read the wind' });
    await document.waitFor();
    assert.deepEqual(await document.evaluate((element) => [element === window.document.activeElement, element.getAttribute('aria-modal')]), [true, null]);
    assert.equal(await document.getByRole('tablist').count(), 0);
    const coach = page.getByRole('button', { name: 'Collapse Coach' });
    await coach.focus();
    await page.keyboard.press('Escape');
    assert.equal(await document.count(), 1);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Expand Coach' }).waitFor();
    await document.focus();
    await page.keyboard.press('Escape');
    await document.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.dataset.stepId === 'wind');
    assert.deepEqual([await focusedName(page), await hash(page)], ['Read the wind', '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

for (const width of [744, 1024, 1440]) {
  test(`Chromium ${width}: Coach consumes its approved width and document columns follow product width`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ viewport: { width, height: 960 } }, errors);
    try {
      await card(page, 'Read the wind').click();
      const article = page.locator('article');
      const measure = () => page.evaluate(() => {
        const product = document.querySelector('article').getBoundingClientRect();
        const description = document.querySelector('.st-step-description-section').getBoundingClientRect();
        const relations = document.querySelector('.st-step-relationships').getBoundingClientRect();
        return { width: product.width, split: relations.left > description.left };
      });
      if (width === 1440) await page.getByRole('button', { name: 'Collapse Coach' }).click();
      assert.deepEqual(await measure(), { width: width - 56, split: width - 56 >= 1000 });
      await article.evaluate((element) => { window.sameArticle = element; });
      await page.getByRole('button', { name: 'Expand Coach' }).click();
      const coachWidth = width === 744 ? 280 : width === 1024 ? 340 : 400;
      assert.deepEqual(await measure(), { width: width - coachWidth, split: width - coachWidth >= 1000 });
      assert.equal(await article.evaluate((element) => element === window.sameArticle), true);
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
}

test('Chromium: an inline Undo that throws reports its static operation and its offer leaves, with no event claiming it worked', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await waitForColumn(page, 'upNext', ['Leave the dock', 'Tie a bowline']);
    await page.evaluate(() => { window.restoreFails = true; window.events = []; });
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => [window.reports, window.events]), [['roadmap-step-restore'], []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Complete and Reset retain the document, update its status and pin Undo with the outcome without a toast', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await waitForColumn(page, 'upNext', ['Leave the dock', 'Tie a bowline']);
    assert.deepEqual([await status(page), await column(page, 'upNext')],
      [['Done', 'Undo', 'Leave the dock is up next'], ['Leave the dock', 'Tie a bowline']]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await waitForColumn(page, 'upNext', ['Read the wind', 'Tie a bowline']);
    assert.deepEqual([await status(page), await column(page, 'upNext')], [['Up next'], ['Read the wind', 'Tie a bowline']]);

    await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
    await page.getByRole('article', { name: 'Name the boat parts' }).waitFor();
    await page.getByRole('button', { name: 'Reset' }).hover();
    assert.equal(await page.locator('.st-board-step-preview').textContent(), 'Reset returns 2 steps to Locked');
    await page.getByRole('button', { name: 'Reset' }).click();
    await waitForColumn(page, 'locked', ['Read the wind', 'Tie a bowline', 'Leave the dock', 'Sail a triangle', 'Sail solo']);
    assert.deepEqual([await status(page), await column(page, 'locked')],
      [['Up next', 'Undo', '2 steps locked again'], ['Read the wind', 'Tie a bowline', 'Leave the dock', 'Sail a triangle', 'Sail solo']]);

    assert.deepEqual([await calls(page), await events(page)], [['complete wind', 'restore wind', 'reset parts'], [
      'roadmap_board_step_open {"surface":"document","column":"upNext","door":"card"}',
      'roadmap_board_step_action {"surface":"document","action":"complete"}',
      'roadmap_board_step_action {"surface":"document","action":"undo"}',
      'roadmap_board_step_open {"surface":"document","column":"done","door":"step"}',
      'roadmap_board_step_action {"surface":"document","action":"reset"}',
    ]]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo lasts the hold window, then goes; the outcome line and Reset remain', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, clock: true }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.clock.runFor(5900);
    assert.deepEqual(await status(page), ['Done', 'Undo', 'Leave the dock is up next']);
    await page.clock.runFor(200);
    assert.deepEqual([await status(page), await page.getByRole('button', { name: 'Reset' }).count()], [['Done', 'Leave the dock is up next'], 1]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: a locked step leads with what it still needs; on both surfaces each unmet need names its column and opens it', async () => {
  await start();
  const errors = [];
  const desktop = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  const phone = await openRoom({ viewport: { width: 390, height: 844 } }, errors);
  try {
    await card(desktop, 'Leave the dock').click();
    assert.equal(await desktop.locator('.st-board-step-description').textContent(), 'Cast off safely and steer clear of the dock.');
    assert.deepEqual(await status(desktop), ['Locked · 1 to go']);
    assert.deepEqual(await desktop.locator('.st-board-step-row--need').allInnerTexts(), ['Read the wind\nUp next']);

    await phone.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await card(phone, 'Leave the dock').click();
    assert.deepEqual(await phone.locator('.st-board-step-row--need').allInnerTexts(), ['Read the wind\nUp next']);
    await phone.getByRole('button', { name: 'Read the wind, up next' }).click();
    await phone.getByRole('article', { name: 'Read the wind' }).waitFor();
    assert.equal(await phone.locator('.st-step-breadcrumb').getAttribute('aria-label'), 'Back to Leave the dock');
    await phone.locator('.st-step-breadcrumb').click();
    await phone.getByRole('article', { name: 'Leave the dock' }).waitFor();
    assert.equal(await phone.locator('.st-step-breadcrumb').getAttribute('aria-label'), 'Back to Learn to sail');
    assert.deepEqual(await events(phone), [
      'roadmap_board_column {"column":"locked"}',
      'roadmap_board_step_open {"surface":"document","column":"locked","door":"card"}',
      'roadmap_board_step_open {"surface":"document","column":"upNext","door":"step"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await desktop.context().close();
    await phone.context().close();
  }
});

test('Chromium: on the phone a step is a pushed page, and Back returns to the same pane, scroll and card', async () => {
  await start();
  const errors = [];
  const knots = Array.from({ length: 14 }, (_, index) => ({ id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: ['solo'], color: 'plum' }));
  const page = await openRoom({ viewport: { width: 390, height: 844 }, nodes: [...learnToSailNodes, ...knots] }, errors);
  try {
    await page.getByRole('tab', { name: 'Locked, 17 steps' }).click();
    const pane = page.locator('.st-board-phone-pane.is-shown');
    await pane.evaluate((element) => { element.scrollTop = 600; });
    const scrolled = await pane.evaluate((element) => element.scrollTop);
    await card(page, 'Knot 9').click();
    const dialog = page.getByRole('article', { name: 'Knot 9' });
    await dialog.waitFor();
    assert.deepEqual([await page.locator('.st-step-breadcrumb span:first-of-type').textContent(), await page.locator('.st-view-layer--board').evaluate((layer) => layer.inert)],
      ['Learn to sail', true]);

    await page.locator('.st-step-breadcrumb').click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([
      await page.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label'),
      await pane.evaluate((element) => element.scrollTop),
      await focusedName(page),
      await hash(page),
    ], ['Locked, 17 steps', scrolled, 'Knot 9', '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: checking the last subtask offers Complete step; the subtasks alone complete nothing', async () => {
  await start();
  const errors = [];
  const workspaces = { wind: { subtasks: [{ id: 's1', label: 'Watch the telltales', done: true }, { id: 's2', label: 'Try a small turn', done: false }], note: '', links: [] } };
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, workspaces }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
    assert.equal(await page.locator('.st-board-step-offer').count(), 0);
    await page.getByText('Try a small turn').click();
    await page.locator('.st-board-step-offer').waitFor();
    assert.deepEqual([await page.locator('.st-board-step-offer').innerText(), await calls(page)], ['All subtasks done\nComplete step', []]);
    await page.getByRole('button', { name: 'Complete step' }).click();
    await waitForColumn(page, 'done', ['Read the wind', 'Rig the boat', 'Name the boat parts', 'Choose a sailing course']);
    assert.deepEqual([await calls(page), await column(page, 'done'), (await events(page)).at(-1)],
      [['complete wind'], ['Read the wind', 'Rig the boat', 'Name the boat parts', 'Choose a sailing course'],
        'roadmap_board_step_action {"surface":"document","action":"completeFromSubtasks"}']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: the step menu copies the step’s link with Link copied and opens the step in the Graph; a reader’s has no Delete', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] }, errors);
  const reader = await openRoom({ viewport: { width: 390, height: 844 }, editable: false }, errors);
  const items = (where) => where.getByRole('menuitem').allTextContents();
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    assert.deepEqual([await items(page), await focusedName(page)], [['Copy link', 'Open in Graph', 'Delete step'], 'Copy link']);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window.calls ?? []).length > 0);
    assert.deepEqual([await calls(page), await page.evaluate(() => navigator.clipboard.readText()), await focusedName(page)],
      [['notify Link copied'], 'https://windmill.test/t/sail#?step=wind', 'More']);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Open in Graph' }).click();
    assert.deepEqual([await calls(page), (await events(page)).slice(1)], [['notify Link copied', 'graph wind'], [
      'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}',
      'roadmap_board_step_action {"surface":"document","action":"openInGraph"}',
    ]]);

    await card(reader, 'Read the wind').click();
    await reader.getByRole('button', { name: 'More' }).click();
    assert.deepEqual([await items(reader), await reader.getByRole('article').getByRole('tablist').count(), await reader.locator('.st-step-pinned-actions button').count()],
      [['Copy link', 'Open in Graph'], 0, 0]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
    await reader.context().close();
  }
});

test('Chromium: View branch closes the step and scopes the Board to it; a locked step offers no View branch', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Leave the dock').click();
    assert.equal(await page.getByRole('button', { name: 'View branch' }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('article').waitFor({ state: 'detached' });
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'View branch' }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    assert.deepEqual([await calls(page), await column(page, 'locked'), await column(page, 'upNext'), await hash(page), (await events(page)).at(-1)], [
      ['branch wind'], ['Leave the dock', 'Sail a triangle', 'Sail solo'], ['Read the wind'], '#/app/sail',
      'roadmap_board_step_action {"surface":"document","action":"viewBranch"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

const activeIs = (page) => page.evaluate(() => {
  const element = document.activeElement;
  if (element === document.body) return 'body';
  if (element.matches('.st-board-step-status')) return `status: ${element.querySelector('.st-board-step-status-label').textContent}`;
  if (element.matches('article')) return 'article';
  return element.getAttribute('aria-label') ?? element.textContent;
});

test('Chromium: crossing 744px retains one document on one live layer: focus, Back and Escape still work', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.st-step-document').waitFor();
    assert.deepEqual([await activeIs(page), await page.locator('.st-board-step-layer').count(), await page.locator('.st-board-step-layer').evaluate((layer) => layer.inert)],
      ['article', 1, false]);
    await page.locator('.st-step-breadcrumb').click();
    await page.getByRole('article').waitFor({ state: 'detached' });

    await card(page, 'Read the wind').click();
    await page.locator('.st-step-document').waitFor();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('.st-step-document').waitFor();
    assert.equal(await activeIs(page), 'article');
    await page.keyboard.press('Escape');
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await hash(page)], ['Read the wind', '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: focus never falls to the page — Complete, Undo, Reset and the subtask offer land on the status row, Escape still closes', async () => {
  await start();
  const errors = [];
  const workspaces = { wind: { subtasks: [{ id: 's1', label: 'Try a small turn', done: false }], note: '', links: [] } };
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, workspaces }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await activeIs(page), 'status: Done');
    await page.getByRole('button', { name: 'Undo' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await activeIs(page), 'status: Up next');

    await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
    await page.getByText('Try a small turn').click();
    await page.getByRole('button', { name: 'Complete step' }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual([await activeIs(page), await status(page)],
      ['status: Done', ['Done', 'Undo', 'Leave the dock is up next']]);
    await page.getByRole('button', { name: 'Reset' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await activeIs(page), 'status: Up next');

    await page.keyboard.press('Escape');
    await page.getByRole('article').waitFor({ state: 'detached' });
    assert.deepEqual(await calls(page), ['complete wind', 'restore wind', 'complete wind', 'reset wind']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo expiry recovers to status, subtask Cancel returns to its opener, and Escape still closes', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, clock: true }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.getByRole('button', { name: 'Undo' }).focus();
    await page.clock.runFor(6100);
    assert.equal(await activeIs(page), 'status: Done');

    await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
    await page.getByRole('button', { name: 'Add subtask', exact: true }).click();
    await page.getByRole('textbox', { name: 'Add subtask', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.matches('.st-board-workspace-add-task'));
    assert.equal(await activeIs(page), 'Add subtask');
    await page.keyboard.press('Escape');
    await page.getByRole('article').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo after Reset gives the step back its mark, quietly; it completes at the Undo’s time, so it heads Done', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    assert.deepEqual(await column(page, 'done'), ['Rig the boat', 'Name the boat parts', 'Choose a sailing course']);
    await card(page, 'Name the boat parts').click();
    await page.getByRole('button', { name: 'Reset' }).click();
    await waitForColumn(page, 'done', ['Rig the boat', 'Choose a sailing course']);
    await page.getByRole('button', { name: 'Undo' }).click();
    await waitForColumn(page, 'done', ['Name the boat parts', 'Rig the boat', 'Choose a sailing course']);
    assert.deepEqual([await column(page, 'done'), await status(page), await calls(page)],
      [['Name the boat parts', 'Rig the boat', 'Choose a sailing course'], ['Done'], ['reset parts', 'restore parts']]);
    assert.equal(await page.locator('.st-board-card.is-arrived').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Delete from ⋯ hands focus to the columns’ tab stop, drops the step from the URL, and restoring the step reopens nothing', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Delete step' }).click();
    assert.equal(await page.getByRole('alertdialog').textContent(), 'Delete Read the wind?Removes this step · 1 branch resplicesCancelDelete');
    assert.equal(await page.getByRole('article').count(), 1);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('[data-column="locked"]'));
    assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.column, document.activeElement.tabIndex, Boolean(document.activeElement.closest('[inert]')), location.hash]), ['locked', -1, false, '#/app/sail']);
    await page.locator('.st-board-card[tabindex="0"]').filter({ hasText: 'Leave the dock' }).waitFor();
    await page.keyboard.press('Tab');
    assert.deepEqual([await focusedName(page), await page.evaluate(() => document.activeElement.tabIndex)], ['Leave the dock', 0]);
    await page.evaluate(() => restoreSteps());
    await card(page, 'Read the wind').waitFor();
    assert.deepEqual([await page.getByRole('article').count(), (await events(page)).filter((line) => line.startsWith('roadmap_board_step_open')).length], [0, 1]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: a stale step link leaves the URL without opening anything', async () => {
  await start();
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/step-detail-test#/app/sail?step=gone`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((nodes) => openRoom({ nodes, completed: ['course', 'parts', 'rig'] }), learnToSailNodes);
    await page.locator('.st-board').waitFor({ state: 'attached' });
    await page.waitForFunction(() => window.location.hash === '#/app/sail');
    assert.deepEqual([await page.getByRole('article').count(), await events(page)], [0, []]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Chromium: View branch from a step the visit reached by rows hands focus to the scoped Board’s stop when the first card left the branch', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Tie a bowline').click();
    await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
    await page.getByRole('button', { name: 'Read the wind, up next' }).click();
    await page.getByRole('button', { name: 'View branch' }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await card(page, 'Tie a bowline').count(), await hash(page)], ['Read the wind', 0, '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: with no link to share, the step menu offers no Copy link', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, linked: false }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in Graph', 'Delete step']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

const sea = { sea: [{ id: 'tide', label: 'Read the tide', prerequisites: [], color: 'sky' }] };

test('Chromium: arriving at a step link from another roadmap opens the step once its own roadmap loads, and keeps it in the URL', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, others: sea, start: '#/app/sea' }, errors);
  try {
    await page.evaluate(() => { window.location.hash = '#/app/sail?step=wind'; });
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    assert.deepEqual([await hash(page), await events(page)], ['#/app/sail?step=wind', ['roadmap_board_step_open {"surface":"document","column":"upNext","door":"link"}']]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Back from another roadmap into a step link keeps the step and opens it again', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, others: sea, start: '#/app/sail?step=wind' }, errors);
  try {
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    await page.evaluate(() => { window.location.hash = '#/app/sea'; });
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.evaluate(() => window.history.back());
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    assert.equal(await hash(page), '#/app/sail?step=wind');
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: delete confirmation cancels without writing on phone and desktop', async () => {
  await start();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 960 }]) {
    const errors = [];
    const page = await openRoom({ viewport }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Delete step' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      assert.equal(await page.getByRole('article').count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More');
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  }
});

test('Chromium: the sole root keeps Delete unavailable; one of several roots can be deleted', async () => {
  await start();
  for (const extraRoot of [false, true]) {
    const errors = [];
    const nodes = extraRoot
      ? [...learnToSailNodes, { id: 'another', label: 'Another beginning', prerequisites: [], color: 'sky' }]
      : learnToSailNodes;
    const page = await openRoom({ viewport: { width: 1440, height: 960 }, nodes }, errors);
    try {
      await card(page, 'Choose a sailing course').click();
      await page.getByRole('button', { name: 'More' }).click();
      assert.equal(await page.getByRole('menuitem', { name: 'Delete step' }).count(), extraRoot ? 1 : 0);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  }
});

for (const moveFocus of [false, true]) {
  test(`Chromium: deleting the phone pane's last card focuses its segment during regroup${moveFocus ? ' without stealing a later focus move' : ' then retains its column'}`, async () => {
    await start();
    const errors = [];
    const nodes = learnToSailNodes.filter((step) => !['bowline', 'solo'].includes(step.id));
    const page = await openRoom({ viewport: { width: 390, height: 844 }, nodes }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Delete step' }).click();
      const time = new Date('2026-11-02T12:00:00Z');
      await page.clock.install({ time: new Date(time.getTime() - 60000) });
      await page.clock.pauseAt(time);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).evaluate((button) => button.click());
      await page.getByRole('article').waitFor({ state: 'detached' });
      await page.clock.runFor(32);
      assert.deepEqual(await page.evaluate(() => [
        document.activeElement.matches('.st-board-phone-segment'),
        document.activeElement.getAttribute('aria-selected'),
      ]), [true, 'true']);
      if (moveFocus) await page.getByRole('searchbox', { name: 'Find a step' }).focus();
      await page.clock.runFor(800);
      if (moveFocus) {
        assert.equal(await page.evaluate(() => document.activeElement.matches('.st-board-find-input')), true);
      } else {
        assert.equal(await page.evaluate(() => document.activeElement.matches('.st-board-phone-segment')), true);
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}


for (const width of [390, 744, 1440]) {
  for (const [id, title, primary] of [['wind', 'Read the wind', 'Complete'], ['parts', 'Name the boat parts', 'Reset'], ['dock', 'Leave the dock', null]]) {
    test(`Chromium ${width}: ${id} keeps its actions while scrolling through document sections`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ viewport: { width, height: 960 }, start: `#/app/sail?step=${id}`, editingEnabled: true }, errors);
      try {
        await page.getByRole('article', { name: title, exact: true }).waitFor();
        for (const section of ['Workspace', 'History']) {
          await page.locator('.st-step-section-links').getByRole('button', { name: new RegExp(section, 'i') }).click();
          assert.deepEqual(await page.locator('.st-step-pinned-actions').getByRole('button').allTextContents(), primary ? [primary] : []);
          assert.equal(await page.getByRole('button', { name: 'Edit step', exact: true }).count(), 1);
          assert.equal(await page.locator('.st-step-workspace-section').count(), 1);
          assert.equal(await page.locator('.st-step-history-section').count(), 1);
        }
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }

  test(`Chromium ${width}: empty workspace add buttons center their icons with a six-pixel text gap`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ viewport: { width, height: 960 }, start: '#/app/sail?step=wind' }, errors);
    try {
      await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
      await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
      const buttons = page.locator('.st-board-workspace-missing .st-board-step-action');
      await buttons.first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(await buttons.evaluateAll((buttons) => buttons.map((button) => {
        const style = getComputedStyle(button);
        const icon = button.querySelector('svg').getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        const text = document.createRange();
        text.selectNode([...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
        return {
          label: button.textContent,
          display: style.display,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          gap: style.gap,
          textGap: Math.round(text.getBoundingClientRect().left - icon.right),
          iconCentered: Math.abs(icon.top + icon.height / 2 - bounds.top - bounds.height / 2) < 1,
        };
      })), ['Add subtask', 'Add note', 'Add link'].map((label) => ({
        label, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', textGap: 6, iconCentered: true,
      })));
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });

  test(`Chromium ${width}: Edit Save returns to its opener and Escape never closes the covered step`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ viewport: { width, height: 960 }, editingEnabled: true }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'Edit step', exact: true }).click();
      await page.getByRole('dialog', { name: 'Edit step', exact: true }).waitFor();
      assert.equal(await page.locator('.st-board-step-layer').evaluate((layer) => !!layer.closest('[inert]')), true);
      await page.getByLabel('Name', { exact: true }).fill('Watch the wind');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discard draft?', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discard draft?', exact: true }).waitFor({ state: 'detached' });
      assert.equal(await hash(page), '#/app/sail?step=wind');
      assert.equal(await page.locator('.st-board-step-layer').count(), 1);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('article', { name: 'Watch the wind', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Edit step');
      assert.equal(await activeIs(page), 'Edit step');
      assert.deepEqual(await page.evaluate(() => window.editRequests), [{
        id: 'wind', label: 'Watch the wind', description: 'Learn to spot shifts in wind direction.', color: 'sky', prerequisites: ['parts'],
      }]);
      assert.equal(await page.locator('.st-board-card.is-arrived').count(), 0);
      assert.deepEqual(await calls(page), []);
      await page.getByRole('button', { name: 'Edit step', exact: true }).click();
      await page.getByRole('dialog', { name: 'Edit step', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('article', { name: 'Watch the wind', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Edit step');
      assert.equal(await hash(page), '#/app/sail?step=wind');
      await page.keyboard.press('Escape');
      await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });

  test(`Chromium ${width}: note discard traps focus and returns to the note opener`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ viewport: { width, height: 960 }, editingEnabled: true,
      workspaces: { wind: { subtasks: [], note: 'Watch the water', links: [] } } }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
      const opener = 'Edit';
      await page.getByRole('button', { name: opener, exact: true }).click();
      await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Watch the sails');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      const discard = page.getByRole('dialog', { name: 'Discard draft?', exact: true });
      await discard.waitFor();
      await discard.getByRole('button', { name: 'Discard', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await focusedName(page), 'Keep editing');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focusedName(page), 'Discard');
      await page.keyboard.press('Escape');
      await discard.waitFor({ state: 'detached' });
      assert.equal(await hash(page), '#/app/sail?step=wind');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.locator('.st-board-note-editor').waitFor({ state: 'detached' });
      await page.waitForFunction((label) => document.activeElement.textContent === label, opener);
      assert.equal(await activeIs(page), opener);
      assert.equal(await page.locator('.st-step-workspace-section').count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });

  test(`Chromium ${width}: readers have no edit action or personal workspace`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ viewport: { width, height: 960 }, editable: false, editingEnabled: true }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
      assert.deepEqual(await page.locator('.st-step-pinned-actions button, .st-board-workspace').allTextContents(), []);
      assert.equal(await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Edit step', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}


test('Chromium: system Back closes the phone detail without saving its local note draft', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 390, height: 844 }, editingEnabled: true,
    workspaces: { wind: { subtasks: [], note: 'Keep this note', links: [] } } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Unsaved draft');
    await page.goBack();
    await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
    assert.deepEqual(await calls(page), []);
    await card(page, 'Read the wind').click();
    await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
    assert.equal(await page.locator('.st-board-workspace-note').textContent(), 'Keep this note');
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: copy recovery shows a clipboard refusal and focuses Try again after the phone menu closes`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 } }, errors);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = () => { throw new DOMException('private clipboard detail', 'NotAllowedError'); }; });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.waitForFunction(() => window.events.some((line) => line.includes('"outcome":"failed"')));
      await page.locator('.st-step-copy-recovery').waitFor({ timeout: 3000 });
      assert.equal(await page.getByRole('heading', { name: 'Couldn’t copy link', exact: true }).count(), 1);
      await page.waitForFunction(() => document.activeElement.textContent === 'Try again');
      assert.deepEqual([await page.getByRole('menu').count(), await calls(page), await page.evaluate(() => window.reports ?? []), await events(page)], [0, [], [], [
        'roadmap_board_step_open {"surface":"document","column":"upNext","door":"card"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
      ]]);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  test(`${engine}: copy recovery retries, reveals the full address, selects it and reports success once`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 744, height: 960 } }, errors);
    try {
      await page.evaluate(() => {
        window.copyRequests = [];
        navigator.clipboard.writeText = async (link) => {
          window.copyRequests.push(link);
          if (window.copyRequests.length === 1) throw new DOMException('private clipboard detail', 'NotAllowedError');
          if (window.copyRequests.length === 2) throw new Error('private clipboard detail');
        };
        window.setLinkPrefix('https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=');
      });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
      await recovery.waitFor();
      assert.equal(await recovery.textContent(), 'Couldn’t copy linkTry again or select the link manually.Try againShow link');
      assert.equal(await recovery.getByRole('textbox').count(), 0);
      await page.waitForFunction(() => document.activeElement.textContent === 'Try again');
      await page.evaluate(() => {
        window.copyAnnouncements = [];
        const status = [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent === 'Couldn’t copy link');
        new MutationObserver(() => window.copyAnnouncements.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
      });
      await recovery.getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => (window.reports ?? []).length === 1);
      assert.equal(await recovery.textContent(), 'Couldn’t copy linkTry again or select the link manually.Try againShow link');
      await recovery.getByRole('button', { name: 'Show link' }).click();
      const field = recovery.getByRole('textbox', { name: 'Step link', exact: true });
      await page.waitForFunction(() => document.activeElement.matches('input[readonly]'));
      assert.deepEqual(await field.evaluate((input) => [input.value, input.readOnly]), ['https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=wind', true]);
      await recovery.getByRole('button', { name: 'Select link' }).click();
      assert.deepEqual(await field.evaluate((input) => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 0, 94]);
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Try again');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Select link');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Complete');
      assert.deepEqual(await page.evaluate(() => window.copyAnnouncements), []);
      await recovery.getByRole('button', { name: 'Try again' }).focus();
      await page.keyboard.press('Enter');
      await recovery.waitFor({ state: 'detached' });
      assert.equal(await focusedName(page), 'More');
      assert.deepEqual(await page.evaluate(() => [window.copyRequests, window.reports, window.calls]), [
        Array(3).fill('https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=wind'),
        ['roadmap-step-copy'], ['notify Link copied'],
      ]);
      assert.deepEqual((await events(page)).slice(1), [
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"reveal"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"select"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}',
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  for (const dismiss of ['Escape', 'Close']) {
    test(`${engine}: copy recovery ${dismiss} restores More, cancels late retry feedback and prevents simultaneous clipboard writes`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ engine, viewport: { width: 390, height: 844 } }, errors);
      try {
        await page.evaluate(() => {
          window.copyRequests = [];
          navigator.clipboard.writeText = (link) => new Promise((resolve, reject) => {
            window.copyRequests.push(link);
            window.finishCopy = resolve;
            window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError'));
          });
        });
        await card(page, 'Read the wind').click();
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('menuitem', { name: 'Copy link' }).click();
        }
        assert.deepEqual(await page.evaluate(() => window.copyRequests), ['https://windmill.test/t/sail#?step=wind']);
        await page.evaluate(() => window.refuseCopy());
        const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
        await recovery.waitFor();
        await page.waitForFunction(() => document.activeElement.textContent === 'Try again');
        await recovery.getByRole('button', { name: 'Try again' }).click();
        await page.keyboard.press('Enter');
        assert.equal(await recovery.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await page.evaluate(() => window.copyRequests), Array(2).fill('https://windmill.test/t/sail#?step=wind'));
        if (dismiss === 'Escape') await page.keyboard.press('Escape');
        else await recovery.getByRole('button', { name: 'Close', exact: true }).click();
        await recovery.waitFor({ state: 'detached' });
        assert.equal(await focusedName(page), 'More');
        await page.evaluate(() => window.refuseCopy());
        await page.waitForFunction(() => window.events.filter((line) => line.includes('"outcome":"failed"')).length === 2);
        assert.deepEqual([await recovery.count(), await calls(page), await focusedName(page), await hash(page)], [0, [], 'More', '#/app/sail?step=wind']);
        assert.deepEqual((await events(page)).slice(1), [
          'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"dismiss"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        ]);
        await page.keyboard.press('Escape');
        await page.getByRole('article').waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }

  for (const change of ['step', 'link', 'eligibility', 'close']) {
    test(`${engine}: copy recovery ignores delayed results after ${change} changes, including a return to the same step address`, async () => {
      await start();
      for (const result of ['ok', 'failed']) {
        const errors = [];
        const page = await openRoom({ engine, viewport: { width: 1440, height: 960 } }, errors);
        try {
          await page.evaluate(() => {
            navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
              window.finishCopy = (result) => result === 'ok' ? resolve() : reject(new DOMException('private detail', 'NotAllowedError'));
            });
          });
          await card(page, 'Read the wind').click();
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('menuitem', { name: 'Copy link' }).click();
          if (change === 'step') {
            await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
            await page.getByRole('article', { name: 'Name the boat parts', exact: true }).waitFor();
            await page.getByRole('button', { name: 'Read the wind, up next' }).click();
          } else if (change === 'close') {
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await page.getByRole('article').waitFor({ state: 'detached' });
            await card(page, 'Read the wind').click();
          } else {
            await page.evaluate((change) => window.setLinkPrefix(change === 'link' ? 'https://windmill.test/t/other#?step=' : null), change);
            await page.getByRole('button', { name: 'More' }).click();
            assert.equal(await page.getByRole('menuitem', { name: 'Copy link' }).count(), change === 'link' ? 1 : 0);
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.setLinkPrefix('https://windmill.test/t/sail#?step='));
          }
          await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
          await page.getByRole('button', { name: 'Collapse Coach' }).focus();
          await page.evaluate((result) => window.finishCopy(result), result);
          await page.waitForFunction((result) => window.events.some((line) => line === `roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"${result}"}`), result);
          assert.deepEqual([await calls(page), await page.locator('.st-step-copy-recovery').count(), await focusedName(page)], [[], 0, 'Collapse Coach']);
          assert.deepEqual((await events(page)).filter((line) => line.includes('copyLink')), [`roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"${result}"}`]);
          assert.deepEqual(errors, []);
        } finally { await page.context().close(); }
      }
    });
  }

  test(`${engine}: copy recovery keeps a nested editor, sync refusal, Coach and completion Undo intact`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 744, height: 960 }, editingEnabled: true }, errors);
    try {
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError')); });
      });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      await page.evaluate(() => window.refuseSync());
      await page.getByRole('alert').waitFor();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.getByRole('button', { name: 'Edit step', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Edit step', exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
      await page.evaluate(() => window.refuseCopy());
      await page.waitForFunction(() => document.querySelector('.st-step-copy-recovery'));
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).evaluate((input) => input === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Edit step', exact: true }).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Edit step', null, { timeout: 4000 });
      assert.equal(await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Expand Coach' }).click();
      await page.getByRole('button', { name: 'Collapse Coach' }).click();
      await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual(await calls(page), ['complete wind', 'restore wind']);
      assert.equal(await page.locator('.st-board-step-status-label').textContent(), 'Up next');
      await page.getByRole('button', { name: 'Expand Coach' }).focus();
      await page.keyboard.press('Escape');
      await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).waitFor({ state: 'detached' });
      assert.equal(await focusedName(page), 'More');
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
}

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: copy recovery uses the native clipboard success path without a recovery card`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 }, permissions: engine === 'Chromium' ? ['clipboard-read', 'clipboard-write'] : [] }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.waitForFunction(() => window.events.some((line) => line.includes('"action":"copyLink"')));
      assert.deepEqual([await calls(page), (await events(page)).slice(1), await page.locator('.st-step-copy-recovery').count()], [['notify Link copied'], [
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}',
      ], 0]);
      if (engine === 'Chromium') assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://windmill.test/t/sail#?step=wind');
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  test(`${engine}: copy recovery removes a revealed address when its link changes or eligibility is revoked`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 }, editable: false }, errors);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('private detail', 'SecurityError'); }; });
      await card(page, 'Read the wind').click();
      for (const next of ['https://windmill.test/t/another#?step=', null]) {
        await page.getByRole('button', { name: 'More' }).click();
        assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Copy link', 'Open in Graph']);
        await page.getByRole('menuitem', { name: 'Copy link' }).click();
        await page.getByRole('button', { name: 'Show link' }).click();
        await page.getByRole('textbox', { name: 'Step link', exact: true }).waitFor();
        await page.evaluate((next) => window.setLinkPrefix(next), next);
        await page.locator('.st-step-copy-recovery').waitFor({ state: 'detached' });
        assert.deepEqual([await page.getByRole('textbox').count(), await page.evaluate(() => window.reports ?? [])], [0, []]);
      }
      await page.getByRole('button', { name: 'More' }).click();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in Graph']);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  for (const options of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 744, height: 960 }, { width: 744, height: 960, expanded: true }, { width: 1440, height: 960 }]) {
    for (const theme of ['light', 'dark']) {
      test(`${engine}: copy recovery fits ${theme} ${options.width}px ${options.expanded ? 'expanded' : 'default'} Coach without covering pinned Undo`, async () => {
        await start();
        const errors = [];
        const page = await openRoom({ engine, viewport: { width: options.width, height: options.height } }, errors);
        try {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            navigator.clipboard.writeText = async () => { throw new DOMException('private detail', 'NotAllowedError'); };
          }, theme);
          await card(page, 'Read the wind').click();
          if (options.expanded) await page.getByRole('button', { name: 'Expand Coach' }).click();
          await page.getByRole('button', { name: 'Complete', exact: true }).click();
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('menuitem', { name: 'Copy link' }).click();
          const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
          await recovery.waitFor();
          await page.evaluate(() => document.fonts.ready);
          const geometry = () => recovery.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const article = node.closest('article');
            const documentBox = article.getBoundingClientRect();
            const actions = article.querySelector('.st-step-pinned-actions').getBoundingClientRect();
            return {
              height: Math.round(box.height),
              inside: box.left >= documentBox.left && box.right <= documentBox.right && box.top >= 0,
              footerGap: Math.round(actions.top - box.bottom),
              modal: !!node.closest('[aria-modal="true"]'),
              controls: [...node.querySelectorAll('button, input')].map((control) => {
                const bounds = control.getBoundingClientRect();
                return bounds.width >= 44 && bounds.height >= 44 && control.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
              }),
            };
          });
          assert.deepEqual(await geometry(), { height: 161, inside: true, footerGap: 12, modal: false, controls: [true, true, true] });
          if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${theme}-${options.width}-${options.expanded ? 'expanded' : 'default'}-failure.png` });
          await recovery.getByRole('button', { name: 'Show link' }).click();
          assert.deepEqual(await geometry(), { height: 244, inside: true, footerGap: 12, modal: false, controls: [true, true, true, true] });
          assert.deepEqual(await recovery.getByRole('textbox').evaluate((input) => [getComputedStyle(input).outlineWidth, getComputedStyle(input).outlineStyle]), ['2px', 'solid']);
          if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${theme}-${options.width}-${options.expanded ? 'expanded' : 'default'}-reveal.png` });
          if (process.env.WM_COPY_SCREENSHOTS && theme === 'dark' && options.width === 390) {
            await recovery.getByRole('button', { name: 'Select link' }).click();
            await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-dark-390-selected.png` });
          }
          assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).evaluate((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }), true);
          assert.deepEqual(errors, []);
        } finally { await page.context().close(); }
      });
    }
  }
}

test('Chromium: copy recovery handles a real browser clipboard permission denial without a Sentry issue', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 390, height: 844 } }, errors);
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'denied', origin });
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).waitFor();
    assert.deepEqual([await calls(page), await page.evaluate(() => window.reports ?? []), (await events(page)).slice(1)], [[], [], [
      'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
      'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
    ]]);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});
