import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { parse } from 'acorn';
import { beacon, withBrowserErrors } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog } from '/src/design-system/feedback/Dialog.jsx';
import { ShortcutsDialog } from '/src/products/roadmap/shortcuts/ShortcutsDialog.jsx';
import { ShareDialog } from '/src/products/roadmap/share/ShareDialog.jsx';
import { ForkDoor } from '/src/products/roadmap/share/ForkDoor.jsx';
import { SignInDialog } from '/src/shell/auth/SignInDialog.jsx';
import { FeedbackDialog } from '/src/shell/feedback/FeedbackDialog.jsx';
import { SyncDecisions } from '/src/shell/auth/SyncDecisions.jsx';
import '/src/styles/global.css';
const app = createRoot(document.getElementById('root'));
const e = React.createElement;
function Fixture(props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const common = { open, onClose: close };
  let dialog;
  if (props.kind === 'shortcuts') dialog = e(ShortcutsDialog, common);
  else if (props.kind === 'share') dialog = e(ShareDialog, { ...common, treeId: 'tree', visibility: 'public', mine: true });
  else if (props.kind === 'fork') dialog = e(ForkDoor, { ...common, presentation: 'dialog', signedIn: true, treeId: 'tree' });
  else if (props.kind === 'signin') dialog = e(SignInDialog, { ...common, onSend: async () => {
    if (window.sendError) throw { code: window.sendError };
  } });
  else if (props.kind === 'feedback') dialog = e(FeedbackDialog, common);
  else if (props.kind === 'sync') dialog = open ? e(SyncDecisions, { question: { kind: 'signed-out', count: { page: 1 } },
    work: { type: 'page', one: 'page', many: 'pages' }, onCancel: close, onDecision: close }) : null;
  else dialog = e(Dialog, { ...common, title: props.custom ? undefined : props.title ?? 'Shared dialog',
    labelledBy: props.custom ? 'custom-title' : undefined, onClose: props.empty ? undefined : close,
    footer: props.long ? e('button', { id: 'footer' }, 'Continue') : undefined },
    props.custom && e('h2', { id: 'custom-title' }, props.title ?? 'Custom title'),
    props.long && e('p', { style: { height: 1200 } }, 'Long noninteractive body'),
    !props.empty && !props.long && e(React.Fragment, null,
      e('input', { id: 'first', 'aria-label': 'First', autoFocus: props.autoFocus }),
      e('button', { disabled: true }, 'Disabled'),
      e('button', { style: { display: 'none' } }, 'Hidden'),
      e('div', { inert: '' }, e('button', null, 'Inert')),
      e('button', { style: { visibility: 'hidden' } }, 'Invisible'),
      e('a', { id: 'last', href: '#last', onKeyDown: props.handled ? (event) => { if (event.key === 'Tab') event.preventDefault(); } : undefined }, 'Last')));
  return e(React.Fragment, null, e('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'), dialog);
}
window.paint = (props) => flushSync(() => app.render(e(Fixture, props)));
window.paint({});
`;
let server, browser, origin, browserReady;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-dialog-test`,
    plugins: [{ name: 'shared-dialog-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/dialog-entry.js') return '\0dialog-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0dialog-events';
      },
      load(id) {
        if (id === '\0dialog-entry') return entry;
        if (id === '\0dialog-events') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/dialog-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><div id="root"></div><script type="module" src="/dialog-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
})();
ready.catch(() => {});
after(async () => { await browser?.close(); await server?.close(); });

async function visit(t, props, run) {
  await ready;
  browserReady ??= chromium.launch({ headless: true }).then((launched) => { browser = launched; });
  await browserReady;
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  t.after(() => page.close());
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/dialog-test`);
    await page.waitForFunction(() => typeof window.paint === 'function');
    await page.evaluate((props) => window.paint(props), props);
    await page.locator('#opener').click();
    await page.getByRole('dialog').waitFor();
    await run(page);
  });
}

test('Dialog browser entry compiles through its real Vite virtual-module configuration', async () => {
  await ready;
  const compiled = await server.transformRequest('/dialog-entry.js');
  assert.equal(typeof compiled?.code, 'string');
  assert.doesNotThrow(() => parse(compiled.code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

for (const custom of [false, true]) {
  test(`shared Dialog declaratively names ${custom ? 'custom' : 'built-in'} headings across updates`, async (t) => {
    await visit(t, { custom, title: 'First title' }, async (page) => {
      const dialog = page.getByRole('dialog', { name: 'First title', exact: true });
      const id = await dialog.getAttribute('aria-labelledby');
      assert.equal(await page.locator(`[id="${id}"]`).textContent(), 'First title');
      await page.evaluate((custom) => window.paint({ custom, title: 'Next title' }), custom);
      await page.getByRole('dialog', { name: 'Next title', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').getAttribute('aria-labelledby'), id);
    });
  });
}

test('Dialog preserves initial card focus, wraps both directions, and ignores unavailable controls', async (t) => {
  await visit(t, {}, async (page) => {
    await page.waitForFunction(() => document.activeElement.getAttribute('role') === 'dialog');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'last');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'first');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'last');
  });
});

test('Dialog keeps autofocus and holds focus on its card with no enabled controls', async (t) => {
  await visit(t, { autoFocus: true }, async (page) => {
    await page.waitForFunction(() => document.activeElement.id === 'first');
    await page.evaluate(() => window.paint({ empty: true }));
    await page.waitForFunction(() => document.activeElement.getAttribute('role') === 'dialog');
    for (const key of ['Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'dialog');
    }
  });
});

test('Dialog respects Tab already handled by a child control', async (t) => {
  await visit(t, { handled: true }, async (page) => {
    await page.locator('#last').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'last');
  });
});

test('the noninteractive overflowing body is not a Tab stop and the footer stays reachable', async (t) => {
  await visit(t, { long: true }, async (page) => {
    const scrollBody = page.getByRole('dialog').locator('div[tabindex="-1"]');
    assert.equal(await scrollBody.getAttribute('tabindex'), '-1');
    assert.equal(await scrollBody.evaluate((element) => element.scrollHeight > element.clientHeight), true);
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'footer');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close');
  });
});

for (const exit of ['Escape', 'backdrop', 'Close']) {
  test(`Dialog ${exit} dismissal keeps exact opener return`, async (t) => {
    await visit(t, {}, async (page) => {
      if (exit === 'Escape') await page.keyboard.press('Escape');
      else if (exit === 'backdrop') await page.getByRole('dialog').locator('..').click({ position: { x: 2, y: 2 } });
      else await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.id === 'opener');
    });
  });
}

for (const kind of ['fork', 'shortcuts', 'share', 'signin', 'feedback', 'sync']) {
  test(`production ${kind} consumer has one existing heading label and shared Tab wrap`, async (t) => {
    await visit(t, { kind }, async (page) => {
      const dialog = page.getByRole('dialog');
      const label = await dialog.getAttribute('aria-labelledby');
      assert.equal(typeof label, 'string');
      assert.equal(await page.locator(`[id="${label}"]`).count(), 1);
      assert.notEqual(await page.locator(`[id="${label}"]`).textContent(), '');
      await dialog.focus();
      await page.keyboard.press('Shift+Tab');
      const last = await page.evaluate(() => { window.lastStop = document.activeElement; return document.querySelector('[role="dialog"]').contains(document.activeElement); });
      assert.equal(last, true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement === window.lastStop), true);
    });
  });
}

for (const [error, title] of [[null, 'Check your email'], ['rate_limited', "That's a few links in a row"], ['unreachable', "Can't reach windmill.works"]]) {
  test(`Sign in keeps its heading id through ${error ?? 'sent'} phase`, async (t) => {
    await visit(t, { kind: 'signin' }, async (page) => {
      const label = await page.getByRole('dialog', { name: 'Sign in', exact: true }).getAttribute('aria-labelledby');
      await page.evaluate((error) => { window.sendError = error; }, error);
      await page.locator('input[type="email"]').fill('fixture@example.com');
      await page.getByRole('button', { name: 'Email me a link', exact: true }).click();
      await page.getByRole('dialog', { name: title, exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').getAttribute('aria-labelledby'), label);
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
    });
  });
}
