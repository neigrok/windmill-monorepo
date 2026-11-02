import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { NewStep, PhoneTools } = await import('../../../../src/products/roadmap/board/BoardControls.jsx');
const { BoardQuery } = await import('../../../../src/products/roadmap/board/Board.js');

test('NewStep — primary, secondary and compact share one named creation button', () => {
  const button = (props) => renderToStaticMarkup(React.createElement(NewStep, props)).replace(/<svg[^>]*>.*?<\/svg>/g, '<svg/>');
  assert.deepEqual([button({ variant: 'primary' }), button({ variant: 'secondary' }), button({ compact: true })], [
    '<button type="button" class="st-board-new-step st-board-new-step--primary" aria-label="New step"><svg/><span>New step</span></button>',
    '<button type="button" class="st-board-new-step st-board-new-step--secondary" aria-label="New step"><svg/><span>New step</span></button>',
    '<button type="button" class="st-board-new-step st-board-new-step--secondary st-board-new-step--compact" aria-label="New step"><svg/></button>',
  ]);
});

test('PhoneTools — its New step door exists only with a callback', () => {
  const props = { worn: [], query: new BoardQuery(), onQuery: () => {} };
  const plain = renderToStaticMarkup(React.createElement(PhoneTools, props));
  const create = renderToStaticMarkup(React.createElement(NewStep, { compact: true }));
  assert.equal(renderToStaticMarkup(React.createElement(PhoneTools, { ...props, onNewStep: () => {} })), `${plain.slice(0, -6)}${create}</div>`);
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { coverBeneath } from '/src/products/roadmap/board/composerFocus.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { boardKey } from '/src/products/roadmap/shortcuts/shortcutMap.js';
import { KindChoice, PhoneTools } from '/src/products/roadmap/board/BoardControls.jsx';

const legend = [
  { id: 'build', hue: 'terracotta', label: 'Build' },
  { id: 'learn', hue: 'olive', label: 'Learn' },
  { id: 'milestone', hue: 'gold', label: 'Milestone' },
];

// The host's glue for the Board's own keys, as SkillTreeView wires them: / focuses Find a step, G switches.
window.addEventListener('keydown', (event) => {
  const field = document.activeElement;
  const typing = field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA' || field.isContentEditable);
  const action = boardKey(event, { typing });
  if (action === 'find') {
    event.preventDefault();
    document.querySelector('.st-board-find-input')?.focus();
  }
  if (action === 'switch') (window.switches ??= []).push('tree');
});

window.openBoard = (nodes, completed, breakpoint) => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const completedAt = Object.fromEntries(completed.map((id, index) => [id, index + 1]));
  function Room() {
    const [selectedId, setSelectedId] = useState(null);
    const [active, setActive] = useState(true);
    const [query, setQuery] = useState(() => new BoardQuery());
    window.setActive = setActive;
    window.selectElsewhere = setSelectedId;
    window.viewBranch = (id) => setQuery((current) => current.inBranch(id));
    window.setKinds = (kinds) => setQuery((current) => current.with({ kinds }));
    window.askedKinds = query.kinds;
    const edge = (label, side) => React.createElement('button', { type: 'button', style: { position: 'fixed', [side]: 0, left: 0 } }, label);
    return React.createElement(React.Fragment, null,
      edge('Before the Board', 'top'),
      React.createElement('div', { className: 'st-view-layer--board' + (active ? ' is-active' : ''), style: { height: '100vh' } },
        React.createElement(BoardView, { tree, completed: new Set(completed), completedAt, selectedId,
          onSelect: (id) => { (window.opened ??= []).push(id); setSelectedId(id); }, onAnchor: setSelectedId,
          breakpoint, active, onSwitchView: () => {}, query, onQuery: setQuery, legend, identity: true,
          title: 'Learn to sail' })),
      edge('After the Board', 'bottom'));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.openTools = (canCreate) => {
  function Tools() {
    const [query, setQuery] = useState(() => new BoardQuery());
    return React.createElement(PhoneTools, { worn: [], query, onQuery: setQuery,
      onNewStep: canCreate ? () => { window.created = (window.created ?? 0) + 1; } : undefined });
  }
  createRoot(document.getElementById('root')).render(React.createElement(Tools));
};
window.openKindChoice = () => {
  function Kinds() {
    const [value, setValue] = useState(null);
    return React.createElement(React.Fragment, null,
      React.createElement('button', { type: 'button' }, 'Before kinds'),
      React.createElement('div', { className: 'st-board-draft-kind' },
        React.createElement(KindChoice, { kinds: legend, value, label: 'Kind', follow: false,
          onChoose: (hue) => { (window.chosen ??= []).push(hue); setValue(hue); } })));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Kinds));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-board-controls-test`,
    plugins: [{ name: 'board-controls-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/board-controls-entry.js') return '\0board-controls-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0board-controls-beacon';
      },
      load(id) {
        if (id === '\0board-controls-entry') return entry;
        if (id === '\0board-controls-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/board-controls-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Board controls test</title><div id="root"></div><script type="module" src="/board-controls-entry.js"></script>');
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

const imported = Date.parse('2026-10-20T09:00:00Z');
const learnToSailNodes = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', createdMs: imported },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', createdMs: imported },
  { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', createdMs: imported },
  { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', createdMs: Date.parse('2026-10-22T10:00:00Z') },
  { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', createdMs: Date.parse('2026-10-21T10:00:00Z') },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', createdMs: imported },
  { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', createdMs: imported },
  { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', createdMs: imported },
];

async function openBoardPage(viewport, breakpoint, errors) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/board-controls-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(([nodes, breakpoint]) => openBoard(nodes, ['course', 'parts', 'rig'], breakpoint), [learnToSailNodes, breakpoint]);
  await page.locator('.st-board-card:visible').first().waitFor();
  return page;
}

const events = (page) => page.evaluate(() => window.events ?? []);
const focused = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element.querySelector('.st-board-card-title')?.textContent ?? element.textContent;
});

// Each column as one line: its name, then its cards' titles, or what an emptied column says and its way out.
const columnsOf = (page) => page.evaluate(() => [...document.querySelectorAll('[data-column]')].map((column) => {
  const cards = [...column.querySelectorAll('.st-board-card-title')].map((title) => title.textContent);
  const empty = column.querySelector('.st-board-column-empty, .st-board-pane-empty');
  const said = empty ? [`“${empty.querySelector('p').textContent}” · ${empty.querySelector('button').textContent}`] : [];
  return `${column.dataset.column}: ${[...cards, ...said].join(', ')}`;
}));
const stripOf = (page) => page.evaluate(() => [...document.querySelectorAll('.st-board-strip button')]
  .map((button) => `${button.getAttribute('aria-label') ?? button.textContent}${button.getAttribute('aria-pressed') === 'true' ? ' ✓' : ''}`));

test('Chromium: the strip offers All and one named swatch per kind worn; a kind filters every column, an emptied column clears it', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    assert.deepEqual(await stripOf(page), ['All ✓', 'Build', 'Learn', 'Milestone', 'Sky', 'Sort: Roadmap order']);
    await page.getByRole('button', { name: 'Sky' }).click();
    assert.deepEqual([await stripOf(page), await columnsOf(page)], [
      ['All', 'Build', 'Learn', 'Milestone', 'Sky ✓', 'Sort: Roadmap order'],
      ['locked: “No steps match” · Clear filters', 'upNext: Read the wind', 'done: Name the boat parts'],
    ]);
    await page.getByRole('button', { name: 'Milestone' }).click();
    assert.deepEqual(await columnsOf(page), ['locked: Sail solo', 'upNext: Read the wind', 'done: Name the boat parts']);

    await page.getByRole('button', { name: 'All' }).click();
    await page.getByRole('button', { name: 'Milestone' }).click();
    assert.deepEqual(await columnsOf(page), ['locked: Sail solo', 'upNext: “No steps match” · Clear filters', 'done: “No steps match” · Clear filters']);
    await page.locator('[data-column="upNext"]').getByRole('button', { name: 'Clear filters' }).click();
    assert.deepEqual([await columnsOf(page), await focused(page)], [[
      'locked: Leave the dock, Sail a triangle, Sail solo',
      'upNext: Read the wind, Tie a bowline',
      'done: Rig the boat, Name the boat parts, Choose a sailing course',
    ], 'Read the wind']);
    assert.deepEqual(await events(page), [
      'roadmap_board_filter {"count":1}',
      'roadmap_board_filter {"count":2}',
      'roadmap_board_filter {"count":0}',
      'roadmap_board_filter {"count":1}',
      'roadmap_board_clear {"what":"kinds","from":"empty"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: the sort menu orders Locked and Up next by Created, keeps Done newest completed, and Escape commits nothing', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.getByRole('button', { name: 'Roadmap order' }).click();
    const options = () => page.getByRole('menuitemradio').evaluateAll((items) => items.map((item) => `${item.textContent}${item.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`));
    assert.deepEqual([await options(), await focused(page)], [
      ['Roadmap orderClosest to start, then most unlocks ✓', 'Newest first', 'Oldest first'],
      'Roadmap orderClosest to start, then most unlocks',
    ]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.getByRole('menu').count(), await focused(page)], [0, 'Roadmap order']);

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual([await focused(page), await columnsOf(page)], ['Newest first', [
      'locked: Leave the dock, Sail a triangle, Sail solo',
      'upNext: Tie a bowline, Read the wind',
      'done: Rig the boat, Name the boat parts, Choose a sailing course',
    ]]);
    await page.getByRole('button', { name: 'Newest first' }).click();
    await page.getByRole('menuitemradio', { name: 'Newest first' }).click();
    await page.mouse.click(700, 600);
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.deepEqual(await events(page), [
      'roadmap_board_menu {"menu":"sort"}',
      'roadmap_board_menu {"menu":"sort"}',
      'roadmap_board_sort {"sort":"newest"}',
      'roadmap_board_menu {"menu":"sort"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: / focuses Find a step; a search narrows every column and emits once committed; Escape clears, then leaves', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.locator('.st-board-card').first().focus();
    await page.keyboard.press('/');
    await page.keyboard.type('wind g/');
    assert.deepEqual([await page.locator('.st-board-find-input').inputValue(), await page.evaluate(() => window.switches ?? [])], ['wind g/', []]);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    assert.deepEqual(await columnsOf(page), ['locked: “No steps match “wind”” · Clear search', 'upNext: Read the wind', 'done: “No steps match “wind”” · Clear search']);

    await page.keyboard.press('Escape');
    assert.deepEqual([await page.locator('.st-board-find-input').inputValue(), await page.evaluate(() => document.activeElement.className)], ['', 'st-board-find-input']);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.keyboard.press('g');
    assert.deepEqual(await page.evaluate(() => window.switches ?? []), ['tree']);

    await page.keyboard.press('/');
    await page.keyboard.type('astronomy');
    assert.deepEqual(await columnsOf(page), ['locked: ', 'upNext: “No steps match “astronomy”” · Clear search', 'done: ']);
    await page.getByRole('button', { name: 'Clear search' }).last().click();
    assert.equal(await focused(page), 'Leave the dock');
    assert.deepEqual(await events(page), [
      'roadmap_board_search undefined',
      'roadmap_board_clear {"what":"search","from":"field"}',
      'roadmap_board_search undefined',
      'roadmap_board_clear {"what":"search","from":"empty"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: a focused or selected card the query hides leaves focus whole; Tab comes back on the stop still standing', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(page), 'Tie a bowline');
    await page.getByRole('button', { name: 'Milestone' }).click();
    assert.deepEqual([await page.locator('.st-board-card[aria-current="true"]').count(), await page.locator('.st-board-card[tabindex="0"]').count()], [0, 1]);
    await page.getByRole('button', { name: 'Roadmap order' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Sail solo');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(page), 'Sail solo');

    await page.getByRole('button', { name: 'All' }).click();
    await page.getByRole('button', { name: 'After the Board' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.deepEqual([await focused(page), await page.locator('.st-board-card[aria-current="true"] .st-board-card-title').textContent()], ['Sail solo', 'Read the wind']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: View branch scopes the Board to the step, its ancestors and descendants; its title returns to the step, × clears only the scope', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.evaluate(() => viewBranch('wind'));
    await page.getByRole('button', { name: 'Sky' }).click();
    assert.deepEqual([await stripOf(page), await columnsOf(page)], [
      ['Branch · Read the wind', 'Clear branch', 'All', 'Build', 'Learn', 'Milestone', 'Sky ✓', 'Sort: Roadmap order'],
      ['locked: “No steps match” · Clear filters', 'upNext: Read the wind', 'done: Name the boat parts'],
    ]);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    assert.deepEqual(await columnsOf(page), [
      'locked: Leave the dock, Sail a triangle, Sail solo',
      'upNext: Read the wind',
      'done: Name the boat parts, Choose a sailing course',
    ]);
    await page.getByRole('button', { name: 'Branch · Read the wind' }).click();
    assert.deepEqual([await page.locator('.st-board-card[aria-current="true"] .st-board-card-title').textContent(), await page.evaluate(() => window.opened ?? [])],
      ['Read the wind', []]);
    await page.getByRole('button', { name: 'Clear branch' }).click();
    assert.deepEqual([await stripOf(page), (await columnsOf(page))[1], await focused(page)],
      [['All ✓', 'Build', 'Learn', 'Milestone', 'Sky', 'Sort: Roadmap order'], 'upNext: Read the wind, Tie a bowline', 'Read the wind']);
    assert.deepEqual(await events(page), [
      'roadmap_board_filter {"count":1}',
      'roadmap_board_clear {"what":"kinds","from":"empty"}',
      'roadmap_board_branch {"action":"anchor"}',
      'roadmap_board_branch {"action":"clear"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: on the phone Sort and Filter open sheets; what narrows shows as removable chips and dots, and an emptied pane clears it', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 390, height: 844 }, 'phone', errors);
  try {
    const chips = () => page.locator('.st-board-chip').evaluateAll((all) => all.map((chip) => chip.getAttribute('aria-label')));
    const dots = () => page.locator('.st-board-tool').evaluateAll((all) => all.map((tool) => `${tool.getAttribute('aria-label')}${tool.querySelector('.st-board-tool-dot') ? ' •' : ''}`));
    assert.deepEqual([await chips(), await dots()], [[], ['Sort', 'Filter by kind']]);

    await page.getByRole('button', { name: 'Sort' }).click();
    assert.equal(await page.getByRole('dialog', { name: 'Sort' }).count(), 1);
    await page.getByRole('menuitemradio', { name: 'Newest first' }).click();
    assert.deepEqual([await page.getByRole('dialog').count(), await focused(page), await chips(), await dots()],
      [0, '', ['Remove Created · newest'], ['Sort •', 'Filter by kind']]);
    assert.deepEqual((await columnsOf(page))[1], 'upNext: Tie a bowline, Read the wind');

    await page.getByRole('button', { name: 'Filter by kind' }).click();
    await page.getByRole('dialog', { name: 'Filter by kind' }).getByRole('button', { name: 'Milestone' }).click();
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.getByRole('dialog').count(), await chips(), await dots()],
      [0, ['Remove Milestone', 'Remove Created · newest'], ['Sort •', 'Filter by kind •']]);
    assert.deepEqual(await page.locator('.st-board-phone-pane.is-shown').evaluate((pane) => [pane.querySelector('.st-board-pane-empty').textContent,
      getComputedStyle(pane.querySelector('.st-board-phone-heading')).display]), ['No steps matchClear filters', 'none']);

    await page.getByRole('button', { name: 'Remove Created · newest' }).click();
    await page.locator('.st-board-phone-pane.is-shown').getByRole('button', { name: 'Clear filters' }).click();
    assert.deepEqual([await chips(), await dots()], [[], ['Sort', 'Filter by kind']]);
    assert.deepEqual(await events(page), [
      'roadmap_board_menu {"menu":"sort"}',
      'roadmap_board_sort {"sort":"newest"}',
      'roadmap_board_menu {"menu":"filter"}',
      'roadmap_board_filter {"count":1}',
      'roadmap_board_sort {"sort":"roadmap"}',
      'roadmap_board_clear {"what":"kinds","from":"empty"}',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: on the phone a branch scope opens on its step’s column, and its title returns there without opening the step', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 390, height: 844 }, 'phone', errors);
  try {
    const shownTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'));
    await page.evaluate(() => viewBranch('dock'));
    assert.equal(await shownTab(), 'Locked, 3 steps');
    await page.getByRole('tab', { name: /^Done/ }).click();
    await page.getByRole('button', { name: 'Branch · Leave the dock' }).click();
    assert.deepEqual([await shownTab(), await page.evaluate(() => window.opened ?? [])], ['Locked, 3 steps', []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: All also drops a kind no swatch offers, so it cannot come back on its own', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.evaluate(() => setKinds(['plum']));
    assert.deepEqual(await stripOf(page), ['All ✓', 'Build', 'Learn', 'Milestone', 'Sky', 'Sort: Roadmap order']);
    await page.getByRole('button', { name: 'All' }).click();
    assert.deepEqual([await page.evaluate(() => window.askedKinds), await events(page)], [[], []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: the phone creation door is a named 44px ghost button and dispatches once', async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${origin}/board-controls-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate(() => openTools(true));
    const button = page.getByRole('button', { name: 'New step', exact: true });
    await button.waitFor();
    assert.deepEqual(await button.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      border: getComputedStyle(element).borderWidth,
      background: getComputedStyle(element).backgroundColor,
      text: element.textContent,
    })), { width: 44, height: 44, border: '0px', background: 'rgba(0, 0, 0, 0)', text: '' });
    await button.click();
    assert.equal(await page.evaluate(() => window.created), 1);
  } finally {
    await page.close();
  }
});

test('Chromium: KindChoice with no shared value tabs into the first kind and chooses only on activation', async () => {
  await ready;
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/board-controls-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate(() => openKindChoice());
    const radios = page.getByRole('radio');
    const state = () => radios.evaluateAll((elements) => elements.map((element) => ({
      label: element.textContent,
      checked: element.getAttribute('aria-checked'),
      focused: element === document.activeElement,
    })));
    await page.getByRole('button', { name: 'Before kinds' }).focus();
    await page.keyboard.press('Tab');
    assert.deepEqual(await state(), [
      { label: 'Build', checked: 'false', focused: true },
      { label: 'Learn', checked: 'false', focused: false },
      { label: 'Milestone', checked: 'false', focused: false },
    ]);
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await state(), [
      { label: 'Build', checked: 'false', focused: false },
      { label: 'Learn', checked: 'false', focused: false },
      { label: 'Milestone', checked: 'false', focused: true },
    ]);
    assert.deepEqual(await page.evaluate(() => window.chosen ?? []), []);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-checked="true"]')?.textContent === 'Milestone');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[aria-checked="true"]')?.textContent === 'Build');
    await page.getByRole('radio', { name: 'Learn', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-checked="true"]')?.textContent === 'Learn');
    assert.deepEqual(await state(), [
      { label: 'Build', checked: 'false', focused: false },
      { label: 'Learn', checked: 'true', focused: true },
      { label: 'Milestone', checked: 'false', focused: false },
    ]);
    assert.deepEqual(await page.evaluate(() => window.chosen), ['gold', 'terracotta', 'olive']);
  } finally {
    await page.close();
  }
});
