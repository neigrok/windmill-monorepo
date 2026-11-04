import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { parse } from 'acorn';
import { beacon, withBrowserErrors, fixtureNodes } from './composerFixture.js';
import { COMPOSER, DELETE_CONFIRM, DISCARD_DRAFT, LABELS, PICKER, STEP_DETAIL } from '../../../../src/products/roadmap/board/copy.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { StepComposer } from '/src/products/roadmap/board/StepComposer.jsx';
import { StepDetail } from '/src/products/roadmap/board/StepDetail.jsx';
import { Sheet } from '/src/products/roadmap/board/BoardControls.jsx';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: (${fixtureNodes.toString()})(3) });
const completed = new Set();
const noop = () => {};
window.mount = (mode) => {
  function App() {
    const [open, setOpen] = useState(false);
    const [opener, setOpener] = useState(true);
    const [query, setQuery] = useState(() => new BoardQuery());
    window.removeOpener = () => setOpener(false);
    const close = () => setOpen(false);
    return React.createElement('div', null,
      opener && React.createElement('button', { onClick: () => setOpen(true) }, 'Open layer'),
      React.createElement('button', { id: 'outside' }, 'Outside'),
      React.createElement('div', { className: 'st-view-layer--board is-active', style: { height: 600 } },
        React.createElement(BoardView, { tree, completed, completedAt: {}, breakpoint: 'tablet', active: true,
          selectedId: null, onSelect: noop, onAnchor: noop, query, onQuery: setQuery })),
      open && mode === 'composer' && React.createElement(StepComposer, { tree, completed, legend: [], band: 'tablet',
        onClose: close, onCreate: () => ({ ok: true }), onEdit: () => ({ ok: true }) }),
      open && mode === 'detail' && React.createElement(StepDetail, { tree, completed, completedAt: {},
        address: { id: 'step-0', trail: ['step-0'], door: 'card' }, breakpoint: 'desktop', roadmapTitle: tree.title,
        editable: true, deletable: true, workspace: { subtasks: [], note: '', links: [] }, workspaceActions: {},
        onBack: close, onClose: close, onDelete: close, onOpenStep: noop, onOpenInGraph: noop, onViewBranch: noop }),
      open && mode === 'sheet' && React.createElement(Sheet, { host: document.body, variant: 'filter', title: 'Test sheet', onClose: close },
        React.createElement('button', { id: 'sheet-first' }, 'First'),
        React.createElement('button', { disabled: true }, 'Disabled'),
        React.createElement('button', { id: 'sheet-last' }, 'Last')));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;
let server, browser, origin, launching;
const serving = (async () => {
  server = await createServer({
    configFile: false, root, cacheDir: `${root}/node_modules/.vite-focus-layers-test`,
    plugins: [{
      name: 'focus-layers-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/focus-layers-entry.js') return '\0focus-layers-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0focus-layers-beacon';
      },
      load(id) {
        if (id === '\0focus-layers-entry') return entry;
        if (id === '\0focus-layers-beacon') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/focus-layers-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/focus-layers-entry.js"></script>');
        });
      },
    }],
    optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } },
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
})();
after(async () => {
  await serving;
  await browser?.close();
  await server?.close();
});

async function run(mode, action) {
  await serving;
  launching ??= chromium.launch({ headless: true });
  browser = await launching;
  const page = await browser.newPage({ viewport: { width: 1024, height: 960 } });
  page.setDefaultTimeout(5000);
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/focus-layers-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate((value) => window.mount(value), mode);
      await page.getByRole('button', { name: 'Open layer', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await action(page);
    });
  } finally {
    await page.close();
  }
}

const focused = (page) => page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent);

test('Focus layers fixture transforms the real consumers and complete entry', async () => {
  await serving;
  parse(entry, { ecmaVersion: 'latest', sourceType: 'module' });
  for (const path of ['/focus-layers-entry.js', '/src/products/roadmap/board/BoardControls.jsx', '/src/products/roadmap/board/StepComposer.jsx', '/src/products/roadmap/board/StepDetail.jsx']) {
    const result = await server.transformRequest(path);
    assert.ok(result?.code, path);
    parse(result.code, { ecmaVersion: 'latest', sourceType: 'module' });
  }
});

test('Chromium Tab edges: Sheet wraps Shift+Tab and recovers outside focus', async () => {
  await run('sheet', async (page) => {
    await page.getByRole('button', { name: LABELS.close, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'Last');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), LABELS.close);
    await page.evaluate(() => {
      document.getElementById('outside').focus();
      document.querySelector('.st-board-sheet-layer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, shiftKey: true }));
    });
    assert.equal(await focused(page), 'Last');
  });
});

test('Chromium Sheet keeps closing on a prevented Escape that reaches its layer', async () => {
  await run('sheet', async (page) => {
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      event.preventDefault();
      document.getElementById('sheet-first').dispatchEvent(event);
    });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog').count(), 0);
  });
});

test('Chromium Tab edges: nested DeleteConfirmation keeps native inner movement, wraps and restores its opener', async () => {
  await run('detail', async (page) => {
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: DELETE_CONFIRM.cancel, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), DELETE_CONFIRM.delete);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), DELETE_CONFIRM.cancel);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), DELETE_CONFIRM.delete);
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-board-step-menu > button'));
    assert.equal(await focused(page), STEP_DETAIL.more);
  });
});

test('Chromium Tab edges: a replaced picker page ends at Cancel while Apply is disabled', async () => {
  await run('composer', async (page) => {
    await page.locator('.st-board-draft-needs').click();
    await page.getByRole('dialog', { name: PICKER.title, exact: true }).waitFor();
    const first = page.locator('.st-board-picker-back');
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), PICKER.cancel);
    await page.keyboard.press('Tab');
    assert.equal(await first.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.locator('.st-board-picker').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-board-draft-needs'));
    assert.equal(await page.getByRole('dialog', { name: COMPOSER.title, exact: true }).count(), 1);
  });
});

test('Chromium focus return: a removed composer opener falls back to the visible Board', async () => {
  await run('composer', async (page) => {
    await page.evaluate(() => window.removeOpener());
    await page.getByRole('button', { name: 'Open layer', exact: true }).waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.closest('.st-board') !== null);
    assert.equal(await page.evaluate(() => document.activeElement === document.body), false);
  });
});

test('Chromium Tab edges: nested draft confirmation keeps the composer covered until dismissal', async () => {
  await run('composer', async (page) => {
    await page.getByLabel(COMPOSER.name, { exact: true }).fill('Practice knots');
    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('dialog', { name: DISCARD_DRAFT.title, exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: DISCARD_DRAFT.keepEditing, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), DISCARD_DRAFT.discard);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), DISCARD_DRAFT.keepEditing);
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-board-draft-field input'));
  });
});
