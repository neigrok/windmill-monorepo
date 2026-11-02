import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useBoardActs } from '/src/products/roadmap/board/useBoardActs.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const root = createRoot(document.getElementById('root'));
const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [{ id: 'wind', label: 'Read the wind', prerequisites: [] }] });
window.calls = [];
let toast;
let timer;
function Room() {
  const [active, setActive] = useState(true);
  const [owner, setOwner] = useState(true);
  const [treeId, setTreeId] = useState('sail');
  const { held, acts } = useBoardActs({
    tree, treeId, active, owner, query: new BoardQuery(), progress: { completed: new Set(), completedAt: {} }, now: Date.now,
    session: { dispatch: (gesture, options) => { window.calls.push(['dispatch', treeId, gesture, options]); return {}; } },
    showToast: (message, options) => { toast = options; clearTimeout(timer); timer = setTimeout(() => options.onLeave('timer'), options.holdMs); },
    clearBoardToast: () => { clearTimeout(timer); toast = null; },
    track: (name, props) => window.calls.push(['event', name, props]), report: (op) => window.calls.push(['report', op]),
    onQuiet: () => {}, onReveal: () => {},
  });
  window.deleteStep = () => acts.delete('wind');
  window.undo = () => toast.action.run();
  window.leave = (via) => {
    if (via === 'view') setActive(false);
    if (via === 'owner') setOwner(false);
    if (via === 'roadmap') setTreeId('other');
    if (via === 'unmount') root.unmount();
    if (via === 'pagehide') window.dispatchEvent(new Event('pagehide'));
  };
  return React.createElement('output', null, held ? 'held' : 'clear');
}
root.render(React.createElement(Room));
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
      await page.clock.install();
      await page.goto(`${origin}/board-acts-test`);
      await page.waitForFunction(() => !!window.deleteStep);
      await page.evaluate(() => window.deleteStep());
      await page.waitForFunction(() => document.querySelector('output').textContent === 'held');
      assert.deepEqual(await page.evaluate(() => window.calls), [['event', 'roadmap_board_delete', { step: 'held' }]]);
      await page.evaluate((via) => window.leave(via), trigger);
      await page.waitForFunction(() => window.calls.some(([kind]) => kind === 'dispatch'));
      await page.clock.fastForward(10000);
      assert.deepEqual(await page.evaluate(() => window.calls), [
        ['event', 'roadmap_board_delete', { step: 'held' }],
        ['dispatch', 'sail', { kind: 'BulkDelete', nodeIds: ['wind'] }, { captureFailures: true }],
        ['event', 'roadmap_board_delete', { step: 'sent', via: 'left' }],
      ]);
    } finally { await page.close(); }
  });
}

test('Chromium: the injected toast clock holds nine seconds and Undo prevents its send', async () => {
  await ready;
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await page.goto(`${origin}/board-acts-test`);
    await page.waitForFunction(() => !!window.deleteStep);
    await page.evaluate(() => window.deleteStep());
    await page.clock.fastForward(8999);
    assert.deepEqual(await page.evaluate(() => window.calls), [['event', 'roadmap_board_delete', { step: 'held' }]]);
    await page.evaluate(() => window.undo());
    await page.clock.fastForward(1);
    assert.deepEqual(await page.evaluate(() => window.calls), [
      ['event', 'roadmap_board_delete', { step: 'held' }], ['event', 'roadmap_board_undo', { act: 'delete' }],
    ]);
  } finally { await page.close(); }
});
