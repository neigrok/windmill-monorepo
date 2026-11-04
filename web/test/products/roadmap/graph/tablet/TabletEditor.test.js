import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../browserFixture.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import { TabletEditor } from '/src/products/roadmap/graph/tablet/TabletEditor.jsx';
const noop = () => {};
function Room() {
  const [state, setState] = useState('available');
  return React.createElement(TabletEditor, {
    node: { id: 'wind', label: 'Read the wind', color: 'sky' }, state,
    onMarkDone: (id) => { window.calls.push(['complete', id]); setState('complete'); },
    onUnmarkDone: (id) => { window.calls.push(['reset', id]); setState('available'); },
    legend: [{ id: 'build', hue: 'terracotta', label: 'Build' }, { id: 'learn', hue: 'olive', label: 'Learn' }, { id: 'milestone', hue: 'gold', label: 'Milestone' }],
    onRename: noop, onAddStep: noop, onConnect: noop, onDelete: noop,
    onSetKind: (id, hue) => window.calls.push(['kind', id, hue]),
  });
}
window.openSheet = () => {
  window.calls = [];
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.entryReady = true;
`;
let server, browser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({
      configFile: false, root, cacheDir: `${root}/node_modules/.vite-mobile-editor-focus-test`,
      plugins: [{ name: 'mobile-editor-focus-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/mobile-editor-entry.js') return '\0mobile-editor-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0mobile-editor-beacon';
        },
        load(id) {
          if (id === '\0mobile-editor-entry') return entry;
          if (id === '\0mobile-editor-beacon') return beacon;
        },
        configureServer(server) {
          server.middlewares.use('/mobile-editor-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Editor focus test</title><div id="root"></div><script type="module" src="/mobile-editor-entry.js"></script>');
          });
        },
      }],
      optimizeDeps: { include: ['react', 'react-dom/client'] },
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  await ready?.catch(() => {});
  await browser?.close();
  await server?.close();
});

test('Chromium: completion and reset preserve the focused editor action node', async () => {
    await start();
    const page = await browser.newPage({ viewport: { width: 744, height: 900 } });
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/mobile-editor-test`);
        await page.waitForFunction(() => window.entryReady);
        await page.evaluate(() => window.openSheet());
        const complete = page.getByRole('button', { name: 'Mark done', exact: true });
        await complete.waitFor();
        await complete.focus();
        await page.evaluate(() => { window.originalAction = document.activeElement; });
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Mark not done', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          same: document.activeElement === window.originalAction,
          text: document.activeElement.textContent,
          calls: window.calls,
        })), { same: true, text: 'Mark not done', calls: [['complete', 'wind']] });
        await page.keyboard.press('Enter');
        await complete.waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          same: document.activeElement === window.originalAction,
          text: document.activeElement.textContent,
          calls: window.calls,
        })), { same: true, text: 'Mark done', calls: [['complete', 'wind'], ['reset', 'wind']] });
      });
    } finally {
      await page.close();
    }
});

test('Chromium: the tablet panel offers the six choices with no link; arrow keys move focus and only a press saves', async () => {
  await start();
  const page = await browser.newPage({ viewport: { width: 744, height: 900 } });
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/mobile-editor-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate(() => window.openSheet());
      const group = page.getByRole('radiogroup', { name: 'Kind', exact: true });
      await group.waitFor();
      const radios = group.getByRole('radio');
      assert.deepEqual(await radios.evaluateAll((elements) => elements.map((element) => [element.textContent, element.getAttribute('aria-checked'), element.tabIndex])), [
        ['Build', 'false', -1], ['Learn', 'false', -1], ['Milestone', 'false', -1], ['Brick', 'false', -1], ['Sky', 'true', 0], ['Plum', 'false', -1],
      ]);
      assert.equal(await page.getByRole('button', { name: 'Manage kinds', exact: true }).count(), 0);
      await group.getByRole('radio', { name: 'Sky', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      assert.deepEqual(await page.evaluate(() => [document.activeElement.textContent, window.calls]), ['Plum', []]);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.calls), [['kind', 'wind', 'plum']]);
    });
  } finally {
    await page.close();
  }
});

for (const [state, verb] of [['available', 'complete'], ['complete', 'uncomplete'], ['locked', null]]) {
  test(`progressVerb — ${state} offers ${verb}`, async () => {
    const { register } = await import('node:module');
    register('../../../../jsxLoader.mjs', import.meta.url);
    const { progressVerb } = await import('../../../../../src/products/roadmap/graph/tablet/TabletEditor.jsx');
    assert.equal(progressVerb(state), verb);
  });
}
