import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { chromium } from 'playwright';
import { createServer, transformWithEsbuild } from 'vite';
import { withBrowserErrors } from './composerFixture.js';

const CLOCK_START = new Date('2026-11-02T12:00:00Z');

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = await readFile(new URL('../../../../src/products/roadmap/editing/useGraphStructure.js', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'useGraphStructure.js', { loader: 'jsx' });
const treeHandlers = [];
const visit = (node) => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.name === 'onTreeChanged') {
    const callback = node.init.arguments[0];
    treeHandlers.push(code.slice(callback.start, callback.end));
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(visit);
    else if (child && typeof child === 'object') visit(child);
  }
};
visit(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
assert.equal(treeHandlers.length, 1);
const entry = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useRoadmapToast } from '/src/products/roadmap/board/useRoadmapToast.js';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { useBoardActs } from '/src/products/roadmap/board/useBoardActs.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
import { hlcText } from '/src/products/roadmap/sync/lattice.js';
import { GRAPH_TOAST, keptStepsToast } from '/src/products/roadmap/board/copy.js';
import '/src/styles/global.css';
const root = createRoot(document.getElementById('root'));
const initialTree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
  { id: 'course', label: 'Choose a course', prerequisites: [] },
  { id: 'wind', label: 'Read the wind', prerequisites: ['course'] },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'] },
] });
const progress = { completed: new Set(['course']), completedAt: { course: 1 } };
window.calls = [];
window.restoreOffers = [];
function Room() {
  const [active, setActive] = useState(true);
  const [owner, setOwner] = useState(true);
  const [treeId, setTreeId] = useState('sail');
  const [tree, setTree] = useState(initialTree);
  const [session] = useState(() => {
    const session = new SyncSession({ treeId: 'sail', registry: null, store: { save: () => Promise.resolve() } });
    session.seed({ id: initialTree.id, title: initialTree.title, nodes: initialTree.nodes });
    return session;
  });
  const [query, setQuery] = useState(() => new BoardQuery());
  const [quiet, setQuiet] = useState(0);
  const { toast, showToast: displayToast, dismissToast, dismissToastIf, toastShown } = useRoadmapToast();
  const showToast = (message, options) => {
    if (options.action?.label === 'Restore') window.restoreOffers.push(message);
    displayToast(message, options);
  };
  const projectionRef = useRef(initialTree);
  const sessionRef = { current: session };
  const maskedShownRef = useRef('');
  const syncStructure = () => setTree(new SkillTree(projectionRef.current));
  const syncLegendFromTree = () => {};
  const setStranded = () => {};
  session.onTreeChanged(${treeHandlers[0]});
  window.maskedWork = () => session.maskedWork();
  window.projectedSteps = () => session.lattice.toTreeData().nodes.map(({ id, prerequisites }) => ({ id, prerequisites }));
  window.recheckTree = () => session.emitTree();
  window.deleteLegacy = () => session.dispatch({ kind: 'DeleteNode', id: 'wind' });
  window.loadHistoricalDelete = () => {
    session.lattice.join({ nodes: [{ id: 'wind', deletedAt: hlcText(session.clock.tick(Date.now())) }] });
    session.emitTree();
  };
  const { held, acts } = useBoardActs({
    tree, treeId, active, owner, query, progress, now: Date.now,
    session: { dispatch: (gesture) => {
      window.calls.push(['dispatch', treeId, gesture]);
      return session.dispatch(gesture);
    } },
    showToast,
    clearBoardToast: () => dismissToastIf(() => true),
    emit: () => {},
    track: (name, props) => window.calls.push(['event', name, props]), report: (op) => window.calls.push(['report', op]),
    onQuiet: () => setQuiet((current) => current + 1), onReveal: () => {},
  });
  window.deleteStep = () => flushSync(() => acts.delete(['wind'], 'menu'));
  window.flush = () => flushSync(() => {});
  window.leave = (via) => flushSync(() => {
    if (via === 'view') setActive(false);
    if (via === 'owner') setOwner(false);
    if (via === 'roadmap') setTreeId('other');
    if (via === 'unmount') root.unmount();
    if (via === 'pagehide') window.dispatchEvent(new Event('pagehide'));
  });
  return React.createElement(React.Fragment, null,
    React.createElement('output', null, held ? 'held' : 'clear'),
    React.createElement(BoardView, {
      tree: held ? held.projected(tree) : tree, ...progress, query, onQuery: setQuery, quiet,
      active, breakpoint: 'desktop', onSelect: () => {},
      toast, onToastShown: (key) => { window.shownAt = Date.now(); toastShown(key); },
      onToastUndo: () => { toast.action.run(); dismissToast(); },
    }));
}
flushSync(() => root.render(React.createElement(Room)));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-board-acts-test`,
    plugins: [{ name: 'board-acts-test',
      resolveId(id) { if (id === '/board-acts-entry.js') return '\0board-acts-entry'; },
      load(id) { if (id === '\0board-acts-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/board-acts-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><div id="root"></div><script type="module" src="/board-acts-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

for (const trigger of ['view', 'owner', 'roadmap', 'unmount', 'pagehide']) {
  test(`Chromium: held delete releases exactly once on ${trigger}`, async () => {
    await ready;
    const page = await browser.newPage();

    try {
      await withBrowserErrors(page, async () => {
        await page.clock.install({ time: new Date(CLOCK_START.getTime() - 60000) });
        await page.clock.pauseAt(CLOCK_START);
        await page.goto(`${origin}/board-acts-test`);
        await page.waitForFunction(() => !!window.deleteStep);
        await page.evaluate(() => window.deleteStep());
        await page.waitForFunction(() => document.querySelector('output').textContent === 'held');
        assert.deepEqual(await page.evaluate(() => window.calls), [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }]]);
        await page.evaluate((via) => window.leave(via), trigger);
        await page.waitForFunction(() => window.calls.some(([kind]) => kind === 'dispatch'));
        await page.clock.fastForward(10000);
        assert.deepEqual(await page.evaluate(() => window.calls), [
          ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }],
          ['dispatch', 'sail', { kind: 'BulkDelete', nodeIds: ['wind'] }],
          ['event', 'roadmap_board_delete', { step: 'sent', via: 'left', view: 'board' }],
        ]);
        await page.evaluate(() => window.recheckTree());
        assert.deepEqual(await page.evaluate(() => ({ masked: window.maskedWork(), offers: window.restoreOffers, steps: window.projectedSteps() })), {
          masked: [], offers: [], steps: [{ id: 'course', prerequisites: [] }, { id: 'dock', prerequisites: ['course'] }],
        });
      });
    } finally { await page.close(); }
  });
}

for (const undo of [false, true]) {
  test(`Chromium: real host toast holds nine seconds from BoardView entry${undo ? ' and Undo cancels send' : ''}`, async () => {
    await ready;
    const page = await browser.newPage({ reducedMotion: 'reduce' });

    try {
      await withBrowserErrors(page, async () => {
        await page.clock.install({ time: new Date(CLOCK_START.getTime() - 60000) });
        await page.clock.pauseAt(CLOCK_START);
        await page.goto(`${origin}/board-acts-test`);
        await page.waitForFunction(() => !!window.deleteStep);
        await page.evaluate(() => window.deleteStep());
        await page.waitForFunction(() => document.querySelector('output').textContent === 'held');
        assert.equal(await page.locator('.st-board-toast').count(), 0);
        await page.clock.runFor(150);
        await page.evaluate(() => window.flush());
        await page.waitForFunction(() => document.querySelector('[data-column="upNext"] .st-board-card-title')?.textContent === 'Leave the dock');
        await page.clock.runFor(120);
        await page.evaluate(() => window.flush());
        await page.locator('.st-board-toast').waitFor({ state: 'visible' });
        const shownAt = await page.evaluate(() => window.shownAt);
        assert.equal(shownAt, CLOCK_START.getTime() + 270);
        await page.clock.runFor(8999);
        assert.deepEqual(await page.evaluate(() => window.calls), [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }]]);
        if (undo) {
          await page.locator('.st-board-toast-undo').evaluate((button) => button.click());
          await page.waitForFunction(() => document.querySelector('output').textContent === 'clear');
        }
        await page.clock.runFor(1);
        const outcome = undo
          ? [['event', 'roadmap_board_undo', { act: 'delete' }]]
          : [['dispatch', 'sail', { kind: 'BulkDelete', nodeIds: ['wind'] }], ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer', view: 'board' }]];
        assert.deepEqual(await page.evaluate(() => window.calls), [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }], ...outcome]);
        assert.deepEqual(await page.evaluate(() => [window.maskedWork(), window.restoreOffers]), [[], []]);
        if (!undo) {
          await page.evaluate(() => { window.leave('view'); window.recheckTree(); });
          assert.deepEqual(await page.evaluate(() => ({ masked: window.maskedWork(), offers: window.restoreOffers, steps: window.projectedSteps() })), {
            masked: [], offers: [], steps: [{ id: 'course', prerequisites: [] }, { id: 'dock', prerequisites: ['course'] }],
          });
        }
      });
    } finally { await page.close(); }
  });
}

test('Chromium: the real host offer boundary still reports masked work from a pre-fix deletion', async () => {
  await ready;
  const page = await browser.newPage();

  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/board-acts-test`);
      await page.waitForFunction(() => !!window.loadHistoricalDelete);
      await page.evaluate(() => window.loadHistoricalDelete());
      assert.deepEqual(await page.evaluate(() => ({ masked: window.maskedWork(), offers: window.restoreOffers })), {
        masked: [{ id: 'wind', label: 'Read the wind', children: ['dock'] }],
        offers: ['1 step kept under a deleted node'],
      });
    });
  } finally { await page.close(); }
});

test('Chromium: the real host offer boundary stays clear after a Graph or List delete', async () => {
  await ready;
  const page = await browser.newPage();

  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/board-acts-test`);
      await page.waitForFunction(() => !!window.deleteLegacy);
      await page.evaluate(() => window.deleteLegacy());
      assert.deepEqual(await page.evaluate(() => ({ masked: window.maskedWork(), offers: window.restoreOffers })), {
        masked: [], offers: [],
      });
    });
  } finally { await page.close(); }
});
