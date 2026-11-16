import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';

for (const [engine, launcher] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${engine}: navigation restoration races`, { timeout: 30000 }, async (t) => {
    const source = await readFile(new URL('../../src/shell/navigation.js', import.meta.url), 'utf8');
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/html');
      if (request.url === '/shell/navigation.js') { response.end(source); return; }
      if (request.url === '/telemetry/sentry.js') { response.end('export const captureError = () => {};'); return; }
      response.end(`<!doctype html><script type="module">
        import { createNavigationCoordinator } from '/shell/navigation.js';
        window.reports = []; window.notices = []; window.publications = []; window.retains = 0;
        window.nav = createNavigationCoordinator(window, { timeout: 300, report: (operation) => reports.push(operation) });
        nav.subscribe((entry) => publications.push(entry));
        window.arm = () => { window.release = nav.register({ blocked: () => true,
          onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation: () => { retains += 1; }
        }); };
        window.ready = true;
      </script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await launcher.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const fixture = `http://127.0.0.1:${server.address().port}/fixture`;

    await t.test('async update, push and replace during restoration commit once without changing a prior entry', async () => {
      await page.goto(fixture); await page.waitForFunction(() => window.ready);
      const expected = await page.evaluate(async () => {
        const prior = nav.read();
        await nav.request({ key: 'origin', run: (tx) => tx.pushEntry('#/origin', { owner: 'origin' }) });
        const origin = nav.read();
        arm(); publications.length = 0;
        window.result = nav.request({ key: 'async', run: async (tx) => {
          await new Promise((resolve) => { window.finish = resolve; });
          tx.updateState((state) => ({ ...state, departure: true }));
          tx.pushEntry('#/destination', { arrival: true });
          tx.updateState((state) => ({ ...state, complete: true }));
          tx.replaceEntry('/app', { ...tx.read().state, replaced: true });
          return 7;
        } });
        notices[0].proceed(); notices[0].cancel();
        window.addEventListener('popstate', () => finish(), { once: true });
        history.back();
        const completion = await result;
        return { completion, prior, origin };
      });
      await page.waitForTimeout(400);
      const actual = await page.evaluate(() => ({ href: location.href, accepted: nav.read(), reports, retains, publications: publications.length, length: history.length }));
      assert.deepEqual(expected.completion, { status: 'completed', value: 7 });
      assert.equal(actual.href, actual.accepted.href);
      assert.equal(actual.accepted.pathname, '/app');
      assert.deepEqual({ reports: actual.reports, retains: actual.retains, publications: actual.publications }, { reports: [], retains: 0, publications: 1 });
      assert.deepEqual(actual.accepted.state, { arrival: true, complete: true, replaced: true, windmillHistory: {
        ...expected.origin.state.windmillHistory, position: expected.origin.state.windmillHistory.position + 1, entryId: actual.accepted.state.windmillHistory.entryId,
      } });
      const previous = await page.evaluate(async () => {
        release();
        await nav.request({ key: 'origin', run: (tx) => tx.traverse(-1) });
        const origin = nav.read();
        await nav.request({ key: 'prior', run: (tx) => tx.traverse(-1) });
        return { origin, prior: nav.read() };
      });
      assert.deepEqual(previous.origin.state, { ...expected.origin.state, departure: true });
      assert.deepEqual({ href: previous.prior.href, state: previous.prior.state }, { href: expected.prior.href, state: expected.prior.state });
    });

    for (const count of [2, 4]) {
      await t.test(`${count} queued Back calls preserve the origin and first target`, async () => {
        await page.goto(fixture); await page.waitForFunction(() => window.ready);
        const origin = await page.evaluate(async (count) => {
          for (let i = 1; i <= 6; i += 1) await nav.request({ key: String(i), run: (tx) => tx.navigate(`#/${i}`) });
          const origin = nav.read();
          arm(); publications.length = 0;
          for (let i = 0; i < count; i += 1) history.back();
          return origin;
        }, count);
        await page.waitForFunction(() => notices.length === 1 && history.state.windmillHistory.entryId === nav.read().state.windmillHistory.entryId);
        await page.waitForTimeout(400);
        assert.deepEqual(await page.evaluate(() => ({ href: location.href, accepted: nav.read().href, notices: notices.length, retains, reports, publications: publications.length })),
          { href: origin.href, accepted: origin.href, notices: 1, retains: 0, reports: [], publications: 0 });
        await page.evaluate(() => notices[0].proceed());
        await page.waitForFunction(() => nav.read().hash === '#/5');
        assert.deepEqual(await page.evaluate(() => ({ actual: location.hash, accepted: nav.read().hash, publications: publications.length })),
          { actual: '#/5', accepted: '#/5', publications: 1 });
      });
    }

    await t.test('interleaved Back and Forward converge or retain safely within the original deadline', async () => {
      await page.goto(fixture); await page.waitForFunction(() => window.ready);
      const origin = await page.evaluate(async () => {
        for (let i = 1; i <= 6; i += 1) await nav.request({ key: String(i), run: (tx) => tx.navigate(`#/${i}`) });
        const origin = nav.read();
        arm(); publications.length = 0;
        history.back(); history.back(); history.forward(); history.back();
        return origin;
      });
      await page.waitForTimeout(500);
      const actual = await page.evaluate(() => ({ href: location.href, accepted: nav.read(), notices: notices.length, retains, reports, publications: publications.length }));
      assert.equal(actual.href, actual.accepted.href);
      if (actual.retains === 0) {
        assert.deepEqual({ href: actual.href, notices: actual.notices, reports: actual.reports, publications: actual.publications },
          { href: origin.href, notices: 1, reports: [], publications: 0 });
      } else {
        assert.deepEqual({ retains: actual.retains, reports: actual.reports, publications: actual.publications, position: actual.accepted.state.windmillHistory.position },
          { retains: 1, reports: ['navigation-restore'], publications: 1, position: 0 });
        assert.notEqual(actual.accepted.state.windmillHistory.chain, origin.state.windmillHistory.chain);
      }
    });
    await t.test("a zero-effect completion settles during another action's traversal", async () => {
      await page.goto(fixture); await page.waitForFunction(() => window.ready);
      const actual = await page.evaluate(async () => {
        await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
        window.completion = null;
        nav.request({ key: 'async', run: async () => {
          await new Promise((resolve) => { window.finish = resolve; });
          return 7;
        } }).then((value) => { window.completion = value; });
        const back = nav.request({ key: 'back', run: (tx) => tx.traverse(-1) });
        finish(); await back;
        return { completion, actual: location.pathname + location.hash, accepted: nav.read().pathname + nav.read().hash, reports };
      });
      assert.deepEqual(actual, { completion: { status: 'completed', value: 7 }, actual: '/fixture', accepted: '/fixture', reports: [] });
    });

    await t.test('rejection during restoration publishes applied history before cancellation', async () => {
      await page.goto(fixture); await page.waitForFunction(() => window.ready);
      const actual = await page.evaluate(async () => {
        window.order = [];
        nav.subscribe((entry) => order.push(['publish', entry.hash]));
        nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() {} });
        const result = nav.request({ key: 'async', run: (tx) => {
          window.transaction = tx;
          tx.navigate('#/working');
          return new Promise((resolve, reject) => { window.fail = reject; });
        } });
        result.then((value) => order.push(['settle', value]));
        addEventListener('popstate', () => {
          transaction.navigate('#/unapplied');
          fail(new Error('private failure'));
        }, { once: true });
        history.back();
        const completion = await result;
        return { completion, actual: location.hash, accepted: nav.read().hash, reports, order };
      });
      assert.deepEqual(actual, { completion: { status: 'cancelled' }, actual: '#/working', accepted: '#/working',
        reports: ['navigation-commit'], order: [['publish', '#/working'], ['settle', { status: 'cancelled' }]] });
    });

    for (const outcome of ['success', 'failure']) {
      await t.test(`an older applied ${outcome} cannot publish over newer navigation`, async () => {
        await page.goto(fixture); await page.waitForFunction(() => window.ready);
        const actual = await page.evaluate(async (outcome) => {
          const old = nav.request({ key: 'old', run: (tx) => {
            tx.navigate('#/old');
            return new Promise((resolve, reject) => { window.finish = resolve; window.fail = reject; });
          } });
          await nav.request({ key: 'new', run: (tx) => tx.navigate('#/new') });
          const count = publications.length;
          if (outcome === 'success') finish(7);
          else fail(new Error('private failure'));
          const completion = await old;
          return { completion, actual: location.hash, accepted: nav.read().hash, extraPublications: publications.length - count, reports };
        }, outcome);
        assert.deepEqual(actual, { completion: { status: 'cancelled' }, actual: '#/new', accepted: '#/new', extraPublications: 0,
          reports: outcome === 'failure' ? ['navigation-commit'] : [] });
      });
    }

    await t.test('unknown fallback settles all active actions and late rejection remains static', async () => {
      await page.goto(fixture); await page.waitForFunction(() => window.ready);
      const actual = await page.evaluate(async () => {
        await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
        const old = nav.request({ key: 'old', run: (tx) => {
          window.transaction = tx;
          return new Promise((resolve, reject) => { window.fail = reject; });
        } });
        const back = nav.request({ key: 'back', run: (tx) => tx.traverse(-1) });
        history.pushState(null, '', '#/unknown');
        dispatchEvent(new PopStateEvent('popstate'));
        const completions = await Promise.all([old, back]);
        transaction.navigate('#/revoked');
        fail(new Error('private failure'));
        await Promise.resolve();
        return { completions, reports };
      });
      assert.deepEqual(actual, { completions: [{ status: 'cancelled' }, { status: 'cancelled' }], reports: ['navigation-commit'] });
      await page.waitForTimeout(400);
      const current = await page.evaluate(() => ({ actual: location.href, accepted: nav.read().href }));
      assert.equal(current.actual, current.accepted);
      assert.equal(current.actual.includes('#/revoked'), false);
    });

    assert.deepEqual(errors, []);
  });
}
