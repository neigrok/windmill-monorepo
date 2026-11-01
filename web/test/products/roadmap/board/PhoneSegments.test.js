import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { PhoneSegments } = await import('../../../../src/products/roadmap/board/PhoneSegments.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { Board } = await import('../../../../src/products/roadmap/board/Board.js');

function learnToSailBoard() {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', description: 'Book a beginner course.' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', description: '' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', description: '' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', description: 'Tie a secure loop.' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', description: '' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', description: '' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', description: '' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', description: '' },
  ] });
  return new Board(tree, { completed: new Set(['course', 'parts', 'rig']), completedAt: { course: 100, parts: 200, rig: 300 } });
}

function markup(props) {
  return renderToStaticMarkup(React.createElement(PhoneSegments, {
    board: learnToSailBoard(), shown: 'upNext', onShow: () => {}, selectedId: null, onSelect: () => {}, doneExpanded: false, onExpandDone: () => {}, ...props,
  }));
}

function tab(name, title, count, spoken, selected) {
  return `<button id=":R0:tab-${name}" type="button" role="tab" class="st-board-phone-segment" aria-label="${spoken}" aria-selected="${selected}" aria-controls=":R0:panel-${name}" tabindex="${selected ? 0 : -1}">`
    + `<span class="st-board-phone-segment-surface"><span class="st-board-phone-segment-label">${title}</span><span class="st-board-phone-segment-count">${count}</span></span></button>`;
}

function card(column, kind, id, title, { reason = null, excerpt = null, selected = false, stop = false } = {}) {
  return `<button type="button" class="st-board-card st-board-card--${column}" style="--st-board-rail:var(--kind-${kind})" data-step-id="${id}" tabindex="${stop ? 0 : -1}"${selected ? ' aria-current="true"' : ''}>`
    + '<span class="st-board-card-rail" aria-hidden="true"></span><span class="st-board-card-content">'
    + `<span class="st-board-card-title">${title}</span>`
    + (reason ? `<span class="st-board-card-reason">${reason}</span>` : '')
    + (excerpt ? `<span class="st-board-card-excerpt">${excerpt}</span>` : '')
    + '</span></button>';
}

function pane(name, title, shown, cards) {
  return `<div id=":R0:panel-${name}" role="tabpanel" aria-labelledby=":R0:tab-${name}" class="st-board-phone-pane ${shown ? 'is-shown' : ''} " data-column="${name}">`
    + `<h2 class="st-board-phone-heading">${title}</h2><div class="st-board-cards">${cards.join('')}</div></div>`;
}

function learnToSailMarkup(shown, selectedId = null) {
  return [
    '<div class="st-board-phone"><div class="st-board-phone-panes">',
    pane('locked', 'Locked', shown === 'locked', [
      card('locked', 'terracotta', 'dock', 'Leave the dock', { reason: 'Needs Read the wind · 1 to go', stop: shown === 'locked' }),
      card('locked', 'olive', 'triangle', 'Sail a triangle', { reason: 'Needs Leave the dock · 2 to go' }),
      card('locked', 'gold', 'solo', 'Sail solo', { reason: 'Needs Sail a triangle +1 · 4 to go' }),
    ]),
    pane('upNext', 'Up next', shown === 'upNext', [
      card('upNext', 'sky', 'wind', 'Read the wind', { reason: 'Unlocks Leave the dock', stop: shown === 'upNext' }),
      card('upNext', 'olive', 'bowline', 'Tie a bowline', { excerpt: 'Tie a secure loop.' }),
    ]),
    pane('done', 'Done', shown === 'done', [
      card('done', 'terracotta', 'rig', 'Rig the boat', { stop: shown === 'done' }),
      card('done', 'sky', 'parts', 'Name the boat parts', { selected: selectedId === 'parts' }),
      card('done', 'terracotta', 'course', 'Choose a sailing course', { excerpt: 'Book a beginner course.' }),
    ]),
    '</div><div class="st-board-phone-band"><div class="st-board-phone-row"><div class="st-board-phone-segments" role="tablist" aria-label="Columns">',
    tab('locked', 'Locked', '3', 'Locked, 3 steps', shown === 'locked'),
    tab('upNext', 'Up next', '2', 'Up next, 2 steps', shown === 'upNext'),
    tab('done', 'Done', '3', 'Done, 3 steps', shown === 'done'),
    '</div><button type="button" class="st-board-tool" aria-label="Sort" aria-haspopup="dialog" aria-expanded="false">',
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M7 15.5V4.5M9.5 7L7 4.5L4.5 7M13 4.5V15.5M15.5 13L13 15.5L10.5 13"></path></svg></button></div>',
    '<div class="st-board-phone-tools"><div class="st-board-find st-board-find--phone ">',
    '<svg class="st-board-find-glyph" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">',
    '<path d="M12.975 8.1C12.975 10.7924 10.7924 12.975 8.1 12.975C5.40761 12.975 3.225 10.7924 3.225 8.1C3.225 5.40761 5.40761 3.225 8.1 3.225C10.7924 3.225 12.975 5.40761 12.975 8.1Z"></path>',
    '<path d="M12 12L15.375 15.375"></path></svg>',
    '<input class="st-board-find-input" type="search" placeholder="Find a step" aria-label="Find a step" aria-keyshortcuts="/" enterKeyHint="search" autoComplete="off" spellcheck="false" value=""/>',
    '</div></div></div></div>',
  ].join('');
}

test('PhoneSegments — Up next shows first; every column has a pane labelled by its tab, and every tab its count; the first card is the pane’s one tab stop', () => {
  assert.equal(markup(), learnToSailMarkup('upNext'));
});

test('PhoneSegments — the host’s shown column shows, newest completion first, the selected card marked', () => {
  assert.equal(markup({ shown: 'done', selectedId: 'parts' }), learnToSailMarkup('done', 'parts'));
});

test('PhoneSegments — an empty column’s pane takes focus, so its tab never points at nothing focusable', () => {
  const tree = new SkillTree({ id: 'one', title: 'One', nodes: [{ id: 'only', label: 'Only step', prerequisites: [] }] });
  const html = markup({ board: new Board(tree, { completed: new Set(['only']), completedAt: { only: 1 } }) });
  assert.deepEqual([...html.matchAll(/id=":R0:panel-(\w+)"[^>]*class="[^"]*"( tabindex="0")?/g)].map(([, name, focusable]) => `${name}${focusable ? ' focusable' : ''}`),
    ['locked focusable', 'upNext focusable', 'done']);
});

// A 5,000-step roadmap with 1,770 Locked, 30 Up next and 3,200 Done: thirty open roots, every locked step waiting on the first.
function coastalNodes() {
  return [
    ...Array.from({ length: 3200 }, (_, index) => ({ id: `d${index}`, label: `Done ${index}`, prerequisites: [] })),
    ...Array.from({ length: 30 }, (_, index) => ({ id: `u${index}`, label: `Up next ${index}`, prerequisites: [] })),
    ...Array.from({ length: 1770 }, (_, index) => ({ id: `l${index}`, label: `Locked ${index}`, prerequisites: ['u0'] })),
  ];
}

test('PhoneSegments — counts abbreviate from 1,000 on the tabs and stay whole in their spoken names', () => {
  const nodes = coastalNodes();
  const board = new Board(new SkillTree({ id: 'coast', title: 'Coastal navigation handbook', nodes }),
    { completed: new Set(nodes.slice(0, 3200).map((node) => node.id)), completedAt: {} });
  const html = markup({ board });
  assert.deepEqual([...html.matchAll(/role="tab" [^>]*aria-label="([^"]+)" aria-selected="(true|false)"[^>]*>.*?label">([^<]+)<.*?count">([^<]+)</g)]
    .map((match) => `${match[3]} ${match[4]} · ${match[1]} · ${match[2]}`), [
    'Locked 1.8k · Locked, 1,770 steps · false',
    'Up next 30 · Up next, 30 steps · true',
    'Done 3.2k · Done, 3,200 steps · false',
  ]);
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/board/board.css';
import { PhoneSegments } from '/src/products/roadmap/board/PhoneSegments.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { Board } from '/src/products/roadmap/board/Board.js';

window.openBoard = (nodes, completed) => {
  const board = new Board(new SkillTree({ id: 'coast', title: 'Coast', nodes }),
    { completed: new Set(completed), completedAt: Object.fromEntries(completed.map((id, index) => [id, index])) });
  window.expansions = 0;
  function Room() {
    const [selectedId, setSelectedId] = useState(null);
    const [shown, setShown] = useState('upNext');
    const [doneExpanded, setDoneExpanded] = useState(false);
    const [boardActive, setBoardActive] = useState(true);
    window.setBoardActive = setBoardActive;
    return React.createElement('div', { className: 'st-view-layer--board' + (boardActive ? ' is-active' : '') },
      React.createElement('div', { className: 'st-board st-board--phone', style: { height: '100vh' } },
        React.createElement(PhoneSegments, { board, shown, onShow: setShown, selectedId, onSelect: setSelectedId, doneExpanded,
          onExpandDone: () => { window.expansions += 1; setDoneExpanded(true); } })));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-phone-segments-test`,
    plugins: [{ name: 'phone-segments-test',
      enforce: 'pre',
      resolveId(id) {
        if (id === '/phone-segments-entry.js') return '\0phone-segments-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0phone-segments-beacon';
      },
      load(id) {
        if (id === '\0phone-segments-entry') return entry;
        if (id === '\0phone-segments-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/phone-segments-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Phone segments test</title><div id="root"></div><script type="module" src="/phone-segments-entry.js"></script>');
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

async function openBoardPage(viewport, errors, nodes, completed) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/phone-segments-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(([nodes, completed]) => openBoard(nodes, completed), [nodes, completed]);
  await page.getByRole('tablist').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function openCoast(viewport, errors) {
  const nodes = coastalNodes();
  return openBoardPage(viewport, errors, nodes, nodes.slice(0, 3200).map((node) => node.id));
}

const shown = (page) => page.evaluate(() => {
  const visible = [...document.querySelectorAll('.st-board-phone-pane')].filter((pane) => pane.checkVisibility({ visibilityProperty: true }));
  return {
    tab: document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'),
    panes: visible.map((pane) => `${pane.querySelector('.st-board-phone-heading').textContent} · ${pane.querySelectorAll('.st-board-card').length} cards · ${pane.scrollTop}`),
  };
});
const focusedName = (page) => page.evaluate(() => document.activeElement.querySelector('.st-board-card-title')?.textContent ?? document.activeElement.textContent);
const events = (page) => page.evaluate(() => window.events ?? []);
const scrollShown = (page, top) => page.locator('.st-board-phone-pane.is-shown').evaluate((pane, top) => { pane.scrollTop = top; }, top);

test('Chromium: tapping a tab shows its column, and each column keeps its own scroll across tabs and the Graph', async () => {
  await ready;
  const errors = [];
  const page = await openCoast({ width: 390, height: 844 }, errors);
  try {
    assert.deepEqual(await shown(page), { tab: 'Up next, 30 steps', panes: ['Up next · 21 cards · 0'] });
    await scrollShown(page, 600);

    await page.getByRole('tab', { name: 'Locked, 1,770 steps' }).click();
    assert.deepEqual(await shown(page), { tab: 'Locked, 1,770 steps', panes: ['Locked · 19 cards · 0'] });
    await scrollShown(page, 9000);

    await page.getByRole('tab', { name: 'Up next, 30 steps' }).click();
    assert.deepEqual(await shown(page), { tab: 'Up next, 30 steps', panes: ['Up next · 30 cards · 600'] });
    assert.equal(await page.locator('.st-board-phone-pane.is-shown').getAttribute('class'), 'st-board-phone-pane is-shown is-scrolled');

    await page.evaluate(() => setBoardActive(false));
    await page.waitForFunction(() => !document.querySelector('.st-board-phone-pane.is-shown').checkVisibility({ visibilityProperty: true }));
    assert.deepEqual(await shown(page), { tab: 'Up next, 30 steps', panes: [] });
    await page.evaluate(() => setBoardActive(true));
    assert.deepEqual(await shown(page), { tab: 'Up next, 30 steps', panes: ['Up next · 30 cards · 600'] });

    await page.getByRole('tab', { name: 'Locked, 1,770 steps' }).click();
    assert.deepEqual(await shown(page), { tab: 'Locked, 1,770 steps', panes: ['Locked · 31 cards · 9000'] });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: arrow keys, Home and End move between tabs, choosing and focusing as they go', async () => {
  await ready;
  const errors = [];
  const page = await openCoast({ width: 390, height: 844 }, errors);
  try {
    const focused = () => page.evaluate(() => `${document.activeElement.getAttribute('aria-label')} · ${document.activeElement.tabIndex}`);
    await page.getByRole('tab', { name: 'Up next, 30 steps' }).focus();
    const visits = [];
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'End', 'Home']) {
      await page.keyboard.press(key);
      visits.push(`${key} → ${await focused()} · ${(await shown(page)).panes}`);
    }
    assert.deepEqual(visits, [
      'ArrowRight → Done, 3,200 steps · 0 · Done · 12 cards · 0',
      'ArrowRight → Locked, 1,770 steps · 0 · Locked · 19 cards · 0',
      'ArrowLeft → Done, 3,200 steps · 0 · Done · 12 cards · 0',
      'End → Done, 3,200 steps · 0 · Done · 12 cards · 0',
      'Home → Locked, 1,770 steps · 0 · Locked · 19 cards · 0',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: Done shows its twelve newest and the drawn Show all row; End reaches it, Enter unfolds the rest into its place', async () => {
  await ready;
  const errors = [];
  const page = await openCoast({ width: 390, height: 844 }, errors);
  try {
    await page.getByRole('tab', { name: 'Done, 3,200 steps' }).click();
    assert.deepEqual(await shown(page), { tab: 'Done, 3,200 steps', panes: ['Done · 12 cards · 0'] });
    assert.equal(await page.locator('.st-board-phone-pane.is-shown .st-board-card-title').first().textContent(), 'Done 3199');
    assert.deepEqual(await page.locator('.st-board-show-all').evaluate((row) => {
      const style = getComputedStyle(row);
      const sunken = getComputedStyle(document.documentElement).getPropertyValue('--surface-sunken').trim();
      const probe = document.createElement('i');
      probe.style.color = sunken;
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { height: row.offsetHeight, fillsPane: row.offsetWidth === row.parentElement.clientWidth - 32, sunken: style.backgroundColor === expected, chevron: row.querySelector('svg').getAttribute('width') };
    }), { height: 48, fillsPane: true, sunken: true, chevron: '18' });

    await page.locator('.st-board-phone-pane.is-shown .st-board-card[tabindex="0"]').focus();
    await page.keyboard.press('End');
    assert.equal(await focusedName(page), 'Show all 3,200');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.expansions), 1);
    assert.equal(await focusedName(page), 'Done 3187');
    assert.equal(await page.getByRole('button', { name: 'Show all 3,200' }).count(), 0);

    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement.textContent === 'Done 0');
    const pane = await page.locator('.st-board-phone-pane.is-shown').evaluate((element) => {
      const view = element.getBoundingClientRect();
      const last = document.activeElement.getBoundingClientRect();
      return { lastInView: last.top >= view.top && last.bottom <= view.bottom, rendered: element.querySelectorAll('.st-board-card').length };
    });
    assert.equal(pane.lastInView, true);
    assert.ok(pane.rendered < 40, `${pane.rendered} cards rendered`);
    assert.deepEqual(await events(page), ['roadmap_board_column {"column":"done"}', 'roadmap_board_done_expand {"band":"phone"}']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: inside a pane the arrow keys move between its cards, and the pane keeps that card as its one tab stop', async () => {
  await ready;
  const errors = [];
  const page = await openCoast({ width: 390, height: 844 }, errors);
  try {
    await page.locator('.st-board-phone-pane.is-shown .st-board-card[tabindex="0"]').focus();
    const visits = [];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowUp', 'ArrowLeft']) {
      await page.keyboard.press(key);
      visits.push(`${key} → ${await focusedName(page)}`);
    }
    assert.deepEqual(visits, [
      'ArrowDown → Up next 1', 'ArrowDown → Up next 2', 'ArrowUp → Up next 1', 'End → Up next 29',
      'Home → Up next 0', 'ArrowUp → Up next 0', 'ArrowLeft → Up next 0',
    ]);
    await page.keyboard.press('End');
    await page.getByRole('tab', { name: 'Locked, 1,770 steps' }).click();
    await page.getByRole('tab', { name: 'Up next, 30 steps' }).click();
    assert.deepEqual(await page.locator('.st-board-phone-pane.is-shown .st-board-card[tabindex="0"] .st-board-card-title').allTextContents(), ['Up next 29']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// At 100% both phone widths hold one track, even with the large roadmap's longest counts.
for (const width of [390, 320]) {
  test(`Chromium: at ${width}px the tabs share one track`, async () => {
    await ready;
    const errors = [];
    const page = await openCoast({ width, height: 844 }, errors);
    try {
      assert.deepEqual(await tabLayout(page), { rows: [['Locked', 'Up next', 'Done']], whole: true, heading: 'block' });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

// A 200% page zoom halves the CSS viewport: a 390 phone reads as 195 and a 320 phone as 160.
for (const { width, rows } of [
  { width: 195, rows: [['Locked', 'Up next'], ['Done']] },
  { width: 160, rows: [['Locked'], ['Up next'], ['Done']] },
]) {
  test(`Chromium: at 200% text on a ${width * 2}px phone the tabs part into ${rows.length} rows and stay whole`, async () => {
    await ready;
    const errors = [];
    const page = await openBoardPage({ width, height: 844 }, errors, learnToSailBoard().columns.flatMap((column) => column.cards)
      .map((card) => ({ id: card.id, label: card.step.label, prerequisites: card.step.prerequisites })), ['course', 'parts', 'rig']);
    try {
      assert.deepEqual(await tabLayout(page), { rows, whole: true, heading: 'none' });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

function tabLayout(page) {
  return page.evaluate(() => {
    const band = document.querySelector('.st-board-phone-band').getBoundingClientRect();
    const rows = new Map();
    let whole = true;
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const box = tab.getBoundingClientRect();
      const surface = tab.firstElementChild;
      whole &&= box.left >= band.left - 0.5 && box.right <= band.right + 0.5 && surface.scrollWidth <= surface.clientWidth + 0.5;
      const top = Math.round(box.top);
      rows.set(top, [...(rows.get(top) ?? []), tab.querySelector('.st-board-phone-segment-label').textContent]);
    }
    return { rows: [...rows.values()], whole, heading: getComputedStyle(document.querySelector('.st-board-phone-pane.is-shown .st-board-phone-heading')).display };
  });
}
