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
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';

window.openBoard = (nodes, completed, breakpoint) => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const completedAt = Object.fromEntries(completed.map((id, index) => [id, index + 1]));
  function Room() {
    const [selectedId, setSelectedId] = useState(null);
    const [active, setActive] = useState(true);
    window.setActive = setActive;
    window.selectElsewhere = setSelectedId;
    const edge = (label, side) => React.createElement('button', { type: 'button', style: { position: 'fixed', [side]: 0, left: 0 } }, label);
    return React.createElement(React.Fragment, null,
      edge('Before the Board', 'top'),
      React.createElement('div', { className: 'st-view-layer--board' + (active ? ' is-active' : ''), style: { height: '100vh' } },
        React.createElement(BoardView, { tree, completed: new Set(completed), completedAt, selectedId, onSelect: setSelectedId,
          breakpoint, active, onSwitchView: () => {} })),
      edge('After the Board', 'bottom'));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
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

const learnToSailNodes = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky' },
  { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta' },
  { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive' },
  { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky' },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta' },
  { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive' },
  { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold' },
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

test('Chromium: tabbing forward into the columns lands on the first Up next card; tabbing back in stays on the last card', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ width: 1440, height: 900 }, 'desktop', errors);
  try {
    await page.getByRole('button', { name: 'Before the Board' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Read the wind');
    await page.getByRole('button', { name: 'After the Board' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'Choose a sailing course');
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
