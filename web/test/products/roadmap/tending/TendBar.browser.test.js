import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ASK_AI_PLACEHOLDER } from '../../../../src/products/roadmap/copy.js';
import { withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { TendBar } from '/src/products/roadmap/tending/TendBar.jsx';
import { ASK_AI_PLACEHOLDER } from '/src/products/roadmap/copy.js';
window.submitted = [];
window.dismissed = 0;
const query = new URLSearchParams(location.search);
const presentation = query.get('presentation') ?? 'overlay';
if (presentation === 'docked') {
  const visible = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: innerWidth, height: 592 });
  Object.defineProperty(window, 'visualViewport', { value: visible, configurable: true });
  window.resizeKeyboard = (height) => { visible.height = height; visible.dispatchEvent(new Event('resize')); };
}
const root = createRoot(document.getElementById('root'));
document.getElementById('opener').focus();
function Fixture() {
  const [value, onChange] = React.useState('');
  const [open, setOpen] = React.useState(true);
  window.reopen = () => setOpen(true);
  return open ? React.createElement(TendBar, {
  value, onChange,
  examples: ['Is this realistic?', 'What am I missing?'],
  presentation,
  topInset: Number(query.get('topInset') ?? 173),
  placeholder: ASK_AI_PLACEHOLDER[query.get('empty') ? 'empty' : presentation === 'docked' ? 'phone' : 'wide'],
  portalTarget: document.body,
  onSubmit(value) { window.submitted.push(value); setOpen(false); },
  onDismiss() { window.dismissed += 1; setOpen(false); },
}) : null;
}
root.render(React.createElement(Fixture));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-tend-band-test`,
    plugins: [{ name: 'tend-band-test',
      resolveId(id) { if (id === '/tend-band-entry.js') return '\0tend-band-entry'; },
      load(id) { if (id === '\0tend-band-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/tend-band-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><button id="opener">Roadmap</button><div id="root"></div><script type="module" src="/tend-band-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

for (const width of [320, 390, 744]) {
  test(`Chromium: the shipped Ask AI overlay fits and accepts input at ${width}px`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/tend-band-test?presentation=overlay`);
      const input = page.getByRole('textbox', { name: 'Tell the tree what to change' });
      await input.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
      const geometry = await page.locator('form').evaluate((form) => {
        const box = form.getBoundingClientRect();
        return {
          fits: box.left >= 0 && box.right <= innerWidth,
          controlsFit: [...form.querySelectorAll('button,input')].every((element) => {
            const control = element.getBoundingClientRect();
            return control.left >= box.left && control.right <= box.right && control.width > 0;
          }),
          width: box.width,
        };
      });
      assert.deepEqual(geometry, { fits: true, controlsFit: true, width: Math.min(560, width - 48) });
      await input.fill('Add a practice step');
      await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.submitted), ['Add a practice step']);
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.dismissed), 0);
      });
    } finally {
      await page.close();
    }
  });
}

for (const width of [320, 390]) {
  for (const close of ['Escape', 'scrim']) {
    test(`Chromium: docked Ask AI at ${width}px follows the keyboard and closes by ${close}`, async () => {
      await ready;
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await withBrowserErrors(page, async () => {
          await page.goto(`${origin}/tend-band-test?presentation=docked`);
          const input = page.getByRole('textbox', { name: 'Tell the tree what to change' });
          await input.waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
          assert.equal(await input.getAttribute('placeholder'), ASK_AI_PLACEHOLDER.phone);
          assert.equal(await page.getByRole('dialog', { name: 'Ask AI' }).getAttribute('aria-modal'), 'true');
          const geometry = () => page.locator('form').evaluate((form) => {
            const box = form.getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom };
          });
          assert.deepEqual(await geometry(), { left: 12, right: width - 12, bottom: 580 });
          await page.evaluate(() => window.resizeKeyboard(500));
          await page.waitForFunction(() => document.querySelector('form').getBoundingClientRect().bottom === 488);
          assert.deepEqual(await geometry(), { left: 12, right: width - 12, bottom: 488 });
          await input.fill('Add a practice step');
          assert.equal(await page.getByRole('button', { name: 'Is this realistic?' }).count(), 0);
          await input.press('Shift+Tab');
          assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Ask AI');
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
          if (close === 'Escape') await input.press('Escape');
          if (close === 'scrim') {
            await page.mouse.move(4, 4);
            await page.mouse.down();
            assert.equal(await page.getByRole('dialog').count(), 1);
            assert.equal(await page.evaluate(() => window.dismissed), 0);
            await page.mouse.up();
          }
          await page.getByRole('dialog').waitFor({ state: 'detached' });
          assert.deepEqual(await page.evaluate(() => ({ dismissed: window.dismissed, submitted: window.submitted, focus: document.activeElement.id })), {
            dismissed: 1, submitted: [], focus: 'opener',
          });
        });
      } finally {
        await page.close();
      }
    });
  }
}

test('Chromium: the 744 overlay sits beneath the row and the empty roadmap keeps its placeholder', async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 744, height: 960 } });
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/tend-band-test?presentation=overlay`);
      await page.getByRole('dialog', { name: 'Ask AI' }).waitFor();
      assert.deepEqual(await page.locator('form').evaluate((form) => {
        const box = form.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width };
      }), { left: 92, top: 173, width: 560 });
      assert.equal(await page.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.wide);
      await page.goto(`${origin}/tend-band-test?presentation=overlay&topInset=201`);
      await page.getByRole('dialog', { name: 'Ask AI' }).waitFor();
      assert.equal(await page.locator('form').evaluate((form) => form.getBoundingClientRect().top), 201);
      await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
      await page.goto(`${origin}/tend-band-test?presentation=docked&empty=1`);
      await page.getByRole('dialog', { name: 'Ask AI' }).waitFor();
      assert.equal(await page.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.empty);
    });
  } finally {
    await page.close();
  }
});

for (const presentation of ['docked', 'overlay']) {
  test(`Chromium: ${presentation} Ask AI closes on submit and restores its controlled sentence when reopened`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/tend-band-test?presentation=${presentation}`);
        const input = page.getByRole('textbox', { name: 'Tell the tree what to change' });
        await input.fill('  Add a practice step  ');
        await input.press('Enter');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        await page.evaluate(() => window.reopen());
        await input.waitFor();
        assert.equal(await input.inputValue(), '  Add a practice step  ');
        assert.deepEqual(await page.locator('.st-tend-spoken').evaluate((element) => ({
          width: getComputedStyle(element).width, height: getComputedStyle(element).height, overflow: getComputedStyle(element).overflow,
        })), { width: '1px', height: '1px', overflow: 'hidden' });
        assert.deepEqual(await page.evaluate(() => ({ submitted: window.submitted, dismissed: window.dismissed })),
          { submitted: ['  Add a practice step  '], dismissed: 0 });
      });
    } finally { await page.close(); }
  });
}
