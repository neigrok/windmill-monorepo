import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = `
import React, { Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { SiteFrame, SiteHeader } from '/src/shell/marketing/SiteChrome.jsx';
import { PageFrame } from '/src/shell/PageFrame.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { setAppearance } from '/src/shell/appearance.js';
import { StepDraftProvider, StepDraftNotice } from '/src/products/roadmap/step/StepDraftProvider.jsx';
import { InlineStepDraft } from '/src/products/roadmap/step/InlineStepDraft.js';
import { stepDraftSession } from '/src/products/roadmap/step/StepDraftSession.js';
import '/src/styles/global.css';
const scope = new DocumentDataScope();
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
const store = stepDraftSession(document);
window.seedDraft = () => {
  const token = store.start({ treeId: 'tree', route: { pathname: '/', search: '', hash: '', state: null },
    draft: new InlineStepDraft({ stepId: 'step', field: 'description', baselineValue: '', draftValue: 'Private retained content' }), displayValue: 'Private retained content' });
  store.retain(token);
};
window.clearDraft = () => store.invalidate();
const Pending = () => { throw new Promise(() => {}); };
const Fixed = () => React.createElement('main', { id: 'page-content', style: { position: 'fixed', inset: 0 } }, React.createElement('h1', null, 'Current route'));
function App() {
  const [route, setRoute] = useState('shell');
  window.showRoute = setRoute;
  const children = route === 'shell' ? React.createElement(Shell, { location: { pathname: '/app', hash: '', search: '' }, neutral: { Component: Fixed } })
    : route === 'landing' ? React.createElement(SiteFrame, { path: '/', header: React.createElement(SiteHeader, { page: 'front', night: false }) }, React.createElement('h1', { id: 'page-content' }, 'Current route'))
    : route === 'fallback' ? React.createElement(Suspense, { fallback: React.createElement(PageFrame, null, React.createElement(Fixed)) }, React.createElement(Pending))
    : React.createElement(PageFrame, null, React.createElement(Fixed));
  return React.createElement(ProductSessions, { dataScope: scope.read, products: [{ session: { Provider: StepDraftProvider, Notice: StepDraftNotice } }] }, children);
}
setAppearance(new URLSearchParams(location.search).get('theme'));
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

let server, browser, origin;
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'page-frame-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/page-frame.js') return '\0entry';
      if (id.endsWith('/auth/AuthProvider.jsx')) return '\0auth';
      if (id.endsWith('/auth/SignInDoor.jsx')) return '\0door';
      if (id.endsWith('/telemetry/beacon.js')) return '\0events';
    }, load(id) {
      if (id === '\0entry') return entry;
      if (id === '\0auth') return 'export const useAuth = () => ({ status: "ghost", user: null, signOut() {} });';
      if (id === '\0door') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0events') return beacon;
    } }], build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/page-frame.js', output: { entryFileNames: 'entry.js' } } } });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const css = [...files.keys()].find((name) => name.endsWith('.css'));
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(files.get(path) ?? `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"><div id="root"></div><script type="module" src="/entry.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { try { await ready; } finally { await browser?.close(); server?.close(); } });

for (const width of [320, 390, 744, 1440]) for (const theme of ['light', 'dark']) {
  test(`${width}px ${theme}: one retained notice follows actual headers and preserves absent geometry on every frame`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('#page-content').waitFor();
      for (const route of ['shell', 'landing', 'headerless', 'fallback']) {
        await page.evaluate((route) => window.showRoute(route), route);
        await page.locator('#page-content').waitFor();
        const before = await page.locator('#page-content').boundingBox();
        await page.evaluate(() => window.seedDraft());
        await page.locator('.st-draft-notice').waitFor();
        const geometry = await page.evaluate(() => {
          const notice = document.querySelector('.st-draft-notice').getBoundingClientRect();
          const header = document.querySelector('.wm-head, .front-header')?.getBoundingClientRect();
          const content = document.querySelector('#page-content').getBoundingClientRect();
          return { count: document.querySelectorAll('.st-draft-notice').length, height: notice.height, top: notice.top, headerBottom: header?.bottom ?? 0,
            contentTop: content.top, noticeBottom: notice.bottom, text: document.querySelector('.st-draft-notice').innerText };
        });
        assert.deepEqual({ count: geometry.count, height: geometry.height, text: geometry.text }, { count: 1, height: 64, text: 'Roadmap draft\nNot saved\nView draft' });
        assert.equal(geometry.top, geometry.headerBottom, route);
        assert.equal(geometry.contentTop - before.y, 64, route);
        assert.equal(geometry.contentTop >= geometry.noticeBottom, true, route);
        await page.evaluate(() => window.clearDraft());
        await page.locator('.st-draft-notice').waitFor({ state: 'detached' });
        assert.deepEqual(await page.locator('#page-content').boundingBox(), before, route);
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
