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
const { NewStep } = await import('../../../../src/products/roadmap/board/BoardControls.jsx');
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

test('BoardView — only the tablet owner identity adds the existing compact creation verb', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
  ] });
  const markup = (props) => renderToStaticMarkup(React.createElement(BoardView, {
    tree, completed: new Set(), completedAt: {}, identity: true, title: tree.title,
    breakpoint: 'tablet', active: true, onSelect: () => {}, ...props,
  }));
  const action = renderToStaticMarkup(React.createElement(NewStep, { compact: true, onClick: () => {} }));
  const reader = markup({});
  assert.equal(markup({ onNewStep: () => {} }), reader.replace('</header>', `${action}</header>`));
  assert.equal(markup({ breakpoint: 'desktop', onNewStep: () => {} }), markup({ breakpoint: 'desktop' }));
  assert.equal(markup({ identity: false, onNewStep: () => {} }), markup({ identity: false }));
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView, { coverBeneath } from '/src/products/roadmap/board/BoardView.jsx';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { StepComposer } from '/src/products/roadmap/board/StepComposer.jsx';
import { boardOpen } from '/src/products/roadmap/board/gate.js';
import { useViewMode } from '/src/products/roadmap/ui/useViewMode.js';

const legend = [
  { id: 'build', hue: 'terracotta', label: 'Build' },
  { id: 'learn', hue: 'olive', label: 'Learn' },
  { id: 'milestone', hue: 'gold', label: 'Milestone' },
];

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
        React.createElement(BoardView, { tree, completed: new Set(completed), completedAt, selectedId, onSelect: setSelectedId, onAnchor: setSelectedId,
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
window.openActBoard = (nodes, initiallyCompleted, breakpoint, showToast) => {
  function Room() {
    const [tree, setTree] = useState(() => new SkillTree({ id: 'acts', title: 'Learn to sail', nodes }));
    const [completed, setCompleted] = useState(() => new Set(initiallyCompleted));
    const [completedAt, setCompletedAt] = useState(() => Object.fromEntries(initiallyCompleted.map((id, index) => [id, index + 1])));
    const [query, setQuery] = useState(() => new BoardQuery());
    const [reveal, setReveal] = useState(null);
    const [quiet, setQuiet] = useState(0);
    useEffect(() => { window.progressVersion = (window.progressVersion ?? 0) + 1; }, [completed, completedAt]);
    const toast = useMemo(() => showToast ? { key: 1, message: 'Rig the boat deleted', act: 'delete', action: { label: 'Undo' } } : null, []);
    window.shownToasts ??= [];
    window.completeRemote = (id) => {
      if (completed.has(id)) return false;
      setCompleted(new Set([...completed, id]));
      setCompletedAt({ ...completedAt, [id]: Date.now() });
      return true;
    };
    window.createAndReveal = () => flushSync(() => {
      setTree(new SkillTree({ id: tree.id, title: tree.title, nodes: [...tree.nodes,
        { id: 'reef', label: 'Reefing basics', color: 'sky', prerequisites: [] }] }));
      setReveal({ id: 'reef', key: 1 });
    });
    window.undoCompletion = (id) => flushSync(() => {
      setQuiet((current) => current + 1);
      setCompleted(new Set([...completed].filter((step) => step !== id)));
      setCompletedAt(Object.fromEntries(Object.entries(completedAt).filter(([step]) => step !== id)));
    });
    window.refreshProgress = () => flushSync(() => {
      setCompleted(new Set(completed));
      setCompletedAt({ ...completedAt });
    });
    return React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: '100vh' } },
      React.createElement(BoardView, { tree, completed, completedAt, breakpoint, active: true,
        onSelect: () => {}, onComplete: window.completeRemote, query, onQuery: setQuery, reveal, quiet,
        toast, onToastShown: (key) => window.shownToasts.push(key), onToastUndo: () => {} }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.openIdentityComposer = ({ nodes, owner = true, active = true, gate = true }) => {
  if (gate) localStorage.setItem('windmill:board:dev', '1');
  else localStorage.removeItem('windmill:board:dev');
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const completed = new Set(['course', 'parts', 'rig']);
  function Room() {
    const { breakpoint } = useViewMode();
    const [query, setQuery] = useState(() => new BoardQuery());
    const [composer, setComposer] = useState(false);
    useEffect(() => { window.identityRendered = true; }, []);
    if (!boardOpen()) return null;
    return React.createElement('div', { className: 'st-view-layer--board' + (active ? ' is-active' : ''), style: { height: '100vh' } },
      React.createElement(BoardView, { tree, completed, completedAt: {}, selectedId: null,
        breakpoint, active, identity: true, title: tree.title, query, onQuery: setQuery,
        onSelect: () => {}, onSwitchView: () => {}, legend,
        onNewStep: owner ? (door) => { window.creationDoor = door; setComposer(true); } : undefined }),
      composer && React.createElement(StepComposer, { tree, completed, legend, band: breakpoint,
        onCreate: () => ({ ok: true }), onClose: () => setComposer(false) }));
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

test('Chromium: a visible toast retains Undo and its announcement through a later regroup', async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const time = new Date('2026-11-01T10:00:00Z');
    await page.clock.install({ time: new Date(time.getTime() - 60_000) });
    await page.clock.pauseAt(time);
    await page.goto(`${origin}/board-view-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((nodes) => openActBoard(nodes, ['course', 'parts', 'rig'], 'desktop', true), learnToSailNodes);
    await page.locator('.st-board-card[data-step-id="wind"]').waitFor();
    await page.clock.runFor(120);
    await page.locator('.st-board-toast').waitFor();
    await page.evaluate(() => {
      window.announcements = [];
      const live = document.querySelector('[aria-live="polite"]');
      new MutationObserver(() => window.announcements.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
      completeRemote('wind');
    });
    await page.locator('.st-board-card.is-leaving').first().waitFor();
    assert.deepEqual(await page.locator('.st-board-toast').allTextContents(), ['Rig the boat deletedUndo']);
    await page.clock.runFor(900);
    await page.locator('[data-column="done"] .st-board-card[data-step-id="wind"]').waitFor();
    assert.deepEqual(await page.evaluate(() => ({ shown: window.shownToasts, announcements: window.announcements })), { shown: [1], announcements: [] });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium: phone C follows the completed card into Done without expanding its folded list', async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const time = new Date('2026-11-01T10:00:00Z');
    await page.clock.install({ time: new Date(time.getTime() - 60_000) });
    await page.clock.pauseAt(time);
    await page.goto(`${origin}/board-view-test`);
    await page.waitForFunction(() => window.entryReady);
    const done = Array.from({ length: 13 }, (_, index) => ({ id: `done${index}`, label: `Done ${index}`, prerequisites: [] }));
    const nodes = [{ id: 'wind', label: 'Read the wind', prerequisites: [] }, ...done];
    await page.evaluate(([nodes, completed]) => openActBoard(nodes, completed, 'phone', false), [nodes, done.map(({ id }) => id)]);
    await page.locator('.st-board-card[data-step-id="wind"]').focus();
    await page.keyboard.press('c');
    await page.locator('.st-board-card.is-leaving').first().waitFor({ state: 'attached' });
    await page.clock.runFor(900);
    await page.waitForFunction(() => document.activeElement?.dataset.stepId === 'wind' && document.activeElement.closest('[data-column]').dataset.column === 'done');
    assert.equal(await page.getByRole('button', { name: 'Show all 14', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [744, 900, 1023]) {
  test(`Chromium: tablet identity New step opens the composer through verbs at ${width}px`, async () => {
    await ready;
    const errors = [];
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/board-view-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate((nodes) => openIdentityComposer({ nodes }), learnToSailNodes);
      const identity = page.locator('.st-board-identity');
      const action = identity.getByRole('button', { name: 'New step', exact: true });
      await action.waitFor();
      assert.equal(await action.getAttribute('class'), 'st-board-new-step st-board-new-step--secondary st-board-new-step--compact');
      assert.deepEqual(await action.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const find = button.previousElementSibling.getBoundingClientRect();
        const header = button.parentElement.getBoundingClientRect();
        return { width: box.width, height: box.height, afterFind: box.left >= find.right, withinHeader: box.right <= header.right };
      }), { width: 44, height: 44, afterFind: true, withinHeader: true });
      await identity.getByRole('searchbox', { name: 'Find a step' }).fill('wind');
      assert.equal(await identity.getByRole('searchbox', { name: 'Find a step' }).inputValue(), 'wind');
      await action.click();
      const composer = page.getByRole('dialog', { name: 'New step', exact: true });
      await composer.waitFor();
      await composer.getByRole('textbox', { name: 'Name', exact: true }).fill('Reefing basics');
      assert.equal(await composer.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Reefing basics');
      assert.equal(await page.evaluate(() => window.creationDoor), 'verbs');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test('Chromium: the tablet identity creation verb stays out of other widths, readers, Graph and the closed gate', async () => {
  await ready;
  const errors = [];
  for (const state of [
    { width: 743 }, { width: 1024 }, { width: 900, owner: false },
    { width: 900, active: false }, { width: 900, gate: false },
  ]) {
    const page = await browser.newPage({ viewport: { width: state.width, height: 960 } });
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/board-view-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate(({ nodes, state }) => openIdentityComposer({ nodes, ...state }), { nodes: learnToSailNodes, state });
      await page.waitForFunction(() => window.identityRendered);
      assert.equal(await page.locator('.st-board-identity .st-board-new-step:visible').count(), 0);
      assert.equal(await page.getByRole('dialog', { name: 'New step', exact: true }).count(), 0);
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
});

for (const breakpoint of ['desktop', 'phone']) {
  for (const interaction of ['focus', 'pointer']) {
    test(`Chromium ${breakpoint}: create reveal keeps its wake until the reader's ${interaction}`, async () => {
      await ready;
      const page = await browser.newPage({ viewport: { width: breakpoint === 'phone' ? 390 : 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        const time = new Date('2026-11-02T12:00:00Z');
        await page.clock.install({ time: new Date(time.getTime() - 60_000) });
        await page.clock.pauseAt(time);
        await page.goto(`${origin}/board-view-test`);
        await page.waitForFunction(() => window.entryReady);
        await page.evaluate(({ nodes, breakpoint }) => openActBoard(nodes, ['course', 'parts', 'rig'], breakpoint, false), { nodes: learnToSailNodes, breakpoint });
        await page.locator('.st-board-card[data-step-id="wind"]').waitFor();
        await page.evaluate(() => createAndReveal());
        await page.clock.runFor(900);
        const created = page.locator('.st-board-card[data-step-id="reef"]');
        await created.waitFor();
        assert.deepEqual(await created.evaluate((card) => [card === document.activeElement, card.classList.contains('is-arrived')]), [true, true]);
        await page.clock.runFor(300);
        assert.equal(await created.evaluate((card) => card.classList.contains('is-arrived')), true);
        if (interaction === 'focus') {
          await page.locator('.st-board-card[data-step-id="wind"]').focus();
          await created.focus();
        } else {
          await created.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0 });
        }
        await page.waitForFunction(() => !document.querySelector('.st-board-card[data-step-id="reef"]').classList.contains('is-arrived'));
        assert.deepEqual(await created.evaluate((card) => [card === document.activeElement, card.classList.contains('is-arrived')]), [true, false]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  test(`Chromium ${breakpoint}: Undo stays dimmed for 280 ms across equivalent progress snapshots`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width: breakpoint === 'phone' ? 390 : 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const time = new Date('2026-11-02T12:00:00Z');
      await page.clock.install({ time: new Date(time.getTime() - 60_000) });
      await page.clock.pauseAt(time);
      await page.goto(`${origin}/board-view-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate(({ nodes, breakpoint }) => openActBoard(nodes, ['course', 'parts', 'rig', 'wind'], breakpoint, false), { nodes: learnToSailNodes, breakpoint });
      await page.locator('.st-board-card[data-step-id="dock"]').waitFor({ state: 'attached' });
      await page.evaluate(() => undoCompletion('wind'));
      const restored = () => page.locator('.st-board-card.is-restored').evaluateAll((cards) => cards.map((card) => card.dataset.stepId).sort());
      await page.locator('.st-board-card[data-step-id="wind"].is-restored').waitFor();
      assert.deepEqual(await restored(), ['dock', 'wind']);
      for (const elapsed of [30, 70, 100]) {
        await page.clock.runFor(elapsed);
        const version = await page.evaluate(() => {
          const previous = window.progressVersion;
          refreshProgress();
          return previous;
        });
        await page.waitForFunction((previous) => window.progressVersion > previous, version);
        assert.deepEqual(await restored(), ['dock', 'wind']);
      }
      await page.clock.runFor(79);
      assert.deepEqual(await restored(), ['dock', 'wind']);
      await page.clock.runFor(1);
      await page.waitForFunction(() => document.querySelectorAll('.st-board-card.is-restored').length === 0);
      assert.deepEqual(await restored(), []);
      assert.equal(await page.locator('.st-board-card.is-arrived').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
