// The beacon in a real browser, over an intake that answers after a network's delay and, as the stack's proxies do,
// drops a batch whose browser hung up before the answer: an event is delivered when the page navigates, reloads or closes
// right after it, whether it was still queued or already on its way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';

for (const [engine, launcher] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${engine}: an event reaches the intake when the page navigates, reloads or closes right after it`, { timeout: 60_000 }, async (t) => {
    const beacon = await readFile(new URL('../../src/telemetry/beacon.js', import.meta.url), 'utf8');
    const answerMs = 400;
    const delivered = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/v1/events') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        setTimeout(() => {
          if (response.destroyed) return;
          delivered.push(...JSON.parse(Buffer.concat(chunks).toString()).events.map((event) => event.name));
          response.writeHead(202, { 'Content-Type': 'application/json' });
          response.end('{"accepted":1}');
        }, answerMs);
        return;
      }
      const modules = {
        '/telemetry/beacon.js': beacon,
        '/telemetry/sentry.js': 'export const captureError = () => {};',
        '/shell/apiBase.js': "export const API_BASE = '';",
      };
      if (modules[request.url]) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(modules[request.url]);
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>beacon</title><script type="module">
        import { track } from '/telemetry/beacon.js';
        window.track = track;
        window.ready = true;
      </script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await launcher.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();

    const page = async () => {
      const opened = await context.newPage();
      opened.setDefaultTimeout(10_000);
      await opened.goto(`${origin}/room`);
      await opened.waitForFunction(() => window.ready);
      return opened;
    };
    const arrived = async (wanted) => {
      const end = Date.now() + 10_000;
      while (delivered.length < wanted.length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, answerMs + 200));
      return delivered.splice(0).sort();
    };
    const twenty = (name) => Array.from({ length: 20 }, () => name);

    const queuedThenNavigated = await page();
    await queuedThenNavigated.evaluate(() => { track('queued_navigated'); location.assign('/elsewhere'); });
    assert.deepEqual(await arrived(['queued_navigated']), ['queued_navigated'], 'an event still queued leaves as the page navigates');

    const sentThenNavigated = await page();
    await sentThenNavigated.evaluate(() => { for (let index = 0; index < 20; index++) track('sent_navigated'); location.assign('/elsewhere'); });
    assert.deepEqual(await arrived(twenty('sent_navigated')), twenty('sent_navigated'), 'a full batch already on its way arrives though the page navigated');

    const sentThenReloaded = await page();
    await sentThenReloaded.evaluate(() => { for (let index = 0; index < 20; index++) track('sent_reloaded'); });
    await sentThenReloaded.reload();
    assert.deepEqual(await arrived(twenty('sent_reloaded')), twenty('sent_reloaded'), 'a full batch already on its way arrives though the page reloaded');

    const queuedThenClosed = await page();
    await queuedThenClosed.evaluate(() => track('queued_closed'));
    await queuedThenClosed.close({ runBeforeUnload: true });
    assert.deepEqual(await arrived(['queued_closed']), ['queued_closed'], 'an event still queued leaves as the tab closes');

    const sentThenClosed = await page();
    await sentThenClosed.evaluate(() => { for (let index = 0; index < 20; index++) track('sent_closed'); });
    await sentThenClosed.close({ runBeforeUnload: true });
    assert.deepEqual(await arrived(twenty('sent_closed')), twenty('sent_closed'), 'a full batch already on its way arrives though the tab closed');
  });
}
