import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { BoardColumns, columnStage, swapRail, railToReveal } = await import('../../../../src/products/roadmap/board/BoardColumns.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { Board } = await import('../../../../src/products/roadmap/board/Board.js');

function learnToSail({ extraDone = 0 } = {}) {
  const knots = Array.from({ length: extraDone }, (_, index) => ({
    id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: [], color: 'plum', description: '',
  }));
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', description: '' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', description: '' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', description: '' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', description: '' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', description: '' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', description: '' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', description: '' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', description: '' },
    ...knots,
  ] });
  const completed = new Set(['course', 'parts', 'rig', ...knots.map((knot) => knot.id)]);
  const completedAt = { course: 100, parts: 200, rig: 300, ...Object.fromEntries(knots.map((knot, index) => [knot.id, 400 + index])) };
  return new Board(tree, { completed, completedAt });
}

// One line per landmark the reader meets, in document order.
function outline(props) {
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { selectedId: null, onSelect: () => {}, doneExpanded: false, onExpandDone: () => {}, ...props }));
  const landmarks = /<section class="st-board-columns-(column|rail) st-board-columns-\w+--(\w+)"|<h2 [^>]*aria-label="([^"]+)"|st-board-card-title">([^<]+)|st-board-columns-deck-layer--behind-(\d)"><span class="st-board-columns-deck-card" style="--st-board-rail:var\(--kind-(\w+)\)">|st-board-columns-deck-title">([^<]+)|st-board-show-all">([^<]+)|st-board-spoken">([^<]+)<\/span><\/button>/g;
  return [...html.matchAll(landmarks)].map(([, shape, column, heading, card, behind, kind, front, showAll, show]) => {
    if (shape) return `${shape} ${column}`;
    if (heading) return `  heading ${heading}`;
    if (card) return `  card ${card}`;
    if (behind) return `  deck ${behind} behind · ${kind}`;
    if (front) return `    front ${front}`;
    if (showAll) return `  ${showAll}`;
    return `  button ${show}`;
  });
}

test('columnStage — from 1024px every column stands; below it Done folds to a rail and Up next never does', () => {
  assert.deepEqual(columnStage({ band: 'desktop', railed: 'locked' }), { locked: 'full', upNext: 'full', done: 'full' });
  assert.deepEqual(columnStage({ band: 'tablet' }), { locked: 'full', upNext: 'full', done: 'rail' });
  assert.deepEqual(columnStage({ band: 'tablet', railed: 'locked' }), { locked: 'rail', upNext: 'full', done: 'full' });
});

test('swapRail — Show on a rail stands that column and folds the other side column instead', () => {
  assert.equal(swapRail('done'), 'locked');
  assert.equal(swapRail('locked'), 'done');
});

test('railToReveal — a step in the rail stands its column; a step in a standing column leaves the rail where it is', () => {
  assert.equal(railToReveal('done', 'done'), 'locked');
  assert.equal(railToReveal('locked', 'locked'), 'done');
  assert.equal(railToReveal('done', 'locked'), 'done');
  assert.equal(railToReveal('done', 'upNext'), 'done');
});

test('BoardColumns — at 1024px and up Locked, Up next and Done stand in flow order, each heading naming its count', () => {
  assert.deepEqual(outline({ board: learnToSail(), band: 'desktop' }), [
    'column locked',
    '  heading Locked, 3 steps',
    '  card Leave the dock',
    '  card Sail a triangle',
    '  card Sail solo',
    'column upNext',
    '  heading Up next, 2 steps',
    '  card Read the wind',
    '  card Tie a bowline',
    'column done',
    '  heading Done, 3 steps',
    '  card Rig the boat',
    '  card Name the boat parts',
    '  card Choose a sailing course',
  ]);
});

test('BoardColumns — on a tablet Done is a rail: its count, the newest completion in front of the next two, and Show', () => {
  assert.deepEqual(outline({ board: learnToSail(), band: 'tablet' }), [
    'column locked',
    '  heading Locked, 3 steps',
    '  card Leave the dock',
    '  card Sail a triangle',
    '  card Sail solo',
    'column upNext',
    '  heading Up next, 2 steps',
    '  card Read the wind',
    '  card Tie a bowline',
    'rail done',
    '  heading Done, 3 steps',
    '  deck 2 behind · terracotta',
    '  deck 1 behind · sky',
    '  deck 0 behind · terracotta',
    '    front Rig the boat',
    '  button Show Done',
  ]);
});

test('BoardColumns — the Up next weighting: an accent dot and a filled count only on its heading, a tinted ground by class', () => {
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { board: learnToSail(), band: 'desktop', onSelect: () => {}, onExpandDone: () => {} }));
  const headings = [...html.matchAll(/<h2 class="([^"]+)" aria-label="[^"]+">(.*?)<\/h2>/g)].map(([, className, inner]) => `${className.trim()} · ${inner}`);
  assert.deepEqual(headings, [
    'st-board-columns-heading st-board-columns-heading--locked · <span class="st-board-columns-title">Locked</span><span class="st-board-columns-count">3</span>',
    'st-board-columns-heading st-board-columns-heading--upNext · <span class="st-board-columns-accent" aria-hidden="true"></span><span class="st-board-columns-title">Up next</span><span class="st-board-columns-count">2</span>',
    'st-board-columns-heading st-board-columns-heading--done · <span class="st-board-columns-title">Done</span><span class="st-board-columns-count">3</span>',
  ]);
});

test('BoardColumns — a Done column past twelve shows its twelve newest and a Show all row until expanded', () => {
  const board = learnToSail({ extraDone: 10 });
  const doneLines = (doneExpanded) => {
    const lines = outline({ board, band: 'desktop', doneExpanded });
    return lines.slice(lines.indexOf('column done'));
  };
  const newestTwelve = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `  card Knot ${n}`).concat(['  card Rig the boat', '  card Name the boat parts']);
  assert.deepEqual(doneLines(false), ['column done', '  heading Done, 13 steps', ...newestTwelve, '  Show all 13']);
  assert.deepEqual(doneLines(true), ['column done', '  heading Done, 13 steps', ...newestTwelve, '  card Choose a sailing course']);
});

test('BoardColumns — a rail over fewer than three cards stacks only what it has', () => {
  const board = learnToSail();
  board.done.cards = board.done.cards.slice(0, 1);
  const lines = outline({ board, band: 'tablet' });
  assert.deepEqual(lines.slice(lines.indexOf('rail done')), ['rail done', '  heading Done, 1 step', '  deck 0 behind · terracotta', '    front Rig the boat', '  button Show Done']);
});

test('BoardColumns — the rail heading counts compactly from 1,000 and keeps the whole number in its spoken name', () => {
  const board = learnToSail({ extraDone: 1200 });
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { board, band: 'tablet', onSelect: () => {}, onExpandDone: () => {} }));
  assert.deepEqual(/<section class="st-board-columns-rail[^"]*" aria-labelledby="[^"]+" data-column="done"><h2 [^>]*aria-label="([^"]+)">.*?columns-count">([^<]+)</.exec(html).slice(1), ['Done, 1,203 steps', '1.2k']);
});

test('BoardColumns — the columns are one tab stop: the first Up next card, with the rail’s Show and every other card out of the tab order', () => {
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { board: learnToSail(), band: 'tablet', onSelect: () => {}, onExpandDone: () => {} }));
  assert.deepEqual([...html.matchAll(/<button [^>]*?(?:data-step-id="(\w+)" )?tabindex="(-?\d)"[^>]*>/g)].map(([element, id, tabIndex]) => `${id ?? /class="([\w-]+)"/.exec(element)[1]} ${tabIndex}`), [
    'dock -1', 'triangle -1', 'solo -1', 'wind 0', 'bowline -1', 'st-board-columns-show -1',
  ]);
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/board/board.css';
import { BoardColumns, DEFAULT_RAIL, swapRail } from '/src/products/roadmap/board/BoardColumns.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { Board } from '/src/products/roadmap/board/Board.js';

window.openBoard = (nodes, initiallyCompleted, band) => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  function Room() {
    const [completed, setCompleted] = useState(initiallyCompleted);
    const [selectedId, setSelectedId] = useState(null);
    const [railed, setRailed] = useState(DEFAULT_RAIL);
    const [doneExpanded, setDoneExpanded] = useState(false);
    window.complete = (id) => setCompleted((current) => [...current, id]);
    window.selectElsewhere = setSelectedId;
    window.selected = selectedId;
    const board = useMemo(() => new Board(tree, { completed: new Set(completed),
      completedAt: Object.fromEntries(completed.map((id, index) => [id, index + 1])) }), [completed]);
    const edge = (label, side) => React.createElement('button', { type: 'button', style: { position: 'fixed', [side]: 0, left: 0, zIndex: 2 } }, label);
    return React.createElement(React.Fragment, null,
      edge('Before the Board', 'top'),
      React.createElement('div', { className: 'st-board st-board--columns', style: { height: '100vh' } },
        React.createElement(BoardColumns, { board, band, railed, onShowRail: () => setRailed(swapRail), selectedId, onSelect: setSelectedId,
          doneExpanded, onExpandDone: () => setDoneExpanded(true) })),
      edge('After the Board', 'bottom'));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-board-columns-test`,
    plugins: [{ name: 'board-columns-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/board-columns-entry.js') return '\0board-columns-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0board-columns-beacon';
      },
      load(id) {
        if (id === '\0board-columns-entry') return entry;
        if (id === '\0board-columns-beacon') {
          return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
            + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
        }
      },
      configureServer(server) {
        server.middlewares.use('/board-columns-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Board columns test</title><div id="root"></div><script type="module" src="/board-columns-entry.js"></script>');
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

// The 5,000-step fixture: 3,200 Done, 30 Up next, 1,770 Locked waiting on the first Up next step, each card with an excerpt.
function coastalNodes() {
  const described = (node) => ({ ...node, description: 'Work out departure, arrival and the fallback harbour for each gate before you commit to the route.' });
  return [
    ...Array.from({ length: 3200 }, (_, index) => described({ id: `d${index}`, label: `Done ${index}`, prerequisites: [] })),
    ...Array.from({ length: 30 }, (_, index) => described({ id: `u${index}`, label: `Up next ${index}`, prerequisites: [] })),
    ...Array.from({ length: 1770 }, (_, index) => described({ id: `l${index}`, label: `Locked ${index}`, prerequisites: ['u0'] })),
  ];
}

async function openBoardPage({ viewport, band, nodes = learnToSailNodes, completed = ['course', 'parts', 'rig'], reducedMotion = 'no-preference' }, errors) {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/board-columns-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(([nodes, completed, band]) => openBoard(nodes, completed, band), [nodes, completed, band]);
  await page.locator('.st-board-card').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const focused = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element.querySelector('.st-board-card-title')?.textContent ?? element.textContent;
});
const events = (page) => page.evaluate(() => window.events ?? []);

test('Chromium: the columns are one tab stop that Tab enters from either side on the first Up next card, then on the card last focused', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop' }, errors);
  try {
    await page.getByRole('button', { name: 'Before the Board' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Read the wind');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'After the Board');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'Read the wind');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Name the boat parts');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: on the desktop the arrow keys rove every card, Locked included, across columns at the nearest height; Enter selects', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop' }, errors);
  try {
    await page.locator('.st-board-card[tabindex="0"]').focus();
    const visits = [];
    for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowDown', 'End', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'End', 'ArrowUp']) {
      await page.keyboard.press(key);
      visits.push(`${key} → ${await focused(page)}`);
    }
    assert.deepEqual(visits, [
      'ArrowDown → Tie a bowline',
      'ArrowLeft → Sail a triangle',
      'ArrowDown → Sail solo',
      'End → Sail solo',
      'Home → Leave the dock',
      'ArrowLeft → Leave the dock',
      'ArrowRight → Read the wind',
      'ArrowRight → Rig the boat',
      'ArrowRight → Rig the boat',
      'End → Choose a sailing course',
      'ArrowUp → Name the boat parts',
    ]);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.selected), 'parts');
    assert.equal(await page.locator('.st-board-card[aria-current="true"]').getAttribute('tabindex'), '0');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: on a tablet the arrow keys cross into the rail’s Show and back out, and Show hands focus to the new rail', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ viewport: { width: 900, height: 960 }, band: 'tablet' }, errors);
  try {
    await page.locator('.st-board-card[tabindex="0"]').focus();
    const visits = [];
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'Enter', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
      await page.keyboard.press(key);
      visits.push(`${key} → ${await focused(page)}`);
    }
    assert.deepEqual(visits, [
      'ArrowRight → ShowShow Done',
      'ArrowDown → ShowShow Done',
      'ArrowLeft → Tie a bowline',
      'Enter → Tie a bowline',
      'ArrowRight → ShowShow Done',
      'ArrowRight → ShowShow Done',
      'ArrowLeft → Tie a bowline',
      'ArrowLeft → Sail a triangle',
    ]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    assert.equal(await focused(page), 'ShowShow Locked');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(page), 'Name the boat parts');
    assert.deepEqual(await page.locator('[tabindex="0"]').evaluateAll((elements) => elements.map((element) => element.textContent)), ['Name the boat parts']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: a step that just became up next wakes and settles; the Board’s first paint wakes nothing', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop' }, errors);
  try {
    assert.equal(await page.locator('.st-board-card.is-arrived').count(), 0);
    await page.evaluate(() => complete('wind'));
    await page.locator('.st-board-columns-column--upNext .st-board-card.is-arrived').waitFor();
    assert.deepEqual(await page.locator('.st-board-card.is-arrived').evaluateAll((cards) => cards.map((card) => [
      card.querySelector('.st-board-card-title').textContent, getComputedStyle(card).animationName,
    ])), [['Leave the dock', 'st-board-card-wake, st-board-card-settle']]);
    await page.locator('.st-board-card.is-arrived').focus();
    assert.equal(await page.locator('.st-board-card.is-arrived').evaluate((card) => getComputedStyle(card).animationName), 'none');
    await page.waitForFunction(() => document.querySelectorAll('.st-board-card.is-arrived').length === 0, null, { timeout: 4000 });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: with reduced motion an arriving step only fades in', async () => {
  await ready;
  const errors = [];
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop', reducedMotion: 'reduce' }, errors);
  try {
    await page.evaluate(() => complete('wind'));
    await page.locator('.st-board-card.is-arrived').waitFor();
    assert.equal(await page.locator('.st-board-card.is-arrived').evaluate((card) => getComputedStyle(card).animationName), 'st-board-card-fade');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: 5,000 steps render a window per column; End and Home rove past unrendered cards, and a selected card always renders', async () => {
  await ready;
  const errors = [];
  const nodes = coastalNodes();
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop', nodes, completed: nodes.slice(0, 3200).map((node) => node.id) }, errors);
  try {
    const rendered = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-column]')]
      .map((column) => [column.dataset.column, column.querySelectorAll('.st-board-card').length])));
    assert.deepEqual(await rendered(), { locked: 17, upNext: 18, done: 12 });

    await page.getByRole('button', { name: 'Show all 3,200' }).click();
    assert.equal(await focused(page), 'Done 3187');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement.textContent.startsWith('Done 0'));
    const done = await page.locator('.st-board-columns-column--done').evaluate((column) => {
      const view = column.getBoundingClientRect();
      const card = document.activeElement.getBoundingClientRect();
      return { inView: card.top >= view.top && card.bottom <= view.bottom, rendered: column.querySelectorAll('.st-board-card').length };
    });
    assert.equal(done.inView, true);
    assert.ok(done.rendered <= 40, `${done.rendered} Done cards rendered`);
    await page.keyboard.press('Home');
    assert.equal(await focused(page), 'Done 3199');

    await page.evaluate(() => selectElsewhere('l1500'));
    assert.equal(await page.locator('.st-board-card[aria-current="true"] .st-board-card-title').textContent(), 'Locked 1500');
    assert.deepEqual(await events(page), ['roadmap_board_done_expand {"band":"desktop"}']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: scrolling a 1,770-card column end to end keeps the window small and the heading sticky', async (t) => {
  await ready;
  const errors = [];
  const nodes = coastalNodes();
  const page = await openBoardPage({ viewport: { width: 1440, height: 900 }, band: 'desktop', nodes, completed: nodes.slice(0, 3200).map((node) => node.id) }, errors);
  try {
    const run = await page.locator('.st-board-columns-column--locked').evaluate(async (column) => {
      const longTasks = [];
      new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask' });
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      let most = 0;
      const started = performance.now();
      for (let top = 0; top < column.scrollHeight; top += 1000) {
        column.scrollTop = top;
        await frame();
        await frame();
        most = Math.max(most, column.querySelectorAll('.st-board-card').length);
      }
      const heading = column.querySelector('.st-board-columns-heading').getBoundingClientRect().top - column.getBoundingClientRect().top;
      const last = column.querySelector('.st-board-card:last-of-type .st-board-card-title')?.textContent;
      return { most, heading, last, frames: Math.ceil(column.scrollHeight / 1000), ms: Math.round(performance.now() - started), longTasks };
    });
    t.diagnostic(`1,770-card Locked: ${run.frames} scroll steps in ${run.ms} ms, at most ${run.most} cards rendered, ${run.longTasks.length} long tasks (${run.longTasks.map(Math.round).join(', ') || 'none'} ms)`);
    assert.ok(run.most <= 45, `${run.most} cards rendered at once`);
    assert.deepEqual([run.heading, run.last], [0, 'Locked 1769']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
