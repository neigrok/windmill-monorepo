import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/board/board.css';
import { RoadmapIdentity } from '/src/products/roadmap/board/RoadmapIdentity.jsx';
import { Board, BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { TreeSwitcher } from '/src/products/roadmap/ui/TreeSwitcher.jsx';
const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
  { id: 'wind', label: 'Read the wind', color: 'sky', prerequisites: [], description: 'An excerpt that stays off the compact row.' },
  { id: 'bowline', label: 'Tie a bowline', color: 'olive', prerequisites: [] },
  { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'] },
] });
const cards = new Board(tree, { completed: new Set() }).upNext.cards;
const record = (verb) => () => window.calls.push({ verb,
  menu: document.querySelectorAll('.st-roadmap-menu').length,
  popover: document.querySelectorAll('.st-roadmap-next').length,
  focused: document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent,
});
const callbacks = Object.fromEntries(['AskAI', 'Share', 'NewStep', 'Export', 'Settings', 'Shortcuts', 'Fork'].map((name) => ['on' + name, record(name)]));
const listTrees = () => Promise.resolve([]);
const sheet = { current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' }, listTrees,
  onPickTree: record('pick'), onNewRoadmap: record('new'), onBrowse: record('browse') };
const bottom = (value) => { window.bottom = value; };
function Room({ initial }) {
  const [options, setOptions] = useState(initial);
  const [query, setQuery] = useState(() => new BoardQuery());
  window.patch = (change) => setOptions((current) => ({ ...current, ...change }));
  const props = { band: 'desktop', role: 'owner', view: 'board', title: 'Learn to sail', progress: { done: 3, total: 8 },
    onSwitchView: (view) => setOptions((current) => ({ ...current, view })),
    find: { query, onQuery: setQuery }, ...callbacks,
    sheet, next: options.view === 'tree' ? { count: cards.length, cards, onOpen: (id) => { window.picked = id; record('next')(); } } : null,
    onBottom: bottom, ...options };
  if (options.switcher) props.switcher = React.createElement(TreeSwitcher, { current: { ...sheet.current, title: props.title }, listTrees });
  if (options.noFind) props.find = null;
  if (options.noNext) props.next = null;
  if (options.noVerbs) for (const key of Object.keys(callbacks)) props[key] = null;
  if (options.manyNext) props.next = { count: 30, cards: Array.from({ length: 30 }, (_, index) => ({ ...cards[0], id: 'step-' + index })), onOpen: record('next') };
  return React.createElement('div', { style: { position: 'relative', top: 50, height: 'calc(100vh - 50px)', '--content-safe-area-top': '0px' } },
    React.createElement(RoadmapIdentity, props),
    React.createElement('button', { id: 'outside', style: { position: 'absolute', top: 500, left: 20 } }, 'Outside'));
}
window.openRow = (initial) => {
  window.events = [];
  window.calls = [];
  createRoot(document.getElementById('root')).render(React.createElement(Room, { initial }));
};
window.entryReady = true;
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-roadmap-identity-test`,
    plugins: [{ name: 'roadmap-identity-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/roadmap-identity-entry.js') return '\0roadmap-identity-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0roadmap-identity-beacon';
      },
      load(id) {
        if (id === '\0roadmap-identity-entry') return entry;
        if (id === '\0roadmap-identity-beacon') return 'export function track(name, props) { window.events.push({ name, props }); }';
      },
      configureServer(server) {
        server.middlewares.use('/roadmap-identity-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Roadmap identity test</title><div id="root"></div><script type="module" src="/roadmap-identity-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

async function openRow(width, options = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${origin}/roadmap-identity-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((initial) => window.openRow(initial), options);
  await page.locator('.st-roadmap-identity').waitFor();
  return page;
}
const focus = (page) => page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent);
const names = (page) => page.locator('.st-roadmap-identity button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent));

for (const width of [1440, 1024, 744]) {
  for (const role of ['owner', 'reader']) {
    test(`Chromium: the ${width} ${role} row follows its approved variant`, async () => {
      const band = width === 744 ? 'tablet' : 'desktop';
      const page = await openRow(width, { role, band });
      try {
        const foldedFind = width < 1280 ? ['Find a step'] : [];
        const actions = role === 'reader' ? ['Share', 'Fork'] : width === 744 ? ['New step', 'More'] : ['Ask AI', 'Share', 'New step', 'More'];
        assert.deepEqual(await names(page), ['Board', 'Graph', ...foldedFind, ...actions]);
        assert.equal(await page.getByRole('searchbox', { name: 'Find a step' }).count(), width >= 1280 ? 1 : 0);
        assert.equal(await page.locator('.st-roadmap-progress').getAttribute('aria-label'), '3 of 8 steps done');
        assert.equal(await page.locator('.st-roadmap-progress').textContent(), '3/8');
        assert.equal(await page.locator('.st-roadmap-identity').evaluate((row) => row.scrollWidth <= row.clientWidth), true);
        assert.deepEqual(await page.locator('.st-roadmap-icon').evaluateAll((buttons) => buttons.map((button) => [button.getBoundingClientRect().width, button.getBoundingClientRect().height])), actions.filter((name) => ['Ask AI', 'Share', 'More'].includes(name) && !(name === 'Ask AI' && width >= 1280)).map(() => [44, 44]));
        assert.deepEqual(await page.evaluate(() => ({ reported: window.bottom, local: document.querySelector('.st-roadmap-identity').offsetHeight, viewport: document.querySelector('.st-roadmap-identity').getBoundingClientRect().bottom })), { reported: 64, local: 64, viewport: 114 });
      } finally { await page.close(); }
    });
  }
}

test('Chromium: 1279 folds Find and Ask AI, 1280 exposes the field and keycap without remounting the row', async () => {
  const page = await openRow(1279);
  try {
    assert.deepEqual([await page.locator('.st-board-find-toggle').count(), await page.locator('.st-roadmap-ask kbd').count()], [1, 0]);
    await page.locator('.st-board-find-toggle').focus();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('searchbox', { name: 'Find a step' }).waitFor();
    assert.deepEqual([await page.locator('.st-board-find-toggle').count(), await page.locator('.st-roadmap-ask kbd').allTextContents(), await focus(page)], [0, ['⌘K'], 'Find a step']);
    await page.setViewportSize({ width: 1279, height: 900 });
    await page.waitForFunction(() => document.querySelectorAll('.st-roadmap-ask kbd').length === 0);
    assert.deepEqual([await page.getByRole('searchbox').count(), await focus(page)], [1, 'Find a step']);
    await page.keyboard.press('Escape');
    await page.locator('.st-board-find-toggle').waitFor();
  } finally { await page.close(); }
});

test('Chromium: folded Find focuses, clears before folding, retains active search across a view change, and folds after empty blur', async () => {
  const page = await openRow(744, { band: 'tablet', view: 'tree' });
  try {
    const input = page.getByRole('searchbox', { name: 'Find a step' });
    await page.getByRole('button', { name: 'Find a step' }).click();
    assert.equal(await focus(page), 'Find a step');
    await input.fill('wind');
    await page.evaluate(() => window.patch({ view: 'board' }));
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
    assert.deepEqual([await input.inputValue(), await focus(page)], ['wind', 'Find a step']);
    await page.getByRole('button', { name: 'Outside' }).click();
    assert.equal(await input.inputValue(), 'wind');
    await input.focus();
    await page.keyboard.press('Escape');
    assert.deepEqual([await input.inputValue(), await focus(page)], ['', 'Find a step']);
    await page.keyboard.press('Escape');
    assert.deepEqual([await input.count(), await focus(page)], [0, 'Find a step']);
    await page.getByRole('button', { name: 'Find a step' }).click();
    await page.getByRole('button', { name: 'Outside' }).click();
    await page.locator('.st-board-find-toggle').waitFor();
    assert.equal(await input.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.events), [
      { name: 'roadmap_verb', props: { verb: 'find', door: 'row', view: 'graph', band: 'tablet' } },
      { name: 'roadmap_board_search', props: undefined },
      { name: 'roadmap_board_clear', props: { what: 'search', from: 'field' } },
      { name: 'roadmap_verb', props: { verb: 'find', door: 'row', view: 'board', band: 'tablet' } },
    ]);
  } finally { await page.close(); }
});

test('Chromium: More loops arrow focus, Escape and Tab close, and an item closes before its act', async () => {
  const page = await openRow(744, { band: 'tablet' });
  try {
    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Ask AI⌘K', 'Share roadmap', 'Export', 'Settings', 'Keyboard shortcuts?']);
    assert.equal(await focus(page), 'Ask AI⌘K');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focus(page), 'Keyboard shortcuts?');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focus(page), 'Ask AI⌘K');
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.getByRole('menu').count(), await focus(page)], [0, 'More']);
    await more.click();
    await page.keyboard.press('Tab');
    assert.deepEqual([await page.getByRole('menu').count(), await focus(page)], [0, 'Outside']);
    await more.click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.calls), [{ verb: 'Export', menu: 0, popover: 0, focused: 'More' }]);
    await more.click();
    await page.mouse.click(400, 500);
    assert.deepEqual([await page.getByRole('menu').count(), await focus(page)], [0, 'More']);
    await more.click();
    await page.getByRole('button', { name: 'Outside' }).click();
    assert.equal(await page.getByRole('menu').count(), 0);
    await more.click();
    await page.evaluate(() => window.patch({ role: 'reader' }));
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.role === 'reader');
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.evaluate(() => window.patch({ role: 'owner' }));
    await more.waitFor();
    assert.equal(await page.getByRole('menu').count(), 0);
  } finally { await page.close(); }
});

test('Chromium: Next uses Board reasons, restores focus on Escape/outside/pick, and scrolls all rows', async () => {
  const page = await openRow(1440, { view: 'tree' });
  try {
    const next = page.getByRole('button', { name: 'Next · 2', exact: true });
    await next.click();
    assert.equal(await page.getByRole('dialog', { name: '2 up next' }).count(), 1);
    assert.deepEqual(await page.locator('.st-roadmap-next-card').allTextContents(), ['Read the windUnlocks Leave the dock', 'Tie a bowline']);
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.getByRole('dialog').count(), await focus(page)], [0, 'Next · 2']);
    await next.click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.deepEqual([await page.getByRole('dialog').count(), await focus(page)], [1, 'Share']);
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.getByRole('dialog').count(), await focus(page)], [0, 'Next · 2']);
    await next.click();
    await page.getByRole('button', { name: 'Outside' }).click();
    assert.deepEqual([await page.getByRole('dialog').count(), await focus(page)], [0, 'Next · 2']);
    await next.click();
    await page.locator('.st-roadmap-next-card').first().click();
    assert.deepEqual(await page.evaluate(() => ({ picked: window.picked, calls: window.calls })), { picked: 'wind', calls: [{ verb: 'next', menu: 0, popover: 0, focused: 'Next · 2' }] });
    assert.deepEqual(await page.evaluate(() => window.events.filter((event) => event.name === 'roadmap_whats_next')), ['open', 'close', 'open', 'close', 'open', 'close', 'open', 'pick', 'close'].map((step) => ({ name: 'roadmap_whats_next', props: { step, count: '2-5' } })));
    await page.evaluate(() => window.patch({ manyNext: true }));
    await page.getByRole('button', { name: 'Next · 30', exact: true }).click();
    assert.deepEqual(await page.locator('.st-roadmap-next-list').evaluate((list) => ({ count: list.children.length, scrolls: list.scrollHeight > list.clientHeight, tabIndex: list.tabIndex })), { count: 30, scrolls: true, tabIndex: -1 });
  } finally { await page.close(); }
});

test('Chromium: null props hide verbs, Next is Graph-owner only, and absent title hides progress', async () => {
  const page = await openRow(744, { band: 'tablet', view: 'tree', noVerbs: true, noFind: true, noNext: true });
  try {
    assert.deepEqual(await names(page), ['Board', 'Graph']);
    await page.evaluate(() => window.patch({ noNext: false, next: { count: 0, cards: [] } }));
    assert.deepEqual(await names(page), ['Board', 'Graph']);
    await page.evaluate(() => window.patch({ next: { count: 2, cards: [] } }));
    const next = page.getByRole('button', { name: 'Next · 2', exact: true });
    await next.waitFor();
    assert.equal(await next.textContent(), '2');
    await page.evaluate(() => window.patch({ role: 'reader' }));
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.role === 'reader');
    assert.deepEqual(await names(page), ['Board', 'Graph']);
    await page.evaluate(() => window.patch({ title: undefined, onSwitchView: null }));
    await page.waitForFunction(() => document.querySelectorAll('.st-roadmap-progress').length === 0);
    assert.deepEqual(await names(page), []);
    assert.equal(await page.getByRole('heading').count(), 0);
  } finally { await page.close(); }
});

for (const role of ['owner', 'reader']) {
  test(`Chromium: the phone ${role} row has the full title, compact figure and only its view pair`, async () => {
    const page = await openRow(390, { band: 'phone', role, progress: { done: 3200, total: 5000 } });
    try {
      assert.deepEqual(await names(page), role === 'owner' ? ['Learn to sail', 'Board', 'Graph'] : ['Board', 'Graph']);
      assert.deepEqual(await page.locator('.st-roadmap-progress').evaluate((figure) => [figure.textContent, figure.getAttribute('aria-label')]), ['3.2k/5k', '3,200 of 5,000 steps done']);
      if (role === 'owner') {
        await page.getByRole('button', { name: 'Learn to sail' }).click();
        await page.getByRole('dialog', { name: 'Roadmap' }).waitFor();
        await page.evaluate(() => window.patch({ sheet: null }));
        await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
        assert.equal(await focus(page), 'Learn to sail');
        await page.evaluate(() => window.patch({ role: 'reader', onSwitchView: null }));
        await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
        assert.equal(await focus(page), 'Learn to sail');
      } else {
        assert.equal(await page.getByRole('heading', { name: 'Learn to sail' }).count(), 1);
      }
    } finally { await page.close(); }
  });
}


test('Chromium: the existing TreeSwitcher truncates a long title while expanded Find and tablet verbs fit', async () => {
  const title = 'Coastal navigation handbook for every anchorage and harbor on the entire coastline';
  const page = await openRow(744, { band: 'tablet', view: 'tree', title, switcher: true, progress: { done: 3200, total: 5000 }, manyNext: true });
  try {
    const switcher = page.locator('.st-roadmap-switcher > div > button');
    assert.equal(await switcher.textContent(), title);
    await page.getByRole('button', { name: 'Find a step' }).click();
    const bounds = await page.locator('.st-roadmap-identity').evaluate((row) => ({
      fits: row.scrollWidth <= row.clientWidth,
      truncated: (() => {
        const text = row.querySelector('.st-roadmap-switcher button > span');
        return text.scrollWidth > text.clientWidth;
      })(),
      targets: [...row.querySelectorAll('.st-roadmap-icon, .st-board-new-step')].map((button) => [button.getBoundingClientRect().width, button.getBoundingClientRect().height]),
    }));
    assert.deepEqual(bounds, { fits: true, truncated: true, targets: [[44, 44], [44, 44]] });
  } finally { await page.close(); }
});
