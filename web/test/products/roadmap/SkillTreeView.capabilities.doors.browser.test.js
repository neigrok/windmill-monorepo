// §2.5 of the wave-8 architecture: the device line and the demo's badge have their homes, and an open is never called a plant.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ANONYMOUS_OWNER, DEMO_BYLINE, LAPSED_SESSION } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost();

const everyWidth = [320, 390, 744, 1440];

for (const [population, options] of [['an owner', {}], ['a reader', { role: 'reader' }], ['the demo', { role: 'reader', demo: true }]]) {
  hostTest(`Copy honesty: opening a roadmap never tells ${population} it was planted`, async () => {
    const { page, errors } = await openHost(options);
    try {
      await page.waitForFunction(() => window.scene?.nodesById?.size > 0);
      assert.equal(await page.evaluate(() => window.arrivalSummary ?? null), null);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const [plant, flags, summary] of [
  ['a planted roadmap', { 'windmill:born': 't_sail' }, 'Roadmap planted · 3 steps · 1 already done'],
  ['a planted quest', { 'windmill:born': 't_sail', 'windmill:planted-quest': '1' }, 'Quest planted · 3 steps · 1 already done'],
]) {
  hostTest(`Motion canon §7 #3: ${plant} fits the whole tree, arrives on the Graph and says so`, async () => {
    const { page, errors } = await openHost({});
    try {
      await page.evaluate((notes) => {
        window.arrivalSuppressed = undefined;
        for (const [key, value] of Object.entries(notes)) sessionStorage.setItem(key, value);
      }, flags);
      await page.reload();
      await page.waitForFunction(() => window.scene?.nodesById?.size > 0);
      await page.locator('.st-roadmap-identity[data-view="tree"]').waitFor();
      assert.deepEqual(await page.evaluate(() => ({
        summary: window.arrivalSummary, suppressed: window.arrivalSuppressed ?? false,
        born: sessionStorage.getItem('windmill:born'), quest: sessionStorage.getItem('windmill:planted-quest'),
      })), { summary, suppressed: false, born: null, quest: null });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Motion canon: an owner\'s plain first visit opens on the frontier, with no arrival to say anything', async () => {
  const { page, errors } = await openHost({});
  try {
    assert.deepEqual(await page.evaluate(() => ({ summary: window.arrivalSummary ?? null, suppressed: window.arrivalSuppressed })), { summary: null, suppressed: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [view, surface] of [['Board', 'board'], ['Graph', 'tree']]) {
  hostTest(`04.09: a fresh fork says what happened once, on the ${view} it opens`, async () => {
    const { page, errors } = await openHost({ surface });
    try {
      await page.evaluate(() => sessionStorage.setItem('windmill:forked-from-demo', '1'));
      await page.reload();
      const toast = page.locator('.st-board-toast');
      await toast.waitFor();
      assert.equal(await toast.locator('.st-board-toast-message').textContent(), 'Forked — 3 steps planted');
      assert.equal(await toast.locator('.st-board-toast-undo').count(), 0);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('windmill:forked-from-demo')), null);
      assert.equal(await page.evaluate(() => window.arrivalSummary ?? null), null);
      await page.reload();
      await page.waitForFunction(() => window.scene?.nodesById?.size > 0);
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.st-board-toast').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of everyWidth) {
  hostTest(`§2.5 Saved on this device / lapsed: the device line at ${width}px on Board and Graph`, async () => {
    for (const surface of ['board', 'tree']) {
      const { page, errors } = await openHost({ width, role: 'ghost', surface, shell: true });
      try {
        if (width < 744) {
          await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).click();
          assert.equal(await page.evaluate(() => window.signInOpened), 1);
        } else {
          await page.getByRole('status').filter({ hasText: ANONYMOUS_OWNER }).waitFor();
        }
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  hostTest(`§2.5 Saved on this device / lapsed: a lapsed session keeps its line at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(async () => {
        window.session.receiveReject({ code: 'sign-in-required' });
        await Promise.resolve();
        window.setFixtureAuth('ghost');
      });
      const line = width < 744 ? page.getByRole('button', { name: LAPSED_SESSION, exact: true }) : page.getByRole('status').filter({ hasText: LAPSED_SESSION });
      await line.waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo plaque byline (G11): the sample badge at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true });
    try {
      const row = page.locator('.st-roadmap-identity[data-role="demo"]');
      await row.waitFor();
      assert.equal(await row.locator('.st-roadmap-sample').textContent(), width < 744 ? DEMO_BYLINE.phone : DEMO_BYLINE.wide);
      assert.equal(await page.getByText('Windmill demo').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
