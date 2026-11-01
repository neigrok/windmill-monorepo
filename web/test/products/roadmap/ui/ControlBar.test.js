import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ControlBar } = await import('../../../../src/products/roadmap/ui/ControlBar.jsx');

test('ControlBar — Share is offered only with a roadmap to share: no handler, no button', () => {
  const shares = (props) => renderToStaticMarkup(React.createElement(ControlBar, { board: true, ...props })).match(/aria-label="Share roadmap"/g)?.length ?? 0;
  assert.deepEqual([shares({ onShare: () => {} }), shares({})], [1, 0]);
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import '/src/products/roadmap/board/board.css';
import { ControlBar } from '/src/products/roadmap/ui/ControlBar.jsx';
import { ViewSwitch } from '/src/products/roadmap/board/ViewSwitch.jsx';

const Watched = window.ResizeObserver;
window.observers = 0;
window.ResizeObserver = class extends Watched { constructor(callback) { super(callback); window.observers += 1; } };

window.openBar = (measured) => {
  window.bottoms = [];
  function Room() {
    const [withSwitch, setWithSwitch] = useState(true);
    window.dropSwitch = () => setWithSwitch(false);
    return React.createElement('div', { style: { position: 'relative', height: '100vh' } },
      React.createElement(ControlBar, {
        title: 'Learn to sail',
        board: true,
        viewSwitch: withSwitch ? React.createElement(ViewSwitch, { view: 'board', onSwitch: () => {} }) : null,
        onShare: () => {},
        onBottom: measured ? (bottom) => window.bottoms.push(bottom) : undefined,
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-control-bar-test`,
    plugins: [{ name: 'control-bar-test',
      resolveId(id) { if (id === '/control-bar-entry.js') return '\0control-bar-entry'; },
      load(id) { if (id === '\0control-bar-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/control-bar-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Control bar test</title><div id="root"></div><script type="module" src="/control-bar-entry.js"></script>');
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

async function openBar(measured, errors) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/control-bar-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((measured) => openBar(measured), measured);
  await page.locator('.st-topbar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const brandBottom = (page) => page.evaluate(() => Math.round(document.querySelector('.st-brand').getBoundingClientRect().bottom));

test('Chromium: ControlBar hands its host where its content ends, and again when that changes', async () => {
  await ready;
  const errors = [];
  const page = await openBar(true, errors);
  try {
    await page.waitForFunction(() => window.bottoms.length > 0);
    const withSwitch = await brandBottom(page);
    assert.deepEqual([withSwitch, (await page.evaluate(() => window.bottoms)).at(-1)], [90, 90]);
    await page.evaluate(() => dropSwitch());
    await page.waitForFunction((before) => window.bottoms.at(-1) !== before, withSwitch);
    assert.equal((await page.evaluate(() => window.bottoms)).at(-1), await brandBottom(page));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('Chromium: without onBottom ControlBar measures nothing', async () => {
  await ready;
  const errors = [];
  const page = await openBar(false, errors);
  try {
    assert.deepEqual([await page.evaluate(() => window.observers), await page.evaluate(() => window.bottoms)], [0, []]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
