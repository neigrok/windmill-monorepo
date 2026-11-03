import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost('crash');

const everyWidth = [390, 744, 1440];

function pressedOption(page, container) {
  return page.locator(`${container} .st-board-switch-option[aria-pressed="true"]`);
}

for (const width of everyWidth) {
  for (const role of ['owner', 'reader']) {
    hostTest(`Chromium: a thrown row leaves its switch at the row's position with focus on it at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, crash: true });
      try {
        const fallback = page.locator('.st-roadmap-identity-fallback');
        await fallback.waitFor();
        assert.equal(await fallback.locator('.st-board-switch-option').count(), 2);
        await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity-fallback [aria-pressed="true"]'));
        assert.equal(await page.locator('.st-roadmap-identity').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.issues.filter(({ operation }) => operation === 'roadmap-identity')),
          [{ operation: 'roadmap-identity', stack: true }]);
        await fallback.getByRole('button', { name: 'Board', exact: true }).click();
        await page.locator('.st-view-layer--board.is-active .st-board').waitFor();
        await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity-fallback [aria-pressed="true"]'));
        await fallback.getByRole('button', { name: 'Graph', exact: true }).click();
        await page.getByRole('group', { name: 'Camera', exact: true }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest(`Chromium: a thrown row keeps the Board beneath its switch at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, crash: true, surface: 'board' });
    try {
      const fallback = page.locator('.st-roadmap-identity-fallback');
      await fallback.waitFor();
      await page.locator('.st-view-layer--board.is-active .st-board').waitFor();
      assert.equal(await pressedOption(page, '.st-roadmap-identity-fallback').getAttribute('aria-label'), 'Board');
      await page.waitForFunction(() => {
        const row = document.querySelector('.st-roadmap-identity-fallback').getBoundingClientRect();
        const board = document.querySelector('.st-board');
        return Number.parseFloat(getComputedStyle(board).paddingTop) >= row.bottom;
      });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`Chromium: a thrown Board shows the Graph with the switch reachable and focus on it at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', crashBoard: true });
    try {
      const row = page.locator('.st-roadmap-identity');
      await page.waitForFunction(() => document.querySelector('.st-roadmap-identity')?.dataset.view === 'tree');
      await page.getByRole('group', { name: 'Camera', exact: true }).waitFor();
      assert.equal(await page.locator('.st-view-layer--board').count(), 0);
      await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity [aria-pressed="true"]'));
      assert.equal(await activeLabel(page), 'Graph');
      assert.deepEqual(await page.evaluate(() => window.issues.filter(({ operation }) => operation === 'roadmap-board')),
        [{ operation: 'roadmap-board', stack: true }]);
      assert.equal(await row.getByRole('button', { name: 'Board', exact: true }).count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: asking for a thrown Board again retries it, and a second throw lands back on the Graph', async () => {
  const { page, errors } = await openHost({ width: 1440, surface: 'board', crashBoard: true });
  try {
    const row = page.locator('.st-roadmap-identity');
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity')?.dataset.view === 'tree');
    await row.getByRole('button', { name: 'Board', exact: true }).click();
    await page.waitForFunction(() => window.issues.filter(({ operation }) => operation === 'roadmap-board').length === 2);
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity')?.dataset.view === 'tree');
    await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity [aria-pressed="true"]'));
    assert.equal(await activeLabel(page), 'Graph');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

function activeLabel(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
}
