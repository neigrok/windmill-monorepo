import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';

for (const [engine, launcher] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${engine}: native indexed traversal withholds transient routes and preserves the first destination and Forward`, { timeout: 30000 }, async (t) => {
    const source = await readFile(new URL('../../src/shell/navigation.js', import.meta.url), 'utf8');
    const server = createServer((request, response) => {
      if (request.url === '/shell/navigation.js') {
        response.setHeader('Content-Type', 'text/javascript'); response.end(source); return;
      }
      if (request.url === '/telemetry/sentry.js') {
        response.setHeader('Content-Type', 'text/javascript'); response.end('export const captureError = (...args) => window.failures.push(args);'); return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><output></output><script type="module">
        import { createNavigationCoordinator } from '/shell/navigation.js';
        window.failures = []; window.notices = []; window.publications = []; window.order = [];
        window.nav = createNavigationCoordinator(window);
        window.nativeEvents = 0; window.addEventListener('popstate', () => nativeEvents += 1);
        nav.subscribe((entry) => { publications.push(entry); order.push('publish'); document.querySelector('output').textContent = entry.hash; });
        window.arm = () => nav.register({ blocked: () => true,
          onBlocked: (notice) => notices.push(notice),
          onUnrestorableNavigation: () => { order.push('retain'); window.retained = 'local draft'; }
        });
        window.ready = true;
      </script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await launcher.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.ready);
    const ids = await page.evaluate(async () => {
      await nav.request({ key: 'base', run: (tx) => tx.navigate('#/base') });
      await nav.request({ key: 'selection', run: (tx) => tx.pushEntry(tx.read().href, { ...tx.read().state, boardSelection: { token: 'visit', kinds: false } }) });
      const selected = nav.read().state.windmillHistory.entryId;
      await nav.request({ key: 'kinds', run: (tx) => tx.pushEntry(tx.read().href, { ...tx.read().state, boardSelection: { token: 'visit', kinds: true } }) });
      const origin = nav.read().state.windmillHistory.entryId;
      arm(); publications.length = 0;
      return { selected, origin, length: history.length };
    });
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => notices.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ accepted: nav.read().state.windmillHistory.entryId, actual: history.state.windmillHistory.entryId, publications: publications.length })), { accepted: ids.origin, actual: ids.origin, publications: 0 });
    await page.evaluate(() => notices[0].cancel());
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => notices.length === 2);
    const beforeRepeat = await page.evaluate(() => { const count = nativeEvents; history.go(-2); return count; });
    await page.waitForFunction(({ origin, count }) => nativeEvents >= count + 2 && history.state.windmillHistory.entryId === origin, { origin: ids.origin, count: beforeRepeat });
    await page.evaluate(() => notices[1].proceed());
    await page.waitForFunction((selected) => nav.read().state.windmillHistory.entryId === selected, ids.selected);
    assert.deepEqual(await page.evaluate(() => ({ count: publications.length, notices: notices.length, length: history.length, state: nav.read().state.boardSelection })), { count: 1, notices: 2, length: ids.length, state: { token: 'visit', kinds: false } });
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => notices.length === 3);
    await page.evaluate(() => notices[2].proceed());
    await page.waitForFunction((origin) => nav.read().state.windmillHistory.entryId === origin, ids.origin);
    assert.equal(await page.evaluate(() => publications.length), 2);

    const oldChain = await page.evaluate(() => nav.read().state.windmillHistory.chain);
    await page.evaluate(() => { order.length = 0; location.hash = '#native'; });
    await page.waitForFunction(() => nav.read().hash === '#native');
    assert.deepEqual(await page.evaluate(() => ({ order, retained, position: nav.read().state.windmillHistory.position, hash: document.querySelector('output').textContent })), { order: ['retain', 'publish'], retained: 'local draft', position: 0, hash: '#native' });
    assert.notEqual(await page.evaluate(() => nav.read().state.windmillHistory.chain), oldChain);
    assert.deepEqual(await page.evaluate(() => failures), []);
    assert.deepEqual(errors, []);
  });
}
