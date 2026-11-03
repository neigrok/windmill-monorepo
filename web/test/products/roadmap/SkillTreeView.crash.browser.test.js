import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost('crash');

for (const [width, role] of [[390, 'owner'], [744, 'reader'], [1440, 'owner']]) {
  hostTest(`Chromium: identity crash restores legacy home and a switch at ${width}px for ${role}`, async () => {
    const { page } = await openHost({ width, role, crash: true });
    try {
      await page.locator('.st-roadmap-identity-fallback').waitFor();
      assert.equal(await page.getByRole('link', { name: 'Windmill — home' }).count(), 1);
      assert.equal(await page.locator('.st-roadmap-fallback-switch .st-board-switch-option').count(), 2);
      assert.deepEqual(await page.evaluate(() => window.issues.filter(({ operation }) => operation === 'roadmap-identity')),
        [{ operation: 'roadmap-identity', stack: true }]);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: crash fallback switch and Board inset follow the measured legacy chrome', async () => {
  const { page, errors } = await openHost({ crash: true, surface: 'board' });
  try {
    const fallback = page.locator('.st-roadmap-identity-fallback');
    await fallback.waitFor();
    assert.equal(await fallback.locator('.st-zoom-group').isVisible(), false);
    assert.equal(await fallback.locator('.st-activity-chip').isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-fallback-switch [aria-pressed="true"]'));
    const geometry = () => page.evaluate(() => {
      const chrome = document.querySelector('.st-roadmap-identity-fallback .st-topbar');
      const control = document.querySelector('.st-roadmap-fallback-switch');
      const board = document.querySelector('.st-board');
      return {
        chromeBottom: chrome.offsetTop + chrome.offsetHeight,
        switchTop: control.offsetTop,
        switchBottom: control.offsetTop + control.offsetHeight,
        boardPadding: Number.parseFloat(getComputedStyle(board).paddingTop),
      };
    });
    const before = await geometry();
    assert.equal(before.switchTop >= before.chromeBottom, true);
    assert.equal(before.boardPadding > before.switchBottom, true);
    await page.locator('.st-roadmap-identity-fallback .st-topbar').evaluate((element) => {
      element.style.paddingBottom = `${Number.parseFloat(getComputedStyle(element).paddingBottom) + 40}px`;
    });
    await page.waitForFunction((before) => {
      const control = document.querySelector('.st-roadmap-fallback-switch');
      const board = document.querySelector('.st-board');
      return control.offsetTop > before.switchTop && Number.parseFloat(getComputedStyle(board).paddingTop) > before.boardPadding;
    }, before);
    const after = await geometry();
    const growth = after.chromeBottom - before.chromeBottom;
    assert.equal(growth > 0, true);
    assert.deepEqual({ switch: after.switchTop - before.switchTop, board: after.boardPadding - before.boardPadding }, { switch: growth, board: growth });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 744]) {
  hostTest(`Chromium: reader Board crash fallback retains home without Graph camera at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', crash: true, surface: 'board' });
    try {
      const fallback = page.locator('.st-roadmap-identity-fallback');
      await fallback.waitFor();
      assert.equal(await fallback.getByRole('link', { name: 'Windmill — home' }).count(), 1);
      assert.equal(await fallback.getByRole('group', { name: 'Camera', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
