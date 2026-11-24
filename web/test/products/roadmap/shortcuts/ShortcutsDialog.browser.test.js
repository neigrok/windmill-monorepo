import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ShortcutsDialog } from '/src/products/roadmap/shortcuts/ShortcutsDialog.jsx';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
const root = createRoot(document.getElementById('root'));
window.events = [];
function Fixture(props) {
  const [open, setOpen] = useState(false);
  useEffect(() => { window.committed = props.revision; }, [props]);
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open shortcuts'),
    React.createElement(ShortcutsDialog, { ...props, open: props.open ?? open, onClose: () => setOpen(false) }));
}
window.paint = (props) => flushSync(() => root.render(React.createElement(Fixture, props)));
`;
let server, browser, webkitBrowser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-shortcuts-test`,
    plugins: [{ name: 'shortcuts-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/shortcuts-entry.js') return '\0shortcuts-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0shortcut-events';
      },
      load(id) {
        if (id === '\0shortcuts-entry') return entry;
        if (id === '\0shortcut-events') return 'export function track(name, props) { window.events.push({ name, props }); } export function reportError(error) { throw error; } export function routeFamily(route) { return route; }';
      },
      configureServer(server) {
        server.middlewares.use('/shortcuts-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html data-brand="roadmap" data-theme="light"><body><div id="root"></div><script type="module" src="/shortcuts-entry.js"></script></body></html>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  const serverReady = once(server.httpServer, 'listening');
  server.httpServer.listen(0, '127.0.0.1');
  await serverReady;
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  webkitBrowser = await webkit.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await webkitBrowser?.close(); await server?.close(); } });

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: shortcuts keep their scroll region keyboard reachable across a coalesced resize`, async () => {
    await ready;
    const [forward, backward] = engine === 'WebKit' ? ['Alt+Tab', 'Alt+Shift+Tab'] : ['Tab', 'Shift+Tab'];
    const page = await (engine === 'Chromium' ? browser : webkitBrowser).newPage({ viewport: { width: 390, height: 500 }, reducedMotion: 'reduce' });
    try {
      await page.goto(`${origin}/shortcuts-test`);
      await page.waitForFunction(() => typeof window.paint === 'function');
      await page.evaluate(() => window.paint({ view: 'board', owner: true, readOnly: true }));
      await page.keyboard.press(forward);
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });
      const body = dialog.getByRole('region');
      await page.waitForFunction(() => document.querySelector('[role="region"]').tabIndex === 0, null, { timeout: 2000 });
      const compact = await body.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight, tabIndex: element.tabIndex }));
      assert.ok(compact.content > compact.height);
      await page.keyboard.press(forward);
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).evaluate((element) => element === document.activeElement), true);
      await body.evaluate(async (element) => {
        const minHeight = element.style.minHeight;
        element.style.minHeight = `${element.scrollHeight}px`;
        window.dispatchEvent(new Event('resize'));
        element.style.minHeight = minHeight;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.deepEqual(await body.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight, tabIndex: element.tabIndex })), compact);
      await page.keyboard.press(backward);
      assert.equal(await body.evaluate((element) => element === document.activeElement), true);
    } finally { await page.close(); }
  });

  for (const width of [390, 1440]) {
    for (const view of ['graph', 'board']) {
      test(`${engine}: shortcuts ${view} ${width}px keeps its header pinned and list keyboard reachable`, async (t) => {
        await ready;
        const [forward, backward] = engine === 'WebKit' ? ['Alt+Tab', 'Alt+Shift+Tab'] : ['Tab', 'Shift+Tab'];
        const page = await (engine === 'Chromium' ? browser : webkitBrowser).newPage({ viewport: { width, height: 500 }, reducedMotion: 'reduce' });
        try {
          await page.goto(`${origin}/shortcuts-test`);
          await page.waitForFunction(() => typeof window.paint === 'function');
          await page.evaluate((props) => {
            document.documentElement.dataset.theme = 'dark';
            window.paint(props);
          }, { view, owner: true, readOnly: width < 744 });
          const opener = page.locator('#opener');
          await page.keyboard.press(forward);
          assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press('Enter');
          const title = view === 'board' ? 'Keyboard shortcuts · Board' : 'Keyboard shortcuts';
          const dialog = page.getByRole('dialog', { name: title, exact: true });
          await dialog.waitFor();
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(document.getAnimations().map((animation) => animation.finished));
          });
          assert.equal(await dialog.evaluate((element) => element === document.activeElement), true);
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 16 && bounds.y >= 16 && bounds.x + bounds.width <= width - 16 && bounds.y + bounds.height <= 484);
          const close = page.getByRole('button', { name: 'Close', exact: true });
          const closeBounds = await close.boundingBox();
          assert.ok(closeBounds.width >= 44 && closeBounds.height >= 44);
          const body = dialog.getByRole('region', { name: title, exact: true });
          assert.equal(await body.evaluate((element) => element.scrollHeight > element.clientHeight), true);
          const header = view === 'graph' ? page.getByRole('group', { name: 'Platform' }) : close;
          const headerBounds = await header.boundingBox();
          await page.keyboard.press(forward);
          assert.equal(await close.evaluate((element) => element === document.activeElement), true);
          const focusRing = await close.evaluate((element) => getComputedStyle(element).boxShadow);
          assert.notEqual(focusRing, 'none');
          if (view === 'graph') {
            await page.keyboard.press(forward);
            assert.equal(await page.getByRole('button', { name: 'Mac', exact: true }).evaluate((element) => element === document.activeElement), true);
            await page.keyboard.press(forward);
            const windows = page.getByRole('button', { name: 'Windows', exact: true });
            assert.equal(await windows.evaluate((element) => element === document.activeElement), true);
            await page.keyboard.press('Space');
            assert.equal(await windows.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.getByRole('button', { name: 'Mac', exact: true }).getAttribute('aria-pressed'), 'false');
            assert.equal(await windows.evaluate((element) => getComputedStyle(element).boxShadow), focusRing);
          }
          await page.keyboard.press(forward);
          assert.equal(await body.evaluate((element) => element === document.activeElement), true);
          assert.equal(await body.evaluate((element) => getComputedStyle(element).transitionProperty), 'none');
          assert.equal(await body.evaluate((element) => getComputedStyle(element).boxShadow), focusRing);
          await page.keyboard.press('PageDown');
          await page.waitForFunction(() => document.querySelector('[role="region"]').scrollTop > 0, null, { timeout: 2000 });
          t.diagnostic(JSON.stringify(await body.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, pageDownTop: element.scrollTop }))));
          await page.keyboard.press('End');
          await page.waitForFunction(() => {
            const body = document.querySelector('[role="region"]');
            return body.scrollHeight - body.scrollTop - body.clientHeight <= 2;
          }, null, { timeout: 2000 });
          const bodyBounds = await body.boundingBox();
          const lastRowBounds = await dialog.locator('.st-sc-row').last().boundingBox();
          assert.ok(lastRowBounds.y >= bodyBounds.y && lastRowBounds.y + lastRowBounds.height <= bodyBounds.y + bodyBounds.height);
          assert.deepEqual(await header.boundingBox(), headerBounds);
          assert.deepEqual(await close.boundingBox(), closeBounds);
          await page.keyboard.press(forward);
          assert.equal(await close.evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press(backward);
          assert.equal(await body.evaluate((element) => element === document.activeElement), true);
          if (process.env.SHORTCUT_CAPTURE_DIR) await page.screenshot({ path: `${process.env.SHORTCUT_CAPTURE_DIR}/${engine}-${view}-${width}-dark-compact.png` });
          await page.keyboard.press(forward);
          for (const height of [1200, 500]) {
            await page.setViewportSize({ width, height });
            await page.waitForFunction(({ width, height }) => {
              const bounds = document.querySelector('[role="dialog"]').getBoundingClientRect();
              const body = document.querySelector('[role="region"]');
              return innerWidth === width && innerHeight === height
                && Math.abs(bounds.x + bounds.width / 2 - width / 2) <= 1
                && Math.abs(bounds.y + bounds.height / 2 - height / 2) <= 1
                && (height !== 500 || body.scrollHeight > body.clientHeight)
                && body.tabIndex === (body.scrollHeight > body.clientHeight ? 0 : -1);
            }, { width, height }, { timeout: 2000 });
          }
          assert.equal(await body.evaluate((element) => element.scrollHeight > element.clientHeight && element.tabIndex === 0), true);
          await page.keyboard.press(backward);
          assert.equal(await body.evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
          assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'roadmap_shortcuts_open', props: { view } }]);
        } finally { await page.close(); }
      });
    }
  }
}

for (const width of [390, 1440]) {
  test(`shortcuts platform controls keep their 44px targets at ${width}px`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width, height: 500 }, reducedMotion: 'reduce' });
    try {
      await page.goto(`${origin}/shortcuts-test`);
      await page.waitForFunction(() => typeof window.paint === 'function');
      await page.evaluate(() => window.paint({ view: 'graph', open: true }));
      await page.getByRole('dialog').waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });
      for (const name of ['Windows', 'Mac']) {
        const button = page.getByRole('button', { name, exact: true });
        const box = await button.boundingBox();
        assert.ok(box.width >= 44);
        assert.equal(await button.evaluate((element) => getComputedStyle(element, '::after').height), '44px');
        await page.mouse.click(box.x + box.width / 2, box.y - 8);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
      }
    } finally { await page.close(); }
  });
}

for (const exit of ['close', 'backdrop']) {
  test(`shortcuts dismiss via ${exit} and return to their opener`, async () => {
    await ready;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/shortcuts-test`);
      await page.waitForFunction(() => typeof window.paint === 'function');
      await page.evaluate(() => window.paint({ view: 'board', owner: false, readOnly: true, graphAvailable: false }));
      await page.locator('#opener').click();
      assert.deepEqual(await page.locator('.st-sc-label').allTextContents(), [
        'Find a step', 'Move between steps', 'Move between columns', 'Open step', 'Close step', 'Keyboard shortcuts',
      ]);
      if (exit === 'close') await page.getByRole('button', { name: 'Close', exact: true }).click();
      else await page.getByRole('dialog').locator('..').click({ position: { x: 1, y: 1 } });
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#opener').evaluate((element) => element === document.activeElement), true);
    } finally { await page.close(); }
  });
}

for (const view of ['graph', 'board']) {
  test(`Chromium: shortcuts ${view} emits its opening event each time it opens`, async () => {
    await ready;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/shortcuts-test`);
      await page.waitForFunction(() => typeof window.paint === 'function');
      const render = async (open, revision) => {
        await page.evaluate((props) => window.paint(props), { view, open, revision });
        await page.waitForFunction((revision) => window.committed === revision, revision);
      };
      await render(false, 1);
      assert.deepEqual(await page.evaluate(() => window.events), []);
      await render(true, 2);
      const opened = [{ name: 'roadmap_shortcuts_open', props: { view } }];
      assert.deepEqual(await page.evaluate(() => window.events), opened);
      await render(true, 3);
      await render(false, 4);
      assert.deepEqual(await page.evaluate(() => window.events), opened);
      await render(true, 5);
      assert.deepEqual(await page.evaluate(() => window.events), [...opened, ...opened]);
    } finally { await page.close(); }
  });
}

for (const width of [390, 744, 1440]) {
  for (const view of ['graph', 'board']) {
    for (const owner of [true, false]) {
      for (const platform of ['MacIntel', 'Win32']) {
        test(`shortcuts reflow: ${view} ${width}px ${owner ? 'owner' : 'reader'} ${platform}`, async () => {
          await ready;
          const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
          try {
            await page.addInitScript((platform) => {
              Object.defineProperty(navigator, 'platform', { value: platform });
              Object.defineProperty(navigator, 'userAgentData', { value: undefined });
            }, platform);
            await page.goto(`${origin}/shortcuts-test`);
            await page.waitForFunction(() => typeof window.paint === 'function');
            await page.evaluate((props) => window.paint(props), { view, owner, readOnly: width < 744 || !owner, open: true });
            await page.getByRole('dialog').waitFor();
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(document.getAnimations().map((animation) => animation.finished));
            });
            const failures = await page.locator('.st-sc-row').evaluateAll((rows) => rows.flatMap((row) => {
              const group = row.closest('.st-sc-group').getBoundingClientRect();
              const label = row.querySelector('.st-sc-label').getBoundingClientRect();
              const keys = row.querySelector('.st-sc-keys').getBoundingClientRect();
              const errors = [];
              if (keys.left < group.left - 1 || keys.right > group.right + 1) errors.push(`${row.textContent}: keys outside group by ${keys.right - group.right}px`);
              if (label.right > keys.left + 1 && label.bottom > keys.top + 1 && keys.bottom > label.top + 1) errors.push(`${row.textContent}: label overlaps keys`);
              return errors;
            }));
            if (process.env.SHORTCUT_CAPTURE_DIR) await page.screenshot({ path: `${process.env.SHORTCUT_CAPTURE_DIR}/${view}-${width}-${owner ? 'owner' : 'reader'}-${platform}.png` });
            assert.deepEqual(failures, []);
            const columns = await page.locator('.st-sc-group').evaluateAll((groups) => new Set(groups.map((group) => group.getBoundingClientRect().left)).size);
            assert.equal(columns, width < 744 ? 1 : 2);
            assert.equal(await page.getByRole('group', { name: 'Platform' }).count(), view === 'graph' ? 1 : 0);
            assert.equal(await page.getByText('Activity feed', { exact: true }).count(), view === 'graph' && owner ? 1 : 0);
            assert.equal(await page.getByText('Complete step', { exact: true }).count(), view === 'board' && owner ? 1 : 0);
            assert.equal(await page.getByText('Ask AI', { exact: true }).count(), width >= 744 && owner ? 1 : 0);
            const keycaps = await page.locator('.st-keycap').allTextContents();
            assert.equal(keycaps.includes('⌘'), platform === 'MacIntel' && (view === 'graph' || (owner && width >= 744)));
            assert.equal(keycaps.includes('Ctrl'), platform === 'Win32' && (view === 'graph' || (owner && width >= 744)));
          } finally { await page.close(); }
        });
      }
    }
  }
}
