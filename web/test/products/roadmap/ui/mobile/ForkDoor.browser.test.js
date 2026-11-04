import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { parse } from 'acorn';
import { beacon, withBrowserErrors } from '../../board/composerFixture.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = `
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ForkDoor } from '/src/products/roadmap/ui/mobile/ForkDoor.jsx';
import '/src/styles/global.css';
const root = createRoot(document.getElementById('root'));
window.events = [];
window.requests = [];
window.forkClosed = 0;
window.submitted = 0;
function Fixture(props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => { window.forkClosed += 1; setOpen(false); }, []);
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open fork'),
    React.createElement('button', { id: 'outside' }, 'Outside'),
    React.createElement(ForkDoor, { ...props, open, treeId: 'sail', stepCount: 8, onClose: close,
      onSubmit: () => { window.submitted += 1; } }),
  );
}
window.start = (props) => root.render(React.createElement(Fixture, props));
`;
const transport = `
export function requestMagicLink(address, options) {
  window.requests.push({ address, options });
  return new Promise((resolve, reject) => { window.finishEmail = (code) => code ? reject({ code }) : resolve(); });
}
export function forkTree(treeId) {
  window.requests.push({ treeId });
  return new Promise((resolve, reject) => { window.finishFork = (code) => code ? reject({ code }) : resolve({ treeId: 'copy' }); });
}
`;
let server, browser, origin, browserReady;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-fork-door-test`,
    plugins: [{ name: 'fork-door-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/fork-entry.js') return '\0fork-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0fork-beacon';
        if (id.endsWith('/auth/AuthClient.js') || id.endsWith('/persistence/TreeRegistry.js')) return '\0fork-transport';
      },
      load(id) {
        if (id === '\0fork-entry') return entry;
        if (id === '\0fork-beacon') return beacon;
        if (id === '\0fork-transport') return transport;
      },
      configureServer(server) {
        server.middlewares.use('/fork-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><style>*{box-sizing:border-box}body{margin:0}button,input{font:inherit}</style><div id="root"></div><script type="module" src="/fork-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

async function withDoor(props, run, width = 390) {
  await ready;
  browserReady ??= chromium.launch({ headless: true }).then((launched) => { browser = launched; });
  await browserReady;
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/fork-test`);
      await page.waitForFunction(() => typeof window.start === 'function');
      await page.evaluate((props) => window.start(props), props);
      await page.locator('#opener').click();
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      await run(page);
    });
  } finally { await page.close(); }
}

test('Fork browser entry compiles through its real Vite virtual-module configuration', async () => {
  await ready;
  const compiled = await server.transformRequest('/fork-entry.js');
  assert.equal(typeof compiled?.code, 'string');
  assert.doesNotThrow(() => parse(compiled.code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

for (const props of [
  { presentation: 'sheet', drawn: true },
  { presentation: 'dialog', drawn: true },
  { presentation: 'dialog', drawn: false },
]) {
  test(`Chromium: Fork ${props.presentation}, drawn ${props.drawn}, labels, wraps focus and restores its opener`, async () => {
    await withDoor(props, async (page) => {
      const dialog = page.getByRole('dialog', { name: 'Make it yours', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
      assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
      const first = props.presentation === 'dialog' ? page.getByRole('button', { name: 'Close', exact: true }) : page.locator('input');
      const last = page.getByRole('button', { name: 'Email me a link', exact: true });
      await first.focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await last.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await first.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.id === 'opener');
      assert.equal(await page.evaluate(() => window.forkClosed), 1);
    });
  });
}

for (const width of [744, 1024, 1440]) {
  test(`Chromium: the production Fork dialog is centered at ${width}`, async () => {
    await withDoor({ presentation: 'dialog', drawn: false }, async (page) => {
      const box = await page.getByRole('dialog', { name: 'Make it yours', exact: true }).boundingBox();
      assert.equal(box.width, 406);
      assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 1);
    }, width);
  });
}

for (const { presentation, drawn } of [
  { presentation: 'sheet', drawn: true },
  { presentation: 'sheet', drawn: false },
  { presentation: 'dialog', drawn: true },
  { presentation: 'dialog', drawn: false },
]) {
  const modal = drawn || presentation === 'dialog';
  for (const [code, title, body, back] of [
    [null, 'Check your email', 'We sent a link to sailor@example.test. It works once, lasts 15 minutes, and finishes the fork — the copy lands in your trees.', 'Use a different email'],
    ['rate_limited', "That's a few links in a row", 'Check your spam folder first — or try again in 10 minutes. Only the newest link carries this fork.', 'Use a different email'],
    ['unreachable', "Can't reach windmill.works", 'Nothing was sent — try again in a moment.', 'Back'],
  ]) {
    test(`Chromium: Fork ${presentation}, drawn ${drawn}, preserves sending and ${code ?? 'sent'} copy and events`, async () => {
      await withDoor({ presentation, drawn }, async (page) => {
        const titleId = await page.getByRole('heading', { name: 'Make it yours', exact: true }).getAttribute('id');
        await page.locator('input').fill('sailor@example.test');
        await page.getByRole('button', { name: 'Email me a link', exact: true }).click();
        const sending = page.getByRole('button', { name: 'Sending…', exact: true });
        await sending.waitFor();
        assert.equal(await sending.isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => window.requests), [{ address: 'sailor@example.test', options: { forkOf: 'sail' } }]);
        assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'fork_attempt', props: { mode: 'email' } }]);
        await page.evaluate((code) => window.finishEmail(code), code);
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        const heading = page.getByRole('heading', { name: title, exact: true });
        assert.equal(await heading.getAttribute('id'), titleId);
        if (modal) {
          const surface = page.getByRole('dialog', { name: title, exact: true });
          await surface.waitFor();
          assert.equal(await surface.getAttribute('aria-labelledby'), titleId);
        }
        assert.equal(await heading.locator('..').locator('p').textContent(), body);
        assert.equal(await page.evaluate(() => window.submitted), code === null ? 1 : 0);
        if (modal) {
          await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
          assert.equal(await page.getByRole('dialog').evaluate((element) => element.contains(document.activeElement)), true);
        }
        await page.getByRole('button', { name: back, exact: true }).click();
        await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Make it yours', exact: true }).getAttribute('id'), titleId);
        assert.equal(await page.locator('input').inputValue(), 'sailor@example.test');
      });
    });
  }

  test(`Chromium: Fork ${presentation}, drawn ${drawn}, never dismisses the instant fork in flight and keeps error recovery`, async () => {
    await withDoor({ presentation, drawn, signedIn: true }, async (page) => {
      await page.getByRole('button', { name: 'Fork this tree', exact: true }).click();
      const busy = page.getByRole('button', { name: 'Forking…', exact: true });
      await busy.waitFor();
      assert.equal(await busy.isDisabled(), true);
      await page.keyboard.press('Escape');
      if (presentation === 'dialog') await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.mouse.click(2, 2);
      assert.equal(await page.evaluate(() => window.forkClosed), 0);
      assert.equal(await page.getByRole('dialog').count(), modal ? 1 : 0);
      assert.equal(await busy.count(), 1);
      assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'fork_attempt', props: { mode: 'instant' } }]);
      await page.evaluate(() => window.finishFork('server_error'));
      await page.getByText("Couldn't fork just now — try again in a moment.", { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Fork this tree', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: 'Fork this tree', exact: true }).click();
      await busy.waitFor();
      await page.evaluate(() => window.finishFork('unauthenticated'));
      await page.getByText('Your session expired — the email door still works.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Email me a link', exact: true }).count(), 1);
      await page.keyboard.press('Escape');
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor({ state: 'detached' });
      if (modal) await page.waitForFunction(() => document.activeElement.id === 'opener');
    });
  });
}


test('Chromium: the drawn sheet uses the canon brand focus ring on keyboard opening', async () => {
  await withDoor({ presentation: 'sheet', drawn: true }, async (page) => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('#opener').focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Make it yours', exact: true });
    await sheet.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('.st-fork-sheet:focus-visible'));
    assert.deepEqual(await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      const sample = document.createElement('span');
      sample.style.color = 'var(--color-brand)';
      element.append(sample);
      const brand = getComputedStyle(sample).color;
      sample.remove();
      return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, brand: style.outlineColor === brand };
    }), { style: 'solid', width: '2px', offset: '2px', brand: true });
  });
});
