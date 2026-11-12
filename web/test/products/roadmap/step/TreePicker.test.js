import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { StepDetail } from '/src/products/roadmap/step/StepDetail.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { Openings } from '/src/products/roadmap/model/Opening.js';

const noop = () => {};
const call = (line) => (window.calls ??= []).push(line);
const bandOf = (width) => (width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop');

// My year with the step Learn to sail open. \`holder\` hands the step its tree acts; \`facts\` is what the server would
// answer of each tree once a pointer is read, and a tree it lacks stays unread.
window.openStep = ({ steps, completed, opens = {}, facts = {}, holder = true, editable = true, rows = [], cards = {}, step = 'sail' }) => {
  window.rows = rows;
  window.cards = cards;
  function App() {
    const [nodes, setNodes] = useState(steps);
    const [read, setRead] = useState(opens);
    const [open, setOpen] = useState(true);
    const [breakpoint, setBreakpoint] = useState(() => bandOf(window.innerWidth));
    useEffect(() => {
      const follow = () => setBreakpoint(bandOf(window.innerWidth));
      window.addEventListener('resize', follow);
      return () => window.removeEventListener('resize', follow);
    }, []);
    const tree = useMemo(() => new SkillTree(Openings.fromWire(read).onto({ id: 't_year', title: 'My year', nodes }, { joined: true })), [nodes, read]);
    const marks = useMemo(() => new Set(completed), []);
    const treeActs = holder ? {
      view: 'board',
      trees: {
        list: async () => {
          call('list');
          if (window.listFails > 0) {
            window.listFails -= 1;
            return { rows: [], authoritative: false, status: window.listStatus ?? 503 };
          }
          return { rows: window.rows, authoritative: true };
        },
        read: async (id) => {
          call('read ' + id);
          if (window.cards[id] === 'fail') throw Object.assign(new Error('unread'), { status: 503 });
          return window.cards[id] ?? null;
        },
      },
      set: (id, treeId) => {
        call('set ' + id + ' ' + (treeId || 'none'));
        if (window.setRefused) return { ok: false };
        setNodes((current) => current.map((node) => (node.id === id ? { ...node, opens: treeId || undefined } : node)));
        setRead((current) => {
          const { [id]: gone, ...rest } = current;
          return treeId && facts[treeId] ? { ...rest, [id]: { treeId, ...facts[treeId] } } : rest;
        });
        return { ok: true };
      },
    } : null;
    return React.createElement('div', { style: { position: 'fixed', inset: 0 } },
      React.createElement('button', { id: 'beneath' }, 'Beneath'),
      open && React.createElement(StepDetail, {
        tree, completed: marks, completedAt: {}, address: { id: step, trail: [step], door: 'card' }, breakpoint, roadmapTitle: 'My year',
        editable, deletable: true, stepLink: null, workspace: { subtasks: [], note: '', links: [] },
        workspaceActions: { onToggleSubtask: noop, onAddSubtask: noop, onEditSubtask: noop, onDeleteSubtask: noop, onSetNote: noop, onAddLink: noop, onDeleteLink: noop },
        history: [], onEdit: editable ? noop : undefined, onOpenStep: noop, onBack: () => { call('back'); setOpen(false); },
        onClose: () => { call('close'); setOpen(false); }, onComplete: noop, onReset: noop, onRestore: noop, onOpenInGraph: null, onViewBranch: noop,
        onDelete: noop, onNotify: noop, treeActs,
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;

let server, browser, origin;
let ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-tree-picker-test`,
      plugins: [{ name: 'tree-picker-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/tree-picker-entry.js') return '\0tree-picker-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0tree-picker-beacon';
          if (id.endsWith('/reportFailure.js')) return '\0tree-picker-report';
        },
        load(id) {
          if (id === '\0tree-picker-entry') return entry;
          if (id === '\0tree-picker-beacon') {
            return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
              + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
          }
          if (id === '\0tree-picker-report') {
            return 'export function reportRoadmapFailure(operation, error) { (window.reports ??= []).push(`${operation}: ${error.message}`); }\n'
              + 'export function reportUnexpectedFailure(operation) { (window.reports ??= []).push(operation); }\n'
              + 'export function pageWatching() { return window.watching !== false; }';
          }
        },
        configureServer(server) {
          server.middlewares.use('/tree-picker-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Tree picker test</title><div id="root"></div><script type="module" src="/tree-picker-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

const DESKTOP = { width: 1440, height: 960 };
const PHONE = { width: 390, height: 844 };
const myYear = (sail = {}) => [
  { id: 'plan', label: 'Plan the year', prerequisites: [], color: 'gold' },
  { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], color: 'sky', ...sail },
  { id: 'coast', label: 'Sail the coast', prerequisites: ['sail'], color: 'sky' },
  { id: 'maya', label: 'Take Maya sailing', prerequisites: ['sail'], color: 'gold' },
];
const ownTrees = () => [
  { id: 't_sail', title: 'Learn to sail', done: 3, total: 8, updatedAt: 5 },
  { id: 't_read', title: 'Reading list', done: 12, total: 12, updatedAt: 4 },
  { id: 't_year', title: 'My year', done: 3, total: 6, updatedAt: 3 },
  { id: 't_empty', title: '  ', done: 0, total: 0, updatedAt: 2 },
];
const FACTS = {
  t_sail: { title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false },
  t_read: { title: 'Reading list', state: 'complete', done: 12, total: 12, loop: false },
};
const opened = (treeId) => ({ sail: { treeId, ...FACTS[treeId] } });

async function openStep(viewport, options, errors) {
  await start();
  const context = await browser.newContext({ viewport, hasTouch: viewport === PHONE });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/tree-picker-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((given) => window.openStep(given), { steps: myYear(), completed: ['plan', 'sail'], rows: ownTrees(), facts: FACTS, ...options });
  await page.locator('.st-board-step-layer [role="dialog"]').first().waitFor();
  return page;
}

const calls = (page) => page.evaluate(() => window.calls ?? []);
const events = (page) => page.evaluate(() => (window.events ?? []).filter((line) => line.startsWith('roadmap_tree_attach')));
const reports = (page) => page.evaluate(() => window.reports ?? []);
const focused = (page) => page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent.trim().slice(0, 40));
const treeSection = (page) => page.evaluate(() => {
  const section = document.querySelector('.st-board-step-relations--tree');
  if (!section) return null;
  return {
    heading: [...section.querySelectorAll('h3 > span')].map((part) => part.textContent),
    controls: [...section.querySelectorAll('.st-board-step-icon-button')].map((button) => button.getAttribute('aria-label')),
    row: section.querySelector('.st-board-step-tree-title')?.textContent ?? null,
    rule: section.querySelector('.st-board-step-tree-rule')?.textContent ?? null,
  };
});
const picker = (page) => page.evaluate(() => {
  const region = document.querySelector('.st-board-tree-picker');
  if (!region) return null;
  const text = (selector) => [...region.querySelectorAll(selector)].map((node) => node.textContent);
  return {
    title: region.querySelector('h2').textContent,
    context: region.querySelector('.st-board-picker-context').textContent,
    rows: [...region.querySelectorAll('[role="radio"]')].map((row) => `${row.getAttribute('aria-checked') === 'true' ? '●' : '○'} ${row.querySelector('strong').textContent} · ${row.querySelector('.st-board-picker-row-text > span').textContent}${row.getAttribute('aria-disabled') === 'true' ? ' · blocked' : ''}`),
    lines: text('.st-board-tree-picker-line'),
    said: text('.st-board-picker-empty h3, .st-board-picker-empty p, .st-board-tree-picker-unread p'),
    fork: text('.st-board-tree-picker-fork'),
    commit: [...region.querySelectorAll('.st-board-picker-actions .st-board-step-action--primary')].map((button) => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`),
  };
});
const attachATree = (page) => page.getByRole('button', { name: 'Attach a tree' }).click();
const listed = (page) => page.locator('.st-board-tree-picker [role="radio"]').first().waitFor();
const SAIL_ROWS = ['○ Learn to sail · 3 of 8 done', '○ Reading list · 12 of 12 done', '○ Untitled roadmap · No steps'];
const FORK_LINE = ['Someone else’s roadmap? Fork it first — the copy is yours.'];

for (const viewport of [DESKTOP, PHONE]) {
  const band = viewport === PHONE ? 'phone' : 'desktop';

  test(`${band}: the holder’s ordinary step says Tree · None with a +; its picker lists their other trees, one choice, and Attach sets the tree`, async () => {
    const errors = [];
    const page = await openStep(viewport, {}, errors);
    assert.deepEqual(await treeSection(page), { heading: ['Tree', 'None'], controls: ['Attach a tree'], row: null, rule: null });

    await attachATree(page);
    await listed(page);
    assert.deepEqual(await picker(page), {
      title: 'Attach a tree', context: 'For Learn to sail · 3 trees', rows: SAIL_ROWS,
      lines: ['Your Done mark is set aside while it opens a tree, so 2 steps lock again.'], said: [], fork: FORK_LINE, commit: ['Attach (disabled)'],
    });
    assert.equal(await page.getByRole('dialog', { name: 'Attach a tree' }).count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.className), band === 'phone'
      ? 'st-board-picker st-board-tree-picker st-board-picker--phone' : 'Find a tree');

    await page.getByRole('radio', { name: /Reading list/ }).click();
    assert.deepEqual((await picker(page)).lines, ['Your Done mark is set aside while it opens a tree.'], 'a complete tree keeps the step done');
    await page.getByRole('radio', { name: /Learn to sail/ }).click();
    assert.deepEqual({ rows: (await picker(page)).rows, commit: (await picker(page)).commit, lines: (await picker(page)).lines }, {
      rows: ['● Learn to sail · 3 of 8 done', '○ Reading list · 12 of 12 done', '○ Untitled roadmap · No steps'], commit: ['Attach'],
      lines: ['Your Done mark is set aside while it opens a tree, so 2 steps lock again.'],
    });

    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Tree actions');
    assert.deepEqual(await treeSection(page), { heading: ['Tree'], controls: ['Tree actions'], row: 'Learn to sail', rule: 'Done when every step in Learn to sail is done.' });
    assert.deepEqual(await calls(page), ['list', 'set sail t_sail']);
    assert.deepEqual(await events(page), [`roadmap_tree_attach {"step":"open","band":"${band}","view":"board"}`]);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test(`${band}: Escape, Cancel and a press beside the modal leave the picker before the step, and focus returns to the +`, async () => {
    const errors = [];
    const page = await openStep(viewport, {}, errors);

    await attachATree(page);
    await listed(page);
    await page.keyboard.press('Escape');
    await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Attach a tree');
    assert.equal(await page.locator('.st-board-step-layer').count(), 1);

    await attachATree(page);
    await listed(page);
    await page.getByRole('button', { name: band === 'phone' ? 'Cancel' : 'Back to Learn to sail' }).click();
    await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Attach a tree');
    if (band === 'desktop') {
      await attachATree(page);
      await listed(page);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
      await attachATree(page);
      await listed(page);
      await page.mouse.click(20, 400);
      await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.st-board-step-layer').count(), 1);
    }
    assert.deepEqual((await calls(page)).filter((line) => line !== 'list'), []);

    await page.keyboard.press('Escape');
    await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
    assert.deepEqual((await calls(page)).at(-1), band === 'phone' ? 'back' : 'close');
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test(`${band}: the Tree heading’s ⋯ changes the tree from the picker with the current one chosen, and detaches with nothing asked`, async () => {
    const errors = [];
    const page = await openStep(viewport, { steps: myYear({ opens: 't_sail' }), opens: opened('t_sail') }, errors);
    assert.deepEqual(await treeSection(page), { heading: ['Tree'], controls: ['Tree actions'], row: 'Learn to sail', rule: 'Done when every step in Learn to sail is done.' });

    await page.getByRole('button', { name: 'Tree actions' }).click();
    const rows = band === 'phone' ? page.locator('.st-board-sheet--tree .st-board-tree-sheet-row') : page.getByRole('menuitem');
    assert.deepEqual(await rows.allTextContents(), ['Change tree', 'Detach tree']);
    assert.equal(await page.locator(band === 'phone' ? '.st-board-tree-sheet-footnote' : '.st-board-step-tree-footnote').textContent(),
      'Learn to sail stays. This step becomes ordinary; your Done mark returns.');
    if (band === 'phone') {
      assert.equal(await page.getByRole('dialog', { name: 'Learn to sail' }).locator('.st-board-tree-sheet-eyebrow').textContent(), 'Tree');
    } else {
      assert.equal(await focused(page), 'Change tree');
      await page.keyboard.press('ArrowDown');
      assert.equal(await focused(page), 'Detach tree');
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Tree actions');
    assert.equal(await rows.count(), 0);
    assert.equal(await page.locator('.st-board-step-layer').count(), 1, 'Escape closed the menu, not the step');

    await page.getByRole('button', { name: 'Tree actions' }).click();
    await rows.filter({ hasText: 'Change tree' }).click();
    await listed(page);
    assert.deepEqual({ rows: (await picker(page)).rows, commit: (await picker(page)).commit, lines: (await picker(page)).lines }, {
      rows: ['● Learn to sail · 3 of 8 done', '○ Reading list · 12 of 12 done', '○ Untitled roadmap · No steps'], commit: ['Attach (disabled)'],
      lines: ['Your Done mark is set aside while it opens a tree.'],
    });
    await page.getByRole('radio', { name: /Reading list/ }).click();
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
    assert.equal((await treeSection(page)).row, 'Reading list');

    await page.getByRole('button', { name: 'Tree actions' }).click();
    await rows.filter({ hasText: 'Detach tree' }).click();
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Attach a tree');
    assert.deepEqual(await treeSection(page), { heading: ['Tree', 'None'], controls: ['Attach a tree'], row: null, rule: null });
    assert.deepEqual(await calls(page), ['list', 'set sail t_read', 'set sail none']);
    assert.deepEqual(await events(page), [`roadmap_tree_attach {"step":"open","band":"${band}","view":"board"}`]);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test(`${band}: a pasted address of the person’s own tree selects its row; one they can only read is the blocked row, forked first, and the copy is then theirs to choose`, async () => {
    const errors = [];
    const card = { id: 't_reef', title: 'Reefing course', author: null, steps: 4, mine: false };
    const page = await openStep(viewport, { cards: { t_reef: card } }, errors);
    await page.route('**/v1/trees/t_reef/fork', async (route) => {
      await page.evaluate(() => { window.rows = [{ id: 't_copy', title: 'Reefing course', done: 0, total: 4, updatedAt: 9 }, ...window.rows]; });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ data: { id: 't_copy' } }) });
    });
    await attachATree(page);
    await listed(page);

    await page.getByLabel('Find a tree').fill('https://windmill.works/#/app/t_read');
    assert.deepEqual({ context: (await picker(page)).context, rows: (await picker(page)).rows, commit: (await picker(page)).commit },
      { context: 'For Learn to sail · 1 match', rows: ['● Reading list · 12 of 12 done'], commit: ['Attach'] });

    await page.getByLabel('Find a tree').fill('windmill.works/t/t_reef');
    await page.locator('.st-board-tree-picker .is-blocked').waitFor();
    assert.deepEqual(await picker(page), {
      title: 'Attach a tree', context: 'For Learn to sail · 1 match', rows: ['○ Reefing course · Someone else’s · you can read it · blocked'],
      lines: ['Steps open only your own trees. Fork this, then choose the copy.'], said: [], fork: [], commit: ['Fork tree'],
    });

    await page.getByRole('button', { name: 'Fork tree' }).click();
    await page.getByRole('dialog', { name: 'Make it yours' }).getByRole('button', { name: 'Fork this tree' }).click();
    await page.locator('.st-board-tree-picker .is-blocked').waitFor({ state: 'detached' });
    await listed(page);
    assert.deepEqual(await picker(page), {
      title: 'Attach a tree', context: 'For Learn to sail · 4 trees', rows: ['○ Reefing course · 0 of 4 done', '○ Learn to sail · 3 of 8 done', '● Reading list · 12 of 12 done', '○ Untitled roadmap · No steps'],
      lines: ['Your Done mark is set aside while it opens a tree.'], said: [], fork: FORK_LINE, commit: ['Attach'],
    });
    assert.equal(await page.getByLabel('Find a tree').inputValue(), '');
    assert.deepEqual((await calls(page)).filter((line) => line.startsWith('set')), [], 'Fork attaches nothing by itself');
    assert.deepEqual(await events(page), [
      `roadmap_tree_attach {"step":"open","band":"${band}","view":"board"}`,
      `roadmap_tree_attach {"step":"paste","outcome":"own","band":"${band}","view":"board"}`,
      `roadmap_tree_attach {"step":"paste","outcome":"readable","band":"${band}","view":"board"}`,
      `roadmap_tree_attach {"step":"fork","band":"${band}","view":"board"}`,
    ]);
    assert.deepEqual(await reports(page), []);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
}

test('Find a tree narrows by title, / reaches it, the arrows walk the rows, and a search that matches nothing says so with the way out', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, {}, errors);
  await attachATree(page);
  await listed(page);

  await page.getByRole('radio', { name: /Learn to sail/ }).click();
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), 'Reading list12 of 12 done');
  await page.keyboard.press('Enter');
  assert.equal((await picker(page)).rows[1], '● Reading list · 12 of 12 done');
  await page.keyboard.press('/');
  assert.equal(await focused(page), 'Find a tree');

  await page.keyboard.type('  SAIL');
  assert.deepEqual({ context: (await picker(page)).context, rows: (await picker(page)).rows }, { context: 'For Learn to sail · 1 match', rows: ['○ Learn to sail · 3 of 8 done'] });
  await page.getByLabel('Find a tree').fill('bike');
  assert.deepEqual(await picker(page), {
    title: 'Attach a tree', context: 'For Learn to sail · 0 matches', rows: [], lines: [],
    said: ['No trees match “bike”', 'Your selection is kept.'], fork: FORK_LINE, commit: ['Attach'],
  });
  await page.locator('.st-board-picker-empty').getByRole('button', { name: 'Clear search' }).click();
  assert.equal(await focused(page), 'Find a tree');
  assert.deepEqual((await picker(page)).rows, ['○ Learn to sail · 3 of 8 done', '● Reading list · 12 of 12 done', '○ Untitled roadmap · No steps']);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('the person owns no other tree: the picker says so, Attach stays disabled and the fork line stays', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, { rows: [{ id: 't_year', title: 'My year', done: 3, total: 6, updatedAt: 3 }] }, errors);
  await attachATree(page);
  await page.locator('.st-board-tree-picker-line').waitFor();

  assert.deepEqual(await picker(page), {
    title: 'Attach a tree', context: 'For Learn to sail', rows: [], lines: ['You have no other trees yet.'], said: [], fork: FORK_LINE, commit: ['Attach (disabled)'],
  });
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('a list that could not be loaded says so with Try again, never the empty state, and reports once while someone is waiting', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, {}, errors);
  await page.evaluate(() => { window.listFails = 2; });
  await attachATree(page);
  await page.locator('.st-board-tree-picker-unread').waitFor();

  assert.deepEqual(await picker(page), {
    title: 'Attach a tree', context: 'For Learn to sail', rows: [], lines: [], said: ['Couldn’t load your trees'], fork: FORK_LINE, commit: ['Attach (disabled)'],
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => window.calls.filter((line) => line === 'list').length === 2);
  assert.deepEqual((await picker(page)).said, ['Couldn’t load your trees']);
  await page.getByRole('button', { name: 'Try again' }).click();
  await listed(page);
  assert.deepEqual((await picker(page)).rows, SAIL_ROWS);
  assert.deepEqual(await reports(page), ['roadmap-tree-picker-load: Roadmap tree picker read failed']);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('a refused list and a list lost with no connection say the same and report nothing', async () => {
  for (const lost of [{ listStatus: 401 }, { listStatus: 0, watching: false }]) {
    const errors = [];
    const page = await openStep(DESKTOP, {}, errors);
    await page.evaluate((given) => Object.assign(window, { listFails: 1 }, given), lost);
    await attachATree(page);
    await page.locator('.st-board-tree-picker-unread').waitFor();

    assert.deepEqual((await picker(page)).said, ['Couldn’t load your trees']);
    assert.deepEqual(await reports(page), []);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
});

test('a pasted address that names no roadmap the person can read says so and changes nothing; one whose read failed offers Try again', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, { cards: { t_down: 'fail' } }, errors);
  await attachATree(page);
  await listed(page);
  await page.getByRole('radio', { name: /Learn to sail/ }).click();

  await page.getByLabel('Find a tree').fill('windmill.works/t/t_private');
  await page.locator('.st-board-tree-picker-line').waitFor();
  assert.deepEqual(await picker(page), {
    title: 'Attach a tree', context: 'For Learn to sail · 0 matches', rows: [], lines: ['No roadmap you can read is at that address.'], said: [], fork: FORK_LINE, commit: ['Attach'],
  });
  await page.getByLabel('Find a tree').fill('');
  assert.equal((await picker(page)).rows[0], '● Learn to sail · 3 of 8 done');

  await page.getByLabel('Find a tree').fill('windmill.works/t/t_down');
  await page.locator('.st-board-tree-picker-unread').waitFor();
  assert.deepEqual((await picker(page)).said, ['Couldn’t load your trees']);
  await page.evaluate(() => { window.cards.t_down = null; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('.st-board-tree-picker-line').waitFor();
  assert.deepEqual((await picker(page)).lines, ['No roadmap you can read is at that address.']);
  assert.deepEqual(await calls(page), ['list', 'read t_private', 'read t_down', 'read t_down']);
  assert.deepEqual((await events(page)).filter((line) => line.includes('paste')), [
    'roadmap_tree_attach {"step":"paste","outcome":"unreadable","band":"desktop","view":"board"}',
    'roadmap_tree_attach {"step":"paste","outcome":"unreadable","band":"desktop","view":"board"}',
  ]);
  assert.deepEqual(await reports(page), ['roadmap-tree-picker-load: Roadmap tree picker read failed']);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('a step with no mark has no hand-mark line, and its ⋯ footnote says only that the step becomes ordinary', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, { completed: ['plan'] }, errors);
  await attachATree(page);
  await listed(page);
  await page.getByRole('radio', { name: /Learn to sail/ }).click();
  assert.deepEqual((await picker(page)).lines, []);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();

  await page.getByRole('button', { name: 'Tree actions' }).click();
  assert.equal(await page.locator('.st-board-step-tree-footnote').textContent(), 'Learn to sail stays. This step becomes ordinary.');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('an attach the session would not take leaves the picker open for another try', async () => {
  const errors = [];
  const page = await openStep(DESKTOP, {}, errors);
  await page.evaluate(() => { window.setRefused = true; });
  await attachATree(page);
  await listed(page);
  await page.getByRole('radio', { name: /Learn to sail/ }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();

  assert.deepEqual((await picker(page)).commit, ['Attach']);
  await page.evaluate(() => { window.setRefused = false; });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.locator('.st-board-tree-picker').waitFor({ state: 'detached' });
  assert.deepEqual(await calls(page), ['list', 'set sail t_sail', 'set sail t_sail']);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('where the person can detach, a loop and a missing tree say the way out; a tree not read yet keeps its heading and ⋯ with no row', async () => {
  const errors = [];
  const loop = { sail: { treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true } };
  const looped = await openStep(DESKTOP, { steps: myYear({ opens: 't_sail' }), opens: loop }, errors);
  assert.equal((await treeSection(looped)).rule, 'A loop with My year: this never completes. Detach one side.');
  await looped.context().close();

  const missing = await openStep(DESKTOP, { steps: myYear({ opens: 't_gone' }), opens: { sail: { treeId: 't_gone', missing: true } } }, errors);
  assert.deepEqual(await treeSection(missing), { heading: ['Tree'], controls: ['Tree actions'], row: 'Tree not found', rule: 'This tree can’t be found. Choose another, or detach it.' });
  await missing.getByRole('button', { name: 'Tree actions' }).click();
  assert.equal(await missing.locator('.st-board-step-tree-footnote').textContent(), 'This step becomes ordinary; your Done mark returns.');
  await missing.context().close();

  const unread = await openStep(DESKTOP, { steps: myYear({ opens: 't_unread' }) }, errors);
  assert.deepEqual(await treeSection(unread), { heading: ['Tree'], controls: ['Tree actions'], row: null, rule: null });
  await unread.context().close();
  assert.deepEqual(errors, []);
});

test('nobody but the holder has the +, the ⋯ or the way out in words: a reader’s step has no Tree section, and a tree shown without them is as it was', async () => {
  const errors = [];
  for (const who of [{ holder: false }, { editable: false }]) {
    const ordinary = await openStep(DESKTOP, who, errors);
    assert.equal(await treeSection(ordinary), null);
    assert.equal(await ordinary.getByRole('button', { name: 'Attach a tree' }).count(), 0);
    await ordinary.context().close();

    const loop = { sail: { treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true } };
    const looped = await openStep(DESKTOP, { ...who, steps: myYear({ opens: 't_sail' }), opens: loop }, errors);
    assert.deepEqual(await treeSection(looped), { heading: ['Tree'], controls: [], row: 'Learn to sail', rule: 'A loop with My year: this never completes.' });
    await looped.context().close();

    const missing = await openStep(DESKTOP, { ...who, steps: myYear({ opens: 't_gone' }), opens: { sail: { treeId: 't_gone', missing: true } } }, errors);
    assert.deepEqual(await treeSection(missing), { heading: ['Tree'], controls: [], row: 'Tree not found', rule: 'This tree can’t be found.' });
    await missing.context().close();

    const unread = await openStep(DESKTOP, { ...who, steps: myYear({ opens: 't_unread' }) }, errors);
    assert.equal(await treeSection(unread), null);
    await unread.context().close();
  }
  assert.deepEqual(errors, []);
});
