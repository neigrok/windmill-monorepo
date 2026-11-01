import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { startTransition, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { StepDetail } from '/src/products/roadmap/board/StepDetail.jsx';
import { useStepAddress, stepIsStale } from '/src/products/roadmap/board/stepAddress.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { advanceProgress } from '/src/products/roadmap/model/progress.js';
import { toggleSubtask } from '/src/products/roadmap/model/NodeWorkspace.js';

const noop = () => {};
const call = (line) => (window.calls ??= []).push(line);
const bandOf = (width) => (width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop');
const without = (steps, id) => steps.filter((step) => step.id !== id).map((step) => ({ ...step, prerequisites: step.prerequisites.filter((need) => need !== id) }));

// Like the shell: the route follows the URL in a transition, and each roadmap is its own view, keyed by its id, that
// loads its tree a beat after it mounts.
window.openRoom = ({ nodes, completed, editable = true, workspaces = {}, kinds = [], linked = true, gate = true, others = {} }) => {
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
    const tree = useMemo(() => (steps === null ? null : new SkillTree({ id: treeId, title: 'Learn to sail', nodes: steps })), [steps]);
    const [progress, setProgress] = useState({ completed: new Set(completed), completedAt: Object.fromEntries(completed.map((id, index) => [id, index + 1])) });
    const [selectedId, setSelectedId] = useState(null);
    const [spaces, setSpaces] = useState(workspaces);
    const [query, setQuery] = useState(() => new BoardQuery({ kinds }));
    const [breakpoint, setBreakpoint] = useState(() => bandOf(window.innerWidth));
    const address = useStepAddress();
    useEffect(() => {
      const follow = () => setBreakpoint(bandOf(window.innerWidth));
      window.addEventListener('resize', follow);
      return () => window.removeEventListener('resize', follow);
    }, []);
    const stale = stepIsStale({ boardOpen: gate, loading: tree === null, tree, treeId, stepId: address.id });
    useEffect(() => { if (stale) address.drop(); }, [stale]);
    const mark = (id, target) => setProgress((current) => advanceProgress(current, [id], target, Date.now()));
    window.restoreSteps = () => setSteps(trees[treeId]);
    if (tree === null) return null;
    const open = gate && address.id !== null && tree.nodesById.has(address.id);
    return React.createElement('div', { style: { position: 'fixed', inset: 0 } },
      React.createElement('div', { className: 'st-view-layer--board is-active', style: { position: 'absolute', inset: 0, zIndex: 18 } },
        React.createElement(BoardView, { tree, completed: progress.completed, completedAt: progress.completedAt, selectedId,
          onSelect: (id) => { setSelectedId(id); address.open(id, 'card'); }, onAnchor: setSelectedId, breakpoint, active: true,
          onSwitchView: noop, query, onQuery: setQuery })),
      open && React.createElement(StepDetail, {
        tree, completed: progress.completed, completedAt: progress.completedAt, address, breakpoint, roadmapTitle: 'Learn to sail',
        editable, deletable: true, stepLink: linked ? 'https://windmill.test/t/sail#?step=' + address.id : null,
        workspace: spaces[address.id] ?? { subtasks: [], note: '', links: [] },
        workspaceActions: { onToggleSubtask: (nodeId, subtaskId) => setSpaces((current) => ({ ...current, [nodeId]: toggleSubtask(current[nodeId], subtaskId) })),
          onAddSubtask: noop, onEditSubtask: noop, onDeleteSubtask: noop, onSetNote: noop, onAddLink: noop, onDeleteLink: noop },
        history: [],
        onOpenStep: (id) => address.open(id, 'step'),
        onBack: address.back,
        onClose: () => { const origin = address.trail[0]; address.close(); setSelectedId(origin); },
        onComplete: (id) => { call('complete ' + id); mark(id, 'complete'); },
        onReset: (id) => { call('reset ' + id); mark(id, 'none'); },
        onRestore: (id, snapshot) => { call('restore ' + id); mark(id, snapshot.completed.has(id) ? 'complete' : 'none'); },
        onOpenInGraph: (id) => call('graph ' + id),
        onViewBranch: (id) => { call('branch ' + id); address.close(); setQuery((current) => current.inBranch(id)); },
        onDelete: (id) => { call('delete ' + id); address.close(); setSteps((current) => without(current, id)); },
        onNotify: (message) => call('notify ' + message),
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-step-detail-test`,
    plugins: [{ name: 'step-detail-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/step-detail-entry.js') return '\0step-detail-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0step-detail-beacon';
      },
      load(id) {
        if (id === '\0step-detail-entry') return entry;
        if (id === '\0step-detail-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/step-detail-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Step detail test</title><div id="root"></div><script type="module" src="/step-detail-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
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

async function openRoom({ viewport, nodes = learnToSailNodes, editable = true, workspaces = {}, kinds = [], linked = true, gate = true, others = {}, start = '#/app/sail', clock = false, permissions = [] }, errors) {
  const context = await browser.newContext({ viewport, permissions });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (clock) await page.clock.install();
  await page.goto(`${origin}/step-detail-test${start}`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((options) => openRoom(options), { nodes, completed: ['course', 'parts', 'rig'], editable, workspaces, kinds, linked, gate, others });
  await page.locator('.st-board-card:visible').first().waitFor();
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
  const row = document.querySelector('.st-board-step-status');
  return [...row.querySelectorAll('.st-board-step-status-label, .st-board-step-undo, .st-board-step-outcome')].map((part) => part.textContent).filter(Boolean);
});
const column = (page, name) => page.evaluate((name) => [...document.querySelectorAll(`[data-column="${name}"] .st-board-card-title`)].map((title) => title.textContent), name);
const card = (page, label) => page.locator('.st-board-card:visible', { has: page.locator('.st-board-card-title', { hasText: new RegExp(`^${label}$`) }) });

test('Chromium: Enter on a card opens the labelled modal, Tab stays inside it, Escape closes it and focus returns to the card', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Read the wind' });
    await dialog.waitFor();
    assert.deepEqual([await hash(page), await page.evaluate(() => document.activeElement.getAttribute('role'))], ['#/app/sail?step=wind', 'dialog']);

    const stops = [];
    for (let press = 0; press < 9; press += 1) {
      await page.keyboard.press('Tab');
      stops.push(await focusedName(page));
    }
    assert.deepEqual(stops, ['More', 'Close', 'Overview', 'Sailing basics', 'Name the boat parts, done', 'Leave the dock, locked', 'View branch', 'Complete', 'More']);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusedName(page), 'Complete');

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await hash(page), await events(page)],
      ['Read the wind', '#/app/sail', ['roadmap_board_step_open {"surface":"modal","column":"upNext","door":"card"}']]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: from 744px the modal takes the 696px form, 24px in from the window', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 744, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    const box = await page.locator('.st-board-step-modal').boundingBox();
    assert.deepEqual([box.x, box.y, box.width, box.height], [24, 80, 696, 800]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Complete and Reset act in place — the modal stays, the status flips with Undo, a line names what moved, nothing toasts', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    assert.deepEqual([await status(page), await column(page, 'upNext')],
      [['Done', 'Undo', 'Leave the dock is up next'], ['Leave the dock', 'Tie a bowline']]);
    await page.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual([await status(page), await column(page, 'upNext')], [['Up next'], ['Read the wind', 'Tie a bowline']]);

    await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
    await page.getByRole('dialog', { name: 'Name the boat parts' }).waitFor();
    await page.getByRole('button', { name: 'Reset' }).hover();
    assert.equal(await page.locator('.st-board-step-preview').textContent(), 'Reset returns 2 steps to Locked');
    await page.getByRole('button', { name: 'Reset' }).click();
    assert.deepEqual([await status(page), await column(page, 'locked')],
      [['Up next', 'Undo', '2 steps locked again'], ['Read the wind', 'Tie a bowline', 'Leave the dock', 'Sail a triangle', 'Sail solo']]);

    assert.deepEqual([await calls(page), await events(page)], [['complete wind', 'restore wind', 'reset parts'], [
      'roadmap_board_step_open {"surface":"modal","column":"upNext","door":"card"}',
      'roadmap_board_step_action {"surface":"modal","action":"complete"}',
      'roadmap_board_step_action {"surface":"modal","action":"undo"}',
      'roadmap_board_step_open {"surface":"modal","column":"done","door":"step"}',
      'roadmap_board_step_action {"surface":"modal","action":"reset"}',
    ]]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo lasts the hold window, then goes; the outcome line and Reset remain', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, clock: true }, errors);
  try {
    await card(page, 'Read the wind').click();
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

test('Chromium: a locked step leads with what it still needs; on the phone each unmet need names its column and opens it', async () => {
  await ready;
  const errors = [];
  const desktop = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  const phone = await openRoom({ viewport: { width: 390, height: 844 } }, errors);
  const overview = (page) => page.evaluate(() => [...document.querySelectorAll('.st-board-step-panel > *')].map((part) => part.innerText.replace(/\n+/g, ' | ')));
  try {
    await card(desktop, 'Leave the dock').click();
    assert.deepEqual([await overview(desktop), await desktop.locator('.st-board-step-modal-actions').count()], [[
      'Cast off safely and steer clear of the dock.',
      'Locked · 1 to go',
      'Prerequisites | 1 / 2 | Rig the boat | Read the wind',
      'Unlocks | 1 | Sail a triangle',
    ], 0]);

    await phone.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await card(phone, 'Leave the dock').click();
    assert.deepEqual(await phone.locator('.st-board-step-row--need').allInnerTexts(), ['Read the wind\nUp next']);
    await phone.getByRole('button', { name: 'Read the wind, up next' }).click();
    await phone.getByRole('dialog', { name: 'Read the wind' }).waitFor();
    assert.equal(await phone.locator('.st-board-step-page-back').getAttribute('aria-label'), 'Back to Leave the dock');
    await phone.locator('.st-board-step-page-back').click();
    await phone.getByRole('dialog', { name: 'Leave the dock' }).waitFor();
    assert.equal(await phone.locator('.st-board-step-page-back').getAttribute('aria-label'), 'Back to Learn to sail');
    assert.deepEqual(await events(phone), [
      'roadmap_board_column {"column":"locked"}',
      'roadmap_board_step_open {"surface":"page","column":"locked","door":"card"}',
      'roadmap_board_step_open {"surface":"page","column":"upNext","door":"step"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await desktop.context().close();
    await phone.context().close();
  }
});

test('Chromium: on the phone a step is a pushed page, and Back returns to the same pane, scroll and card', async () => {
  await ready;
  const errors = [];
  const knots = Array.from({ length: 14 }, (_, index) => ({ id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: ['solo'], color: 'plum' }));
  const page = await openRoom({ viewport: { width: 390, height: 844 }, nodes: [...learnToSailNodes, ...knots] }, errors);
  try {
    await page.getByRole('tab', { name: 'Locked, 17 steps' }).click();
    const pane = page.locator('.st-board-phone-pane.is-shown');
    await pane.evaluate((element) => { element.scrollTop = 600; });
    const scrolled = await pane.evaluate((element) => element.scrollTop);
    await card(page, 'Knot 9').click();
    const dialog = page.getByRole('dialog', { name: 'Knot 9' });
    await dialog.waitFor();
    assert.deepEqual([await page.locator('.st-board-step-page-back-label').textContent(), await page.locator('.st-view-layer--board').evaluate((layer) => layer.inert)],
      ['Learn to sail', true]);

    await page.locator('.st-board-step-page-back').click();
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
  await ready;
  const errors = [];
  const workspaces = { wind: { subtasks: [{ id: 's1', label: 'Watch the telltales', done: true }, { id: 's2', label: 'Try a small turn', done: false }], note: '', links: [] } };
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, workspaces }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('tab', { name: 'Workspace' }).click();
    assert.equal(await page.locator('.st-board-step-offer').count(), 0);
    await page.getByText('Try a small turn').click();
    await page.locator('.st-board-step-offer').waitFor();
    assert.deepEqual([await page.locator('.st-board-step-offer').innerText(), await calls(page)], ['All subtasks done\nComplete step', []]);
    await page.getByRole('button', { name: 'Complete step' }).click();
    assert.deepEqual([await calls(page), await column(page, 'done'), (await events(page)).at(-1)],
      [['complete wind'], ['Read the wind', 'Rig the boat', 'Name the boat parts', 'Choose a sailing course'],
        'roadmap_board_step_action {"surface":"modal","action":"completeFromSubtasks"}']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: the step menu copies the step’s link with Link copied and opens the step in the Graph; a reader’s has no Delete', async () => {
  await ready;
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
      'roadmap_board_step_action {"surface":"modal","action":"copyLink","outcome":"ok"}',
      'roadmap_board_step_action {"surface":"modal","action":"openInGraph"}',
    ]]);

    await card(reader, 'Read the wind').click();
    await reader.getByRole('button', { name: 'More' }).click();
    assert.deepEqual([await items(reader), await reader.getByRole('dialog').getByRole('tablist').count(), await reader.locator('.st-board-step-page-pinned').count()],
      [['Copy link', 'Open in Graph'], 0, 0]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
    await reader.context().close();
  }
});

test('Chromium: View branch closes the step and scopes the Board to it; a locked step offers no View branch', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Leave the dock').click();
    assert.equal(await page.getByRole('button', { name: 'View branch' }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'View branch' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual([await calls(page), await column(page, 'locked'), await column(page, 'upNext'), await hash(page), (await events(page)).at(-1)], [
      ['branch wind'], ['Leave the dock', 'Sail a triangle', 'Sail solo'], ['Read the wind'], '#/app/sail',
      'roadmap_board_step_action {"surface":"modal","action":"viewBranch"}',
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
  if (element.matches('[role="dialog"]')) return 'dialog';
  return element.getAttribute('aria-label') ?? element.textContent;
});

test('Chromium: crossing 744px with a step open swaps the modal for the page and back on one live layer: focus, Back and Escape still work', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('dialog', { name: 'Read the wind' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.st-board-step-page').waitFor();
    assert.deepEqual([await activeIs(page), await page.locator('.st-board-step-layer').count(), await page.locator('.st-board-step-layer').evaluate((layer) => layer.inert)],
      ['dialog', 1, false]);
    await page.locator('.st-board-step-page-back').click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    await card(page, 'Read the wind').click();
    await page.locator('.st-board-step-page').waitFor();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('.st-board-step-modal').waitFor();
    assert.equal(await activeIs(page), 'dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await hash(page)], ['Read the wind', '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: focus never falls to the page — Complete, Undo, Reset and the subtask offer land on the status row, Escape still closes', async () => {
  await ready;
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

    await page.getByRole('tab', { name: 'Workspace' }).click();
    await page.getByText('Try a small turn').click();
    await page.getByRole('button', { name: 'Complete step' }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual([await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), await activeIs(page), await status(page)],
      ['true', 'status: Done', ['Done', 'Undo', 'Leave the dock is up next']]);
    await page.getByRole('button', { name: 'Reset' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await activeIs(page), 'status: Up next');

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await calls(page), ['complete wind', 'restore wind', 'complete wind', 'reset wind']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo expiring and a workspace edit ending hand focus to the status row or the dialog, and Escape still closes', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, clock: true }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.getByRole('button', { name: 'Undo' }).focus();
    await page.clock.runFor(6100);
    assert.equal(await activeIs(page), 'status: Done');

    await page.getByRole('tab', { name: 'Workspace' }).click();
    await page.getByRole('button', { name: 'Add to this step' }).click();
    await page.getByRole('menuitem', { name: 'Sub-task' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await activeIs(page), 'dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Undo after Reset gives the step back its mark, quietly; it completes at the Undo’s time, so it heads Done', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    assert.deepEqual(await column(page, 'done'), ['Rig the boat', 'Name the boat parts', 'Choose a sailing course']);
    await card(page, 'Name the boat parts').click();
    await page.getByRole('button', { name: 'Reset' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual([await column(page, 'done'), await status(page), await calls(page)],
      [['Name the boat parts', 'Rig the boat', 'Choose a sailing course'], ['Done'], ['reset parts', 'restore parts']]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Delete from ⋯ hands focus to the columns’ tab stop, drops the step from the URL, and restoring the step reopens nothing', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Delete step' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await page.evaluate(() => document.activeElement.tabIndex), await hash(page)],
      ['Leave the dock', 0, '#/app/sail']);
    await page.evaluate(() => restoreSteps());
    await card(page, 'Read the wind').waitFor();
    assert.deepEqual([await page.getByRole('dialog').count(), (await events(page)).filter((line) => line.startsWith('roadmap_board_step_open')).length], [0, 1]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: a stale step link leaves the URL without opening anything', async () => {
  await ready;
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/step-detail-test#/app/sail?step=gone`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((nodes) => openRoom({ nodes, completed: ['course', 'parts', 'rig'] }), learnToSailNodes);
    await page.locator('.st-board-card:visible').first().waitFor();
    await page.waitForFunction(() => window.location.hash === '#/app/sail');
    assert.deepEqual([await page.getByRole('dialog').count(), await events(page)], [0, []]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Chromium: View branch from a step the visit reached by rows hands focus to the scoped Board’s stop when the first card left the branch', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 } }, errors);
  try {
    await card(page, 'Tie a bowline').click();
    await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
    await page.getByRole('button', { name: 'Read the wind, up next' }).click();
    await page.getByRole('button', { name: 'View branch' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-board-card'));
    assert.deepEqual([await focusedName(page), await card(page, 'Tie a bowline').count(), await hash(page)], ['Read the wind', 0, '#/app/sail']);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: with no link to share, the step menu offers no Copy link', async () => {
  await ready;
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
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, others: sea, start: '#/app/sea' }, errors);
  try {
    await page.evaluate(() => { window.location.hash = '#/app/sail?step=wind'; });
    await page.getByRole('dialog', { name: 'Read the wind' }).waitFor();
    assert.deepEqual([await hash(page), await events(page)], ['#/app/sail?step=wind', ['roadmap_board_step_open {"surface":"modal","column":"upNext","door":"link"}']]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: Back from another roadmap into a step link keeps the step and opens it again', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, others: sea, start: '#/app/sail?step=wind' }, errors);
  try {
    await page.getByRole('dialog', { name: 'Read the wind' }).waitFor();
    await page.evaluate(() => { window.location.hash = '#/app/sea'; });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.evaluate(() => window.history.back());
    await page.getByRole('dialog', { name: 'Read the wind' }).waitFor();
    assert.equal(await hash(page), '#/app/sail?step=wind');
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test('Chromium: with the Board’s gate closed a step in the URL is left alone — a stale one, and one met again on Back', async () => {
  await ready;
  const errors = [];
  const page = await openRoom({ viewport: { width: 1440, height: 960 }, others: sea, start: '#/app/sail?step=nope', gate: false }, errors);
  try {
    assert.equal(await hash(page), '#/app/sail?step=nope');
    await page.evaluate(() => { window.location.hash = '#/app/sail?step=wind'; });
    await page.evaluate(() => { window.location.hash = '#/app/sea'; });
    await page.locator('.st-board-card-title', { hasText: 'Read the tide' }).waitFor();
    await page.evaluate(() => window.history.back());
    await page.locator('.st-board-card-title', { hasText: 'Read the wind' }).waitFor();
    assert.deepEqual([await hash(page), await page.getByRole('dialog').count(), await events(page)], ['#/app/sail?step=wind', 0, []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
