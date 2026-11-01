import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: BoardView } = await import('../../../../src/products/roadmap/board/BoardView.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');

function render(props, { knots = 0 } = {}) {
  const extra = Array.from({ length: knots }, (_, index) => ({ id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: [], color: 'plum' }));
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky' },
    ...extra,
  ] });
  const html = renderToStaticMarkup(React.createElement(BoardView, {
    tree,
    completed: new Set(['course', ...extra.map((knot) => knot.id)]),
    completedAt: { course: 100, ...Object.fromEntries(extra.map((knot, index) => [knot.id, 200 + index])) },
    selectedId: null,
    onSelect: () => {},
    onSwitchView: () => {},
    ...props,
  }));
  return {
    wrapper: /^<div [^>]+>/.exec(html)[0],
    columns: html.includes('class="st-board-columns"'),
    rails: [...html.matchAll(/st-board-columns-rail--(\w+)/g)].map(([, column]) => column),
    showAll: [...html.matchAll(/st-board-show-all">([^<]+)/g)].map(([, label]) => label),
    selected: [...html.matchAll(/aria-current="true">.*?st-board-card-title">([^<]+)/g)].map(([, label]) => label),
  };
}

test('BoardView — below 744px the phone segments take the columns, lifted clear of a Fork pill', () => {
  assert.deepEqual(render({ breakpoint: 'phone', bottomInset: 68 }), {
    wrapper: '<div class="st-board st-board--phone" style="padding-bottom:68px">',
    columns: false,
    rails: [],
    showAll: [],
    selected: [],
  });
});

test('BoardView — a tablet stands two columns and folds Done to a rail', () => {
  assert.deepEqual(render({ breakpoint: 'tablet' }), {
    wrapper: '<div class="st-board st-board--columns" style="padding-bottom:0">',
    columns: true,
    rails: ['done'],
    showAll: [],
    selected: [],
  });
});

test('BoardView — under the desktop topbar the columns start a gap below where the bar ends', () => {
  assert.deepEqual(render({ breakpoint: 'desktop', topInset: 90 }), {
    wrapper: '<div class="st-board st-board--columns" style="padding-top:calc(90px + var(--space-3));padding-bottom:0">',
    columns: true,
    rails: [],
    showAll: [],
    selected: [],
  });
});

test('BoardView — shown on a tablet with a Done step selected, Done stands and Locked folds to the rail', () => {
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'course', active: true }).rails, ['locked']);
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'course', active: false }).rails, ['done']);
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'parts', active: true }).rails, ['done']);
});

test('BoardView — shown with a step selected past the Done fold, Done unfolds so its card is there to reveal', () => {
  const folded = render({ breakpoint: 'desktop', selectedId: 'course', active: false }, { knots: 12 });
  assert.deepEqual([folded.showAll, folded.selected], [['Show all 13'], []]);
  const revealed = render({ breakpoint: 'desktop', selectedId: 'course', active: true }, { knots: 12 });
  assert.deepEqual([revealed.showAll, revealed.selected], [[], ['Choose a sailing course']]);
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView, { coverBeneath } from '/src/products/roadmap/board/BoardView.jsx';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { boardKey } from '/src/products/roadmap/shortcuts/shortcutMap.js';

const legend = [
  { id: 'build', hue: 'terracotta', label: 'Build' },
  { id: 'learn', hue: 'olive', label: 'Learn' },
  { id: 'milestone', hue: 'gold', label: 'Milestone' },
];

// The host's glue for the Board's own keys, as SkillTreeView wires them: / focuses Find a step, G switches.
window.addEventListener('keydown', (event) => {
  const field = document.activeElement;
  const typing = field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA' || field.isContentEditable);
  const action = boardKey(event, typing);
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
    const edge = (label, side) => React.createElement('button', { type: 'button', style: { position: 'fixed', [side]: 0, left: 0 } }, label);
    return React.createElement(React.Fragment, null,
      edge('Before the Board', 'top'),
      React.createElement('div', { className: 'st-view-layer--board' + (active ? ' is-active' : ''), style: { height: '100vh' } },
        React.createElement(BoardView, { tree, completed: new Set(completed), completedAt, selectedId, onSelect: setSelectedId,
          breakpoint, active, onSwitchView: () => {}, query, onQuery: setQuery, legend, identity: true,
          title: 'Learn to sail' })),
      edge('After the Board', 'bottom'));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.openState = ({ nodes, completed = [], breakpoint, loading = false, failed = false, owner = true }) => {
  const tree = nodes === null ? null : new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const call = (name) => () => (window.calls ??= []).push(name);
  createRoot(document.getElementById('root')).render(
    React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: '100vh' } },
      React.createElement(BoardView, { tree, completed: new Set(completed), completedAt: {}, loading, failed, selectedId: null,
        onSelect: () => {}, breakpoint, active: true, identity: true, title: 'Learn to sail', onSwitchView: () => {},
        onRetry: call('retry'), onShare: owner ? call('share') : undefined, onNewStep: owner ? call('newStep') : undefined })));
};
window.openReload = (nodes, completed) => {
  function Room() {
    const [load, setLoad] = useState({ tree: null, loading: false, failed: true });
    window.finishLoad = (succeeded) => setLoad({ tree: succeeded ? new SkillTree({ id: 'sail', title: 'Learn to sail', nodes }) : null, loading: false, failed: !succeeded });
    return React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: '100vh' } },
      React.createElement(BoardView, { ...load, completed: new Set(completed), completedAt: {}, selectedId: null, onSelect: () => {},
        breakpoint: 'desktop', active: true, onSwitchView: () => {}, onRetry: () => setLoad({ tree: null, loading: true, failed: false }) }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.coverBeneath = coverBeneath;
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-board-view-test`,
    plugins: [{ name: 'board-view-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/board-view-entry.js') return '\0board-view-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0board-view-beacon';
      },
      load(id) {
        if (id === '\0board-view-entry') return entry;
        if (id === '\0board-view-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/board-view-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Board view test</title><div id="root"></div><script type="module" src="/board-view-entry.js"></script>');
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
  await page.goto(`${origin}/board-view-test`);
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

test('Chromium: Show on the tablet rail stands its column, hands focus to the new rail’s Show and emits once per press', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 900, height: 960 }, 'tablet', errors);
  try {
    await page.getByRole('button', { name: 'Show Done' }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual([await focused(page), await page.locator('.st-board-columns-rail').getAttribute('class')],
      ['ShowShow Locked', 'st-board-columns-rail st-board-columns-rail--locked']);
    await page.keyboard.press('Enter');
    assert.equal(await focused(page), 'ShowShow Done');
    assert.deepEqual(await events(page), ['roadmap_board_rail {"column":"done"}', 'roadmap_board_rail {"column":"locked"}']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: a step selected in the rail column stands it when the Board is shown, and that swap emits nothing', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 900, height: 960 }, 'tablet', errors);
  try {
    await page.evaluate(() => { setActive(false); selectElsewhere('parts'); });
    await page.waitForFunction(() => !document.querySelector('.st-view-layer--board.is-active'));
    await page.evaluate(() => setActive(true));
    await page.locator('.st-board-card[aria-current="true"]').waitFor();
    assert.deepEqual([await page.locator('.st-board-columns-rail').getAttribute('class'), await events(page)],
      ['st-board-columns-rail st-board-columns-rail--locked', []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: tabbing into the columns from either side — past the strip, or back from below — lands on the first Up next card', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.getByRole('button', { name: 'Roadmap order' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Read the wind');
    await page.getByRole('button', { name: 'After the Board' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'Read the wind');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: a phone tab emits on a tap and an arrow, never on the opening column, a re-pick or a follow', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 390, height: 844 }, 'phone', errors);
  try {
    const shownTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'));
    assert.deepEqual([await shownTab(), await events(page)], ['Up next, 2 steps', []]);

    await page.locator('.st-board-phone-pane.is-shown .st-board-card').last().click();
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    assert.deepEqual(await events(page), [
      'roadmap_board_column {"column":"locked"}',
      'roadmap_board_column {"column":"upNext"}',
      'roadmap_board_column {"column":"locked"}',
    ]);

    await page.evaluate(() => setActive(false));
    await page.waitForFunction(() => !document.querySelector('.st-view-layer--board.is-active'));
    await page.evaluate(() => setActive(true));
    assert.deepEqual([
      await shownTab(),
      await page.locator('.st-board-phone-pane.is-shown .st-board-card[aria-current="true"] .st-board-card-title').textContent(),
      (await events(page)).length,
    ], ['Up next, 2 steps', 'Tie a bowline', 3]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

async function openStatePage(viewport, state, errors, { reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/board-view-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((options) => openState(options), state);
  await page.locator('.st-board').waitFor();
  return page;
}

test('Chromium: Try again on a load error reloads and emits once, with only the state and the action', async () => {
  await ready;
  const errors = [];
  const page = await openStatePage({ width: 1440, height: 900 }, { nodes: null, failed: true, breakpoint: 'desktop' }, errors);
  try {
    await page.getByRole('button', { name: 'Try again' }).click();
    assert.deepEqual([await page.evaluate(() => window.calls), await events(page)],
      [['retry'], ['roadmap_board_state_action {"state":"error","action":"retry"}']]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: after Try again focus rests on the skeleton, then lands on the columns’ tab stop, or on Try again if the load fails again', async () => {
  await ready;
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/board-view-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate(([nodes]) => openReload(nodes, ['course', 'parts', 'rig']), [learnToSailNodes]);
    const where = () => page.evaluate(() => (document.activeElement.getAttribute('aria-busy') === 'true' ? 'skeleton' : document.activeElement.querySelector('.st-board-card-title')?.textContent ?? document.activeElement.textContent));
    await page.getByRole('button', { name: 'Try again' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await where(), 'skeleton');
    await page.evaluate(() => finishLoad(false));
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(await where(), 'Try again');
    await page.keyboard.press('Enter');
    await page.evaluate(() => finishLoad(true));
    await page.locator('.st-board-card').first().waitFor();
    assert.equal(await where(), 'Read the wind');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: while hidden the Board skips the host’s renders, and catches up the moment it is shown', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.evaluate(() => setActive(false));
    await page.evaluate(() => selectElsewhere('wind'));
    assert.equal(await page.locator('.st-board-card[aria-current="true"]').count(), 0);
    await page.evaluate(() => setActive(true));
    assert.equal(await page.locator('.st-board-card[aria-current="true"] .st-board-card-title').textContent(), 'Read the wind');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: an empty roadmap’s New step plants and emits; Roadmap complete’s Share it and New step each emit', async () => {
  await ready;
  const errors = [];
  const empty = await openStatePage({ width: 1440, height: 900 }, { nodes: [], breakpoint: 'desktop' }, errors);
  const complete = await openStatePage({ width: 1440, height: 900 }, { nodes: learnToSailNodes, completed: learnToSailNodes.map((node) => node.id), breakpoint: 'desktop' }, errors);
  try {
    await empty.getByRole('button', { name: 'New step' }).click();
    assert.deepEqual([await empty.evaluate(() => window.calls), await events(empty)],
      [['newStep'], ['roadmap_board_state_action {"state":"empty","action":"newStep"}']]);
    await complete.getByRole('button', { name: 'Share it' }).click();
    await complete.getByRole('button', { name: 'New step' }).click();
    assert.deepEqual([await complete.evaluate(() => window.calls), await events(complete)], [['share', 'newStep'], [
      'roadmap_board_state_action {"state":"complete","action":"share"}',
      'roadmap_board_state_action {"state":"complete","action":"newStep"}',
    ]]);
    assert.deepEqual(errors, []);
  } finally {
    await empty.close();
    await complete.close();
  }
});

test('Chromium: on the phone Roadmap complete takes the Up next pane without its title and centres there', async () => {
  await ready;
  const errors = [];
  const page = await openStatePage({ width: 390, height: 844 }, { nodes: learnToSailNodes, completed: learnToSailNodes.map((node) => node.id), breakpoint: 'phone' }, errors);
  try {
    const layout = await page.evaluate(() => {
      const pane = document.querySelector('.st-board-phone-pane.is-shown');
      const message = pane.querySelector('.st-board-complete').getBoundingClientRect();
      const box = pane.getBoundingClientRect();
      return {
        heading: getComputedStyle(pane.querySelector('.st-board-phone-heading')).display,
        centred: Math.abs((message.top + message.bottom) / 2 - (box.top + box.bottom) / 2) < 12,
      };
    });
    assert.deepEqual(layout, { heading: 'none', centred: true });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: from 744px the skeleton breathes, and holds still under reduced motion', async () => {
  await ready;
  const errors = [];
  const moving = await openStatePage({ width: 1440, height: 900 }, { nodes: null, loading: true, breakpoint: 'desktop' }, errors);
  const still = await openStatePage({ width: 1440, height: 900 }, { nodes: null, loading: true, breakpoint: 'desktop' }, errors, { reducedMotion: 'reduce' });
  try {
    const animation = (page) => page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.st-board-skeleton-card'));
      return `${style.animationName} ${style.animationDuration}`;
    });
    assert.deepEqual([await animation(moving), await animation(still), await moving.locator('.st-board-skeleton-card').count()],
      ['st-board-skeleton-breathe 1.2s', 'none 0s', 8]);
    assert.deepEqual(errors, []);
  } finally {
    await moving.close();
    await still.close();
  }
});

test('Chromium: while the Board is shown, what it covers leaves the tab order — later arrivals too — and comes back after', async () => {
  await ready;
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/board-view-test`);
    await page.waitForFunction(() => window.entryReady);
    const tabbed = () => page.evaluate(() => {
      const root = document.getElementById('stage');
      const reached = [];
      for (const button of root.querySelectorAll('button')) {
        button.focus();
        if (document.activeElement === button) reached.push(button.textContent);
      }
      return reached;
    });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `<div id="stage" style="position: relative; height: 400px">
        <button style="position: absolute; z-index: 16">Recolour</button>
        <div style="position: absolute"><button>Graph overlay</button></div>
        <div class="layer" style="position: absolute; inset: 0; z-index: 18"><button>Card</button></div>
        <header style="position: absolute; z-index: 20"><button>Topbar</button></header>
      </div>`);
      window.uncover = coverBeneath(document.querySelector('#stage .layer'));
    });
    const covered = await tabbed();
    await page.evaluate(() => document.getElementById('stage').insertAdjacentHTML('beforeend', '<span style="position: absolute; z-index: 11"><button>Edge ×</button></span>'));
    await page.waitForFunction(() => document.querySelector('#stage span').inert);
    const arrived = await tabbed();
    await page.evaluate(() => window.uncover());
    assert.deepEqual([covered, arrived, await tabbed()], [
      ['Card', 'Topbar'],
      ['Card', 'Topbar'],
      ['Recolour', 'Graph overlay', 'Card', 'Topbar', 'Edge ×'],
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
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
    assert.deepEqual(await stripOf(page), ['All ✓', 'Build', 'Learn', 'Milestone', 'Sky', 'Roadmap order']);
    await page.getByRole('button', { name: 'Sky' }).click();
    assert.deepEqual([await stripOf(page), await columnsOf(page)], [
      ['All', 'Build', 'Learn', 'Milestone', 'Sky ✓', 'Roadmap order'],
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
      ['Branch · Read the wind', 'Clear branch', 'All', 'Build', 'Learn', 'Milestone', 'Sky ✓', 'Roadmap order'],
      ['locked: “No steps match” · Clear filters', 'upNext: Read the wind', 'done: Name the boat parts'],
    ]);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    assert.deepEqual(await columnsOf(page), [
      'locked: Leave the dock, Sail a triangle, Sail solo',
      'upNext: Read the wind',
      'done: Name the boat parts, Choose a sailing course',
    ]);
    await page.getByRole('button', { name: 'Branch · Read the wind' }).click();
    assert.equal(await page.locator('.st-board-card[aria-current="true"] .st-board-card-title').textContent(), 'Read the wind');
    await page.getByRole('button', { name: 'Clear branch' }).click();
    assert.deepEqual([await stripOf(page), (await columnsOf(page))[1], await focused(page)],
      [['All ✓', 'Build', 'Learn', 'Milestone', 'Sky', 'Roadmap order'], 'upNext: Read the wind, Tie a bowline', 'Read the wind']);
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
