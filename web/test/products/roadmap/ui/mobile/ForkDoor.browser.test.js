import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../board/composerFixture.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = `
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ForkDoor } from '/src/products/roadmap/ui/mobile/ForkDoor.jsx';
import '/src/styles/tokens/spacing.css';
import '/src/styles/tokens/typography.css';
const root = createRoot(document.getElementById('root'));
window.events = [];
window.requests = [];
window.forkClosed = 0;
window.submitted = 0;
function Fixture(props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => { window.forkClosed += 1; setOpen(false); }, []);
  return <>
    <button id="opener" onClick={() => setOpen(true)}>Open fork</button>
    <button id="outside">Outside</button>
    <ForkDoor {...props} open={open} treeId="sail" stepCount={8} onClose={close}
      onSubmit={() => { window.submitted += 1; }} />
  </>;
}
window.start = (props) => root.render(<Fixture {...props} />);
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
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-fork-door-test`,
    plugins: [{ name: 'fork-door-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/fork-entry.jsx') return '\0fork-entry.jsx';
        if (id.endsWith('/telemetry/beacon.js')) return '\0fork-beacon';
        if (id.endsWith('/auth/AuthClient.js') || id.endsWith('/persistence/TreeRegistry.js')) return '\0fork-transport';
      },
      load(id) {
        if (id === '\0fork-entry.jsx') return entry;
        if (id === '\0fork-beacon') return beacon;
        if (id === '\0fork-transport') return transport;
      },
      configureServer(server) {
        server.middlewares.use('/fork-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><style>*{box-sizing:border-box}body{margin:0}button,input{font:inherit}</style><div id="root"></div><script type="module" src="/fork-entry.jsx"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

async function withDoor(props, run, width = 390) {
  await ready;
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

for (const presentation of ['sheet', 'dialog']) {
  for (const [code, title, body, back] of [
    [null, 'Check your email', 'We sent a link to sailor@example.test. It works once, lasts 15 minutes, and finishes the fork — the copy lands in your trees.', 'Use a different email'],
    ['rate_limited', "That's a few links in a row", 'Check your spam folder first — or try again in 10 minutes. Only the newest link carries this fork.', 'Use a different email'],
    ['unreachable', "Can't reach windmill.works", 'Nothing was sent — try again in a moment.', 'Back'],
  ]) {
    test(`Chromium: Fork ${presentation} preserves sending and ${code ?? 'sent'} copy and events`, async () => {
      await withDoor({ presentation, drawn: true }, async (page) => {
        await page.locator('input').fill('sailor@example.test');
        await page.getByRole('button', { name: 'Email me a link', exact: true }).click();
        const sending = page.getByRole('button', { name: 'Sending…', exact: true });
        await sending.waitFor();
        assert.equal(await sending.isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => window.requests), [{ address: 'sailor@example.test', options: { forkOf: 'sail' } }]);
        assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'fork_attempt', props: { mode: 'email' } }]);
        await page.evaluate((code) => window.finishEmail(code), code);
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        await page.getByRole('dialog', { name: title, exact: true }).waitFor();
        assert.equal(await page.locator('[role="dialog"] p').textContent(), body);
        assert.equal(await page.evaluate(() => window.submitted), code === null ? 1 : 0);
        assert.equal(await page.locator('[role="dialog"]').evaluate((element) => element.contains(document.activeElement)), true);
        await page.getByRole('button', { name: back, exact: true }).click();
        await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
        assert.equal(await page.locator('input').inputValue(), 'sailor@example.test');
      });
    });
  }

  test(`Chromium: Fork ${presentation} never dismisses the instant fork in flight and keeps error recovery`, async () => {
    await withDoor({ presentation, drawn: true, signedIn: true }, async (page) => {
      await page.getByRole('button', { name: 'Fork this tree', exact: true }).click();
      const busy = page.getByRole('button', { name: 'Forking…', exact: true });
      await busy.waitFor();
      assert.equal(await busy.isDisabled(), true);
      await page.keyboard.press('Escape');
      if (presentation === 'dialog') await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.mouse.click(2, 2);
      assert.equal(await page.evaluate(() => window.forkClosed), 0);
      assert.equal(await page.getByRole('dialog').count(), 1);
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
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.id === 'opener');
    });
  });
}
