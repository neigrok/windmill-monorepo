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

test('BoardView — below 744px the phone segments take the columns', () => {
  assert.deepEqual(render({ breakpoint: 'phone' }), {
    wrapper: '<div class="st-board st-board--phone">',
    columns: false,
    rails: [],
    showAll: [],
    selected: [],
  });
});

test('BoardView — a tablet stands two columns and folds Done to a rail', () => {
  assert.deepEqual(render({ breakpoint: 'tablet' }), {
    wrapper: '<div class="st-board st-board--columns">',
    columns: true,
    rails: ['done'],
    showAll: [],
    selected: [],
  });
});

test('BoardView — under the desktop topbar the columns start a gap below where the bar ends', () => {
  assert.deepEqual(render({ breakpoint: 'desktop', topInset: 90 }), {
    wrapper: '<div class="st-board st-board--columns" style="padding-top:calc(90px + var(--space-3))">',
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
import React, { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { coverBeneath } from '/src/products/roadmap/step/composerFocus.js';
import { boardFocusTarget } from '/src/products/roadmap/board/traversal.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { StepCard } from '/src/products/roadmap/board/StepCard.jsx';
import { useBoardActs } from '/src/products/roadmap/board/useBoardActs.js';
import { useStepAddress } from '/src/products/roadmap/step/stepAddress.js';
import { useRoadmapToast } from '/src/products/roadmap/room/useRoadmapToast.js';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';

const legend = [
  { id: 'build', hue: 'terracotta', label: 'Build' },
  { id: 'learn', hue: 'olive', label: 'Learn' },
  { id: 'milestone', hue: 'gold', label: 'Milestone' },
  { id: 'derived-plum', hue: 'plum', label: '', description: '' },
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
          breakpoint, active, query, onQuery: setQuery, legend })),
      edge('After the Board', 'bottom'));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.openState = ({ nodes, completed = [], breakpoint, loading = false, failed = false, owner = true, topInset = 0 }) => {
  const tree = nodes === null ? null : new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const call = (name) => () => (window.calls ??= []).push(name);
  createRoot(document.getElementById('root')).render(
    React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: '100vh' } },
      React.createElement(BoardView, { tree, completed: new Set(completed), completedAt: {}, loading, failed, selectedId: null,
        onSelect: () => {}, breakpoint, topInset, active: true,
        onRetry: call('retry'), onShare: owner ? call('share') : undefined, onNewStep: owner ? call('newStep') : undefined })));
};
window.openReload = (nodes, completed) => {
  function Room() {
    const [load, setLoad] = useState({ tree: null, loading: false, failed: true });
    window.finishLoad = (succeeded) => setLoad({ tree: succeeded ? new SkillTree({ id: 'sail', title: 'Learn to sail', nodes }) : null, loading: false, failed: !succeeded });
    return React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: '100vh' } },
      React.createElement(BoardView, { ...load, completed: new Set(completed), completedAt: {}, selectedId: null, onSelect: () => {},
        breakpoint: 'desktop', active: true, onRetry: () => setLoad({ tree: null, loading: true, failed: false }) }));
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
window.openSelectionBoard = (nodes, options = {}) => {
  // Count inner renders while preserving the production memo wrapper and its comparator.
  const renderCard = StepCard.type;
  window.cardRenders = {};
  StepCard.type = function CountedStepCard(props) {
    window.cardRenders[props.card.id] = (window.cardRenders[props.card.id] ?? 0) + 1;
    return renderCard(props);
  };
  window.hostEscapes = 0;
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.hostEscapes += 1;
  });
  function Room() {
    const [tree, setTree] = useState(() => new SkillTree({ id: 'selection', title: 'Learn to sail', nodes }));
    const [session] = useState(() => {
      const session = new SyncSession({ treeId: 'selection', registry: null, store: { save: () => Promise.resolve() } });
      session.seed({ id: 'selection', title: tree.title, nodes });
      return session;
    });
    const [owner, setOwner] = useState(options.owner ?? true);
    const [active, setActive] = useState(true);
    const [query, setQuery] = useState(() => new BoardQuery());
    const [quiet, setQuiet] = useState(0);
    const [revision, setRevision] = useState(0);
    const address = useStepAddress();
    const progress = useMemo(() => ({ completed: new Set(options.completed ?? ['course', 'parts', 'rig']), completedAt: { course: 1, parts: 2, rig: 3 } }), []);
    const { toast, showToast, dismissToast, toastShown } = useRoadmapToast();
    session.onTreeChanged((data) => setTree(new SkillTree(data)));
    window.writes ??= [];
    window.selectionAttempts ??= [];
    const { held, acts } = useBoardActs({
      tree, treeId: tree.treeId, owner, active, query, progress, now: Date.now,
      session: {
        ready: session.ready,
        holdAct: (cancel) => session.holdAct(cancel),
        endHeldAct: () => session.endHeldAct(),
        dispatch: (gesture, options) => {
          window.selectionAttempts.push(gesture);
          if (window.refuseSelectionWrites) return null;
          window.writes.push(gesture);
          return session.dispatch(gesture, options);
        },
        revert: (receipt) => session.revert(receipt),
      },
      showToast, clearBoardToast: dismissToast, setQuery,
      onQuiet: () => setQuiet((value) => value + 1), onReveal: () => {},
      emit: () => {},
      track: (name, props) => (window.events ??= []).push(name + ' ' + JSON.stringify(props)),
      report: (operation) => (window.reports ??= []).push(operation),
    });
    window.setSelectionOwner = setOwner;
    window.setSelectionActive = setActive;
    window.rerenderSelection = () => setRevision((value) => value + 1);
    window.removeSelectionStep = (id) => session.dispatch({ kind: 'BulkDelete', nodeIds: [id] });
    window.filterSelection = (hue) => setQuery((current) => current.toggledKind(hue));
    window.selectionQuery = query.kinds;
    window.selectionSteps = tree.nodes.map(({ id, color }) => ({ id, color }));
    window.selectionHeld = held?.ids ?? [];
    window.selectionAddress = address;
    return React.createElement('div', { className: 'st-view-layer--board' + (active ? ' is-active' : ''), 'data-revision': revision, style: { height: '100vh' } },
      React.createElement(BoardView, {
        tree: held ? held.projected(tree) : tree, ...progress, query, onQuery: setQuery, quiet,
        breakpoint: 'phone', active, editable: owner && active, selectionOpen: owner && active, legend,
        onSelect: (id) => { (window.opened ??= []).push(id); address.open(id, 'card'); },
        onNewStep: () => {},
        onComplete: (id, door) => acts.complete(id, door),
        onRecolor: (ids, hue) => acts.recolor(ids, hue), onDelete: (ids, door) => acts.delete(ids, door),
        toast, onToastShown: toastShown,
        onToastUndo: () => { toast.action.run(); dismissToast(); },
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.coverBeneath = coverBeneath;
window.boardFocusTarget = boardFocusTarget;
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

test('Chromium: Board loading shows the still filter placeholders above the columns from 744px', async () => {
  await ready;
  const errors = [];
  for (const [width, breakpoint] of [[1440, 'desktop'], [744, 'tablet'], [390, 'phone']]) {
    const page = await openStatePage({ width, height: 900 }, { nodes: null, loading: true, breakpoint, topInset: 116 }, errors);
    try {
      const layout = await page.evaluate(() => {
        const strip = document.querySelector('.st-board-skeleton-filter');
        if (!strip) return null;
        const chips = [...strip.children];
        const box = strip.getBoundingClientRect();
        const columns = document.querySelector('.st-board-columns').getBoundingClientRect();
        return {
          hidden: strip.getAttribute('aria-hidden'),
          focusable: strip.querySelectorAll('button, a, input, [tabindex]').length,
          dimensions: chips.map((chip) => [chip.getBoundingClientRect().width, chip.getBoundingClientRect().height]),
          gaps: chips.slice(1).map((chip, index) => chip.getBoundingClientRect().left - chips[index].getBoundingClientRect().right),
          left: box.left,
          top: box.top,
          gap: columns.top - box.bottom,
          still: chips.every((chip) => getComputedStyle(chip).animationName === 'none'),
          colors: chips.map((chip) => getComputedStyle(chip).backgroundColor),
          sunken: getComputedStyle(document.querySelector('.st-board-skeleton-line')).backgroundColor,
        };
      });
      if (breakpoint === 'phone') {
        assert.equal(layout, null);
      } else {
        assert.notEqual(layout, null, 'the loading filter strip is present');
        assert.deepEqual(layout, {
          hidden: 'true', focusable: 0,
          dimensions: [[62, 36], [71, 36], [73, 36], [97, 36], [61, 36]],
          gaps: [6, 6, 6, 6], left: 24, top: 120, gap: 16, still: true,
          colors: Array(5).fill(layout.sunken), sunken: layout.sunken,
        });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        assert.deepEqual(await page.evaluate(() => {
          const color = getComputedStyle(document.querySelector('.st-board-skeleton-line')).backgroundColor;
          return [...document.querySelector('.st-board-skeleton-filter').children].map((chip) => getComputedStyle(chip).backgroundColor === color);
        }), [true, true, true, true, true]);
      }
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
});

test('Chromium: tablet loading folds Done to a still, inert rail', async () => {
  await ready;
  const errors = [];
  for (const [width, breakpoint] of [[744, 'tablet'], [1023, 'tablet'], [1024, 'desktop']]) {
    const page = await openStatePage({ width, height: 900 }, { nodes: null, loading: true, breakpoint }, errors);
    try {
      const actual = await page.evaluate(() => {
        const rail = document.querySelector('.st-board-columns-rail--done');
        const columns = document.querySelector('.st-board-columns');
        return {
          busy: columns.getAttribute('aria-busy'),
          full: columns.querySelectorAll('.st-board-columns-column').length,
          rail: rail !== null,
          width: rail && Math.round(rail.getBoundingClientRect().width),
          title: rail?.querySelector('.st-board-columns-title')?.textContent ?? null,
          cards: rail?.querySelectorAll('.st-board-columns-deck-card').length ?? 0,
          controls: rail?.querySelectorAll('button, a, input, [tabindex]').length ?? 0,
          still: rail ? rail.getAnimations({ subtree: true }).length === 0 : true,
        };
      });
      assert.deepEqual(actual, breakpoint === 'tablet'
        ? { busy: 'true', full: 2, rail: true, width: width === 744 ? 136 : 168, title: 'Done', cards: 3, controls: 0, still: true }
        : { busy: 'true', full: 3, rail: false, width: null, title: null, cards: 0, controls: 0, still: true });
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
});

test('Chromium: skeleton cards hold still on every band (02.09): from 744 radius 20, height 72, lines 180×14 and up to 240×10; the phone keeps its card', async () => {
  await ready;
  const errors = [];
  const measure = async (viewport, breakpoint, { reducedMotion } = {}) => {
    const page = await openStatePage(viewport, { nodes: null, loading: true, breakpoint }, errors, { reducedMotion });
    try {
      return await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.st-board-skeleton-card')];
        const plain = document.querySelector('.st-board-skeleton-card--plain');
        const style = getComputedStyle(plain);
        const [title, detail] = plain.querySelectorAll('.st-board-skeleton-line');
        const size = (line) => [Math.round(line.getBoundingClientRect().width), Math.round(line.getBoundingClientRect().height)];
        return {
          cards: cards.length,
          moving: cards.filter((card) => getComputedStyle(card).animationName !== 'none' || card.getAnimations().length > 0).length,
          radius: style.borderRadius,
          height: Math.round(plain.getBoundingClientRect().height),
          border: style.borderTopWidth,
          title: size(title),
          detail: size(detail),
        };
      });
    } finally {
      await page.close();
    }
  };
  const desktop = { cards: 8, moving: 0, radius: '20px', height: 72, border: '1px', title: [180, 14], detail: [240, 10] };
  assert.deepEqual(await measure({ width: 1440, height: 900 }, 'desktop'), desktop);
  assert.deepEqual(await measure({ width: 1440, height: 900 }, 'desktop', { reducedMotion: 'reduce' }), desktop);
  assert.deepEqual(await measure({ width: 744, height: 900 }, 'tablet'), { cards: 5, moving: 0, radius: '20px', height: 72, border: '1px', title: [180, 14], detail: [202, 10] });
  assert.deepEqual(await measure({ width: 390, height: 844 }, 'phone'), { cards: 3, moving: 0, radius: '16px', height: 72, border: '1px', title: [180, 14], detail: [240, 10] });
  assert.deepEqual(errors, []);
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
        <button style="position: absolute; z-index: 16">Recolor</button>
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
      ['Recolor', 'Graph overlay', 'Card', 'Topbar', 'Edge ×'],
    ]);
    for (const lowerFirst of [true, false]) {
      assert.deepEqual(await page.evaluate((lowerFirst) => {
        const stage = document.getElementById('stage');
        stage.innerHTML = '<button>Base</button><button inert>Already inert</button><div class="lower" style="position:absolute;z-index:18"></div><div class="upper" style="position:absolute;z-index:20"></div>';
        const lower = coverBeneath(stage.querySelector('.lower'));
        const upper = coverBeneath(stage.querySelector('.upper'));
        const snapshot = () => [...stage.children].map((element) => element.inert);
        const states = [snapshot()];
        (lowerFirst ? lower : upper)();
        states.push(snapshot());
        (lowerFirst ? upper : lower)();
        states.push(snapshot());
        return states;
      }, lowerFirst), [
        [true, true, true, false],
        [true, true, lowerFirst, false],
        [false, true, false, false],
      ]);
    }
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

const SELECTION_CLOCK = new Date('2026-11-03T12:00:00Z');

async function openSelectionPage(width = 390, nodes = learnToSailNodes, options = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
  await page.clock.install({ time: new Date(SELECTION_CLOCK.getTime() - 60_000) });
  await page.clock.pauseAt(SELECTION_CLOCK);
  await page.goto(`${origin}/board-view-test#/t/selection`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(([nodes, options]) => openSelectionBoard(nodes, options), [nodes, options]);
  await page.getByRole('tablist').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function holdStep(page, id) {
  const card = page.locator(`.st-board-phone-pane.is-shown .st-board-card[data-step-id="${id}"]`);
  await card.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
  await page.clock.runFor(500);
  await page.locator('.st-board-bulk').waitFor();
  await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
  await card.dispatchEvent('click');
}

async function touchStep(page, id) {
  const card = page.locator(`.st-board-phone-pane.is-shown .st-board-card[data-step-id="${id}"]`);
  await card.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: 100, clientY: 200 });
  await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: 100, clientY: 200 });
  await card.dispatchEvent('click');
}

async function settleKinds(page, expanded = true) {
  await page.locator(`.st-board-bulk-recolor[aria-expanded="${expanded}"]`).waitFor();
  await page.locator('.st-board-bulk').evaluate(async (bar) => {
    await Promise.all(bar.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
}

for (const width of [390, 320]) {
  test(`Chromium: phone selection at ${width}px recolors once, preserves equal actions and kind rows, and Undo reverts its receipt`, async () => {
    const page = await openSelectionPage(width);
    try {
      await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
      await holdStep(page, 'dock');
      await touchStep(page, 'triangle');
      await touchStep(page, 'solo');
      assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '3 selected');
      assert.deepEqual(await page.evaluate(() => window.opened ?? []), []);
      assert.equal(await page.locator('.st-board-swipe').count(), 0);
      const closedActions = await page.locator('.st-board-bulk-actions').boundingBox();
      await page.getByRole('button', { name: 'Recolor', exact: true }).click();
      await settleKinds(page);
      await page.waitForFunction(() => document.activeElement.getAttribute('role') === 'radio');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Build');
      const geometry = await page.locator('.st-board-bulk').evaluate((bar) => {
        const buttons = [...bar.querySelectorAll('.st-board-bulk-actions > button')].map((button) => button.getBoundingClientRect());
        const rows = new Map();
        for (const chip of bar.querySelectorAll('[role="radio"]')) {
          const box = chip.getBoundingClientRect();
          const top = Math.round(box.top);
          rows.set(top, [...(rows.get(top) ?? []), { name: chip.textContent, height: box.height }]);
        }
        return { equal: buttons[0].width === buttons[1].width, top: buttons[0].top, rows: [...rows.values()] };
      });
      assert.equal(geometry.equal, true);
      assert.equal(geometry.top, closedActions.y);
      assert.deepEqual(geometry.rows, (width === 390
        ? [['Build', 'Learn', 'Milestone', 'Brick'], ['Sky', 'Plum']]
        : [['Build', 'Learn', 'Milestone'], ['Brick', 'Sky', 'Plum']])
        .map((row) => row.map((name) => ({ name, height: 44 }))));
      await page.getByRole('radio', { name: 'Learn', exact: true }).click();
      await page.clock.runFor(200);
      await page.getByRole('tablist').waitFor();
      await page.waitForFunction(() => !history.state?.boardSelection);
      await page.clock.runFor(1000);
      await page.getByText('3 steps recolored', { exact: true }).last().waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes), [{ kind: 'BulkRecolor', nodeIds: ['dock', 'triangle', 'solo'], color: 'olive' }]);
      assert.equal(await focused(page), 'Sail solo');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.clock.runFor(300);
      assert.deepEqual(await page.evaluate(() => window.selectionSteps.filter(({ id }) => ['dock', 'triangle', 'solo'].includes(id))), [
        { id: 'dock', color: 'terracotta' }, { id: 'triangle', color: 'olive' }, { id: 'solo', color: 'gold' },
      ]);
      assert.equal(await page.locator('.st-board-card.is-arrived').count(), 0);
      assert.ok((await events(page)).includes('roadmap_board_undo {"act":"recolor"}'));
      assert.deepEqual(await page.evaluate(() => window.reports ?? []), []);
    } finally { await page.close(); }
  });
}

test('Chromium: choosing the focused shared kind closes only kinds without a write, toast or acted event', async () => {
  const page = await openSelectionPage();
  try {
    await holdStep(page, 'bowline');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-checked') === 'true');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Learn');
    await page.getByRole('radio', { name: 'Learn', exact: true }).click();
    await page.clock.runFor(150);
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-recolor')?.getAttribute('aria-expanded') === 'false');
    await page.waitForFunction(() => history.state?.boardSelection?.kinds === false);
    assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '1 selected');
    assert.equal(await page.locator('.st-board-card[data-step-id="bowline"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => [window.writes, window.opened ?? []]), [[], []]);
    assert.equal(await page.locator('.st-board-toast').count(), 0);
    assert.equal(await focused(page), 'Recolor');
    assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), [
      'roadmap_board_select {"step":"start"}',
    ]);
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-checked') === 'true');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Learn');
  } finally { await page.close(); }
});

test('Chromium: bulk Delete projects every selected step, holds the write, and Undo restores all steps', async () => {
  const page = await openSelectionPage();
  try {
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await holdStep(page, 'dock');
    await touchStep(page, 'triangle');
    await page.getByRole('button', { name: 'Delete 2 steps' }).click();
    await page.getByRole('tablist').waitFor();
    await page.waitForFunction(() => window.selectionHeld.length === 2);
    await page.clock.runFor(1000);
    await page.getByText('2 steps deleted', { exact: true }).last().waitFor();
    assert.deepEqual(await page.locator('.st-board-phone-pane.is-shown .st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId)), ['solo']);
    assert.deepEqual(await page.evaluate(() => window.writes), []);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.clock.runFor(300);
    assert.deepEqual(await page.evaluate(() => [window.selectionHeld, window.writes]), [[], []]);
    assert.deepEqual(await page.locator('.st-board-phone-pane.is-shown .st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId)), ['dock', 'triangle', 'solo']);
  } finally { await page.close(); }
});

test('Chromium: Back and Escape close kinds before selection, and finished selection never nests a new step entry', async () => {
  const page = await openSelectionPage();
  try {
    await holdStep(page, 'bowline');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-recolor')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '1 selected');
    await page.keyboard.press('Escape');
    await page.getByRole('tablist').waitFor();
    await page.waitForFunction(() => !history.state?.boardSelection);
    assert.equal(await focused(page), 'Tie a bowline');
    assert.equal(await page.evaluate(() => window.hostEscapes), 0);
    await holdStep(page, 'bowline');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-recolor')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await page.evaluate(() => window.hostEscapes), 0);
    await settleKinds(page, false);
    await page.evaluate(() => {
      document.querySelector('.st-board-bulk-done').click();
      document.querySelector('.st-board-card[data-step-id="bowline"]').click();
    });
    await page.getByRole('tablist').waitFor();
    await page.waitForFunction(() => !history.state?.boardSelection);
    assert.deepEqual(await page.evaluate(() => window.opened ?? []), []);
    await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('popstate', resolve, { once: true });
      history.forward();
    }));
    assert.equal(await page.evaluate(() => history.state?.boardSelection ?? null), null);
    await page.locator('.st-board-card[data-step-id="bowline"]').click();
    await page.waitForFunction(() => window.selectionAddress.id === 'bowline');
    assert.deepEqual(await page.evaluate(() => history.state), { boardStep: { trail: ['bowline'], pushed: 1 } });
    await page.evaluate(() => window.selectionAddress.close());
    await page.waitForFunction(() => window.selectionAddress.id === null);
    assert.equal(await page.evaluate(() => location.hash), '#/t/selection');
  } finally { await page.close(); }
});

test('Chromium: pruning uses the live pane, recolor preserves the kind filter, and Done restores an offscreen starter', async () => {
  const extra = Array.from({ length: 80 }, (_, index) => ({ id: `locked-${index}`, label: `Locked ${index}`, color: 'olive', prerequisites: ['wind'] }));
  const page = await openSelectionPage(390, [...learnToSailNodes, ...extra]);
  const waitForFocus = async (predicate) => {
    try {
      await page.waitForFunction(predicate);
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const describe = (element) => element ? {
          tag: element.tagName,
          class: element.className,
          role: element.getAttribute('role'),
          step: element.closest('[data-step-id]')?.dataset.stepId ?? null,
          column: element.closest('[data-column]')?.dataset.column ?? null,
          selected: element.getAttribute('aria-selected'),
          tabIndex: element.tabIndex,
          inert: Boolean(element.closest('[inert]')),
          visibility: getComputedStyle(element).visibility,
          rects: element.getClientRects().length,
        } : null;
        const board = document.querySelector('.st-board');
        const pane = board?.querySelector('.st-board-phone-pane.is-shown');
        return {
          active: describe(document.activeElement),
          fallback: describe(window.boardFocusTarget(board, { cards: false })),
          board: describe(board),
          pane: describe(pane),
          tabs: [...board?.querySelectorAll('[role="tab"]') ?? []].map(describe),
          cards: [...pane?.querySelectorAll('.st-board-card') ?? []].map(describe),
          layers: [...document.querySelectorAll('[inert], [aria-modal="true"]')].map(describe),
          bulk: board?.querySelector('.st-board-bulk')?.className ?? null,
          href: location.href,
          history: history.state,
          query: window.selectionQuery,
          writes: window.writes,
          events: window.events,
          focus: window.selectionFocus,
        };
      });
      error.message += `\nSelection focus diagnostic: ${JSON.stringify(diagnostic, null, 2)}`;
      throw error;
    }
  };
  try {
    await page.evaluate(() => {
      window.selectionFocus = [];
      document.addEventListener('focusin', (event) => {
        const element = event.target;
        window.selectionFocus.push({
          class: element.className,
          role: element.getAttribute('role'),
          step: element.closest('[data-step-id]')?.dataset.stepId ?? null,
          column: element.closest('[data-column]')?.dataset.column ?? null,
          inert: Boolean(element.closest('[inert]')),
          history: history.state,
        });
      });
    });
    await page.getByRole('tab', { name: 'Locked, 83 steps' }).click();
    await holdStep(page, 'dock');
    await page.locator('.st-board-phone-pane.is-shown').evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await page.clock.runFor(400);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('tablist').waitFor();
    await waitForFocus(() => document.activeElement.dataset.stepId === 'dock');
    assert.equal(await page.locator('.st-board-phone-pane.is-shown').evaluate((pane) => pane.scrollTop < 200), true);
    await page.waitForFunction(() => !history.state?.boardSelection);
    await holdStep(page, 'dock');
    await touchStep(page, 'locked-0');
    await page.evaluate(() => filterSelection('terracotta'));
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-heading')?.textContent === '1 selected');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.getByRole('radio', { name: 'Learn', exact: true }).click();
    await page.clock.runFor(200);
    await page.getByRole('tablist').waitFor();
    assert.deepEqual(await page.evaluate(() => window.selectionQuery), ['terracotta']);
    await page.clock.runFor(1000);
    await page.waitForFunction(() => !document.querySelector('.st-board-phone-pane.is-shown .st-board-card[data-step-id="dock"]'));
    await waitForFocus(() => document.activeElement.getAttribute('role') === 'tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.body), false);
    assert.deepEqual(await page.evaluate(() => window.writes), [{ kind: 'BulkRecolor', nodeIds: ['dock'], color: 'olive' }]);
  } finally { await page.close(); }
});

test('Chromium: sole roots, scrolling and cancelled touches never start selection; owner and active loss end it', async () => {
  const page = await openSelectionPage();
  try {
    await page.getByRole('tab', { name: 'Done, 3 steps' }).click();
    const root = page.locator('.st-board-card[data-step-id="course"]');
    await root.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
    await page.clock.runFor(600);
    await root.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true });
    await root.dispatchEvent('click');
    assert.equal(await page.locator('.st-board-bulk').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.opened ?? []), []);
    await page.getByRole('tab', { name: 'Up next, 2 steps' }).click();
    const card = page.locator('.st-board-card[data-step-id="bowline"]');
    for (const cancel of ['pointercancel', 'move', 'scroll']) {
      await card.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
      if (cancel === 'pointercancel') await card.dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 7 });
      if (cancel === 'move') await card.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 211 });
      if (cancel === 'scroll') await page.locator('.st-board-phone-pane.is-shown').dispatchEvent('scroll');
      await page.clock.runFor(600);
      assert.equal(await page.locator('.st-board-bulk').count(), 0);
      await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7 });
    }
    await holdStep(page, 'bowline');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.stepId), 'bowline');
    await page.evaluate(() => setSelectionOwner(false));
    await page.getByRole('tablist').waitFor();
    await page.waitForFunction(() => !history.state?.boardSelection);
    await page.evaluate(() => setSelectionOwner(true));
    await holdStep(page, 'bowline');
    await page.evaluate(() => setSelectionActive(false));
    await page.waitForFunction(() => !document.querySelector('.st-board-bulk'));
    await page.waitForFunction(() => !history.state?.boardSelection);
    assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), [
      'roadmap_board_select {"step":"start"}', 'roadmap_board_select {"step":"end","via":"left"}',
      'roadmap_board_select {"step":"start"}', 'roadmap_board_select {"step":"end","via":"left"}',
    ]);
  } finally { await page.close(); }
});

test('Chromium: a hold without selection swallows release on the single root and every reader column; the next tap opens', async () => {
  const cases = [
    { nodes: [{ id: 'root', label: 'Start', prerequisites: [] }], options: { completed: [] }, tab: 'Up next, 1 step', id: 'root' },
    { nodes: learnToSailNodes, options: { owner: false }, tab: 'Locked, 3 steps', id: 'dock' },
    { nodes: learnToSailNodes, options: { owner: false }, tab: 'Up next, 2 steps', id: 'bowline' },
    { nodes: learnToSailNodes, options: { owner: false }, tab: 'Done, 3 steps', id: 'course' },
  ];
  for (const { nodes, options, tab, id } of cases) {
    const page = await openSelectionPage(390, nodes, options);
    try {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const card = page.locator(`.st-board-phone-pane.is-shown .st-board-card[data-step-id="${id}"]`);
      const before = await page.evaluate(() => location.href);
      await card.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
      await page.clock.runFor(500);
      await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
      await card.dispatchEvent('click');
      assert.equal(await page.locator('.st-board-bulk').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.opened ?? []), []);
      assert.equal(await page.evaluate(() => location.href), before);
      assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), []);
      await touchStep(page, id);
      await page.waitForFunction(() => window.opened?.length === 1);
      assert.deepEqual(await page.evaluate(() => window.opened), [id]);
    } finally { await page.close(); }
  }
});

test('Chromium: an unrelated parent render preserves card memoization and a hold already 200ms underway', async () => {
  const page = await openSelectionPage();
  try {
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    const starter = page.locator('.st-board-phone-pane.is-shown .st-board-card[data-step-id="dock"]');
    await starter.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
    await page.clock.runFor(200);
    const before = await page.evaluate(() => window.cardRenders);
    await page.evaluate(() => window.rerenderSelection());
    await page.locator('.st-view-layer--board[data-revision="1"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.cardRenders), before);
    await page.clock.runFor(299);
    assert.equal(await page.locator('.st-board-bulk').count(), 0);
    await page.clock.runFor(1);
    await page.locator('.st-board-bulk').waitFor();
    await starter.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 });
    await starter.dispatchEvent('click');
    assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '1 selected');
    assert.deepEqual(await page.evaluate(() => window.opened ?? []), []);
    assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), [
      'roadmap_board_select {"step":"start"}',
    ]);
  } finally { await page.close(); }
});

test('Chromium: a delayed kind apply reads the selection pruned during its animation', async () => {
  const page = await openSelectionPage();
  try {
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await holdStep(page, 'dock');
    await touchStep(page, 'triangle');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.getByRole('radio', { name: 'Sky', exact: true }).evaluate((chip) => chip.click());
    await page.clock.runFor(60);
    await page.evaluate(() => window.filterSelection('terracotta'));
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-heading')?.textContent === '1 selected');
    assert.deepEqual(await page.evaluate(() => window.writes), []);
    await page.clock.runFor(60);
    await page.getByRole('tablist').waitFor();
    await page.clock.runFor(1000);
    await page.getByText('1 step recolored', { exact: true }).last().waitFor();
    assert.deepEqual(await page.evaluate(() => ({ writes: window.writes, query: window.selectionQuery })), {
      writes: [{ kind: 'BulkRecolor', nodeIds: ['dock'], color: 'sky' }], query: ['terracotta'],
    });
    assert.deepEqual(await page.evaluate(() => window.selectionSteps.filter(({ id }) => ['dock', 'triangle'].includes(id))), [
      { id: 'dock', color: 'sky' }, { id: 'triangle', color: 'olive' },
    ]);
  } finally { await page.close(); }
});

test('Chromium: refused recolor keeps the selection and controls live for a later apply', async () => {
  const page = await openSelectionPage();
  try {
    await holdStep(page, 'bowline');
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.evaluate(() => { window.refuseSelectionWrites = true; });
    await page.getByRole('radio', { name: 'Build', exact: true }).evaluate((chip) => chip.click());
    await page.clock.runFor(120);
    await page.waitForFunction(() => window.selectionAttempts.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ writes: window.writes, reports: window.reports ?? [] })), { writes: [], reports: [] });
    assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '1 selected');
    assert.equal(await page.getByRole('button', { name: 'Recolor', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.st-board-toast').count(), 0);
    assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), ['roadmap_board_select {"step":"start"}']);
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await page.waitForFunction(() => history.state?.boardSelection?.kinds === false);
    await page.getByRole('button', { name: 'Recolor', exact: true }).click();
    await settleKinds(page);
    await page.evaluate(() => { window.refuseSelectionWrites = false; });
    await page.getByRole('radio', { name: 'Build', exact: true }).evaluate((chip) => chip.click());
    await page.clock.runFor(120);
    await page.getByRole('tablist').waitFor();
    await page.waitForFunction(() => !history.state?.boardSelection);
    const gesture = { kind: 'BulkRecolor', nodeIds: ['bowline'], color: 'terracotta' };
    assert.deepEqual(await page.evaluate(() => ({ attempts: window.selectionAttempts, writes: window.writes })), {
      attempts: [gesture, gesture], writes: [gesture],
    });
  } finally { await page.close(); }
});

test('Chromium: clearing a filter never resurrects choices pruned from the selection', async () => {
  const page = await openSelectionPage();
  try {
    await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
    await holdStep(page, 'dock');
    await touchStep(page, 'triangle');
    await page.evaluate(() => window.filterSelection('terracotta'));
    await page.waitForFunction(() => document.querySelector('.st-board-bulk-heading')?.textContent === '1 selected');
    await page.evaluate(() => window.filterSelection('terracotta'));
    await page.waitForFunction(() => window.selectionQuery.length === 0);
    await page.clock.runFor(1000);
    await page.locator('.st-board-phone-pane.is-shown .st-board-card[data-step-id="triangle"]').waitFor();
    assert.equal(await page.locator('.st-board-bulk-heading').textContent(), '1 selected');
    assert.deepEqual(await page.locator('.st-board-phone-pane.is-shown .st-board-card').evaluateAll((cards) => cards.map((card) => ({
      id: card.dataset.stepId, selected: card.getAttribute('aria-pressed'),
    }))), [
      { id: 'dock', selected: 'true' }, { id: 'triangle', selected: 'false' }, { id: 'solo', selected: 'false' },
    ]);
    assert.deepEqual(await page.evaluate(() => window.writes), []);
  } finally { await page.close(); }
});

for (const change of ['filter', 'remote delete']) {
  test(`Chromium: ${change} emptying selection restores the shown tab after leaving cards unmount`, async () => {
    const page = await openSelectionPage();
    try {
      await page.getByRole('tab', { name: 'Locked, 3 steps' }).click();
      await holdStep(page, 'dock');
      await page.evaluate((change) => {
        if (change === 'filter') window.filterSelection('sky');
        else window.removeSelectionStep('dock');
      }, change);
      await page.getByRole('tablist').waitFor();
      await page.clock.runFor(1000);
      await page.waitForFunction(() => !document.querySelector('.st-board-phone-pane.is-shown .st-board-card[data-step-id="dock"]'));
      await page.waitForFunction(() => document.activeElement.getAttribute('role') === 'tab');
      assert.deepEqual(await page.evaluate(() => ({
        role: document.activeElement.getAttribute('role'),
        selected: document.activeElement.getAttribute('aria-selected'),
        body: document.activeElement === document.body,
      })), { role: 'tab', selected: 'true', body: false });
      assert.deepEqual((await events(page)).filter((event) => event.startsWith('roadmap_board_select')), [
        'roadmap_board_select {"step":"start"}', 'roadmap_board_select {"step":"end","via":"emptied"}',
      ]);
      assert.deepEqual(await page.evaluate(() => window.writes), []);
    } finally { await page.close(); }
  });
}

test('Chromium: a selection of every root offers Recolor and no Delete, and Delete returns once a root is let go', async () => {
  const page = await openSelectionPage(390, [
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
    { id: 'knots', label: 'Practise knots', prerequisites: [], color: 'olive' },
  ], { completed: [] });
  try {
    await holdStep(page, 'wind');
    await page.getByRole('button', { name: 'Delete 1 step' }).waitFor();
    await touchStep(page, 'knots');
    await page.locator('.st-board-bulk-delete').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.st-board-bulk-recolor').count(), 1);
    await touchStep(page, 'knots');
    await page.getByRole('button', { name: 'Delete 1 step' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.writes), []);
  } finally { await page.close(); }
});

test('Chromium: Board recovery skips hidden empty panes and retiring or covered cards', async () => {
  const page = await openSelectionPage(390, [
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
    { id: 'knots', label: 'Practise knots', prerequisites: [], color: 'olive' },
  ], { completed: [] });
  try {
    const targets = await page.evaluate(() => {
      const root = document.querySelector('.st-board');
      const wind = root.querySelector('[data-step-id="wind"]');
      const read = (options) => {
        const target = window.boardFocusTarget(root, options);
        return { step: target.dataset.stepId ?? null, role: target.getAttribute('role') };
      };
      const initial = read();
      const preferred = read({ preferredId: 'knots' });
      const excluded = read({ excludeId: 'wind' });
      wind.classList.add('is-leaving');
      const retiring = read({ preferredId: 'wind' });
      wind.classList.remove('is-leaving');
      wind.inert = true;
      const covered = read({ preferredId: 'wind' });
      wind.inert = false;
      return { initial, preferred, excluded, retiring, covered };
    });
    assert.deepEqual(targets, {
      initial: { step: 'wind', role: null },
      preferred: { step: 'knots', role: null },
      excluded: { step: null, role: 'tab' },
      retiring: { step: null, role: 'tab' },
      covered: { step: null, role: 'tab' },
    });
  } finally { await page.close(); }
});
