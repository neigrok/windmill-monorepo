import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost();

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1024, 'desktop'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    for (const surface of ['tree', 'board']) {
      hostTest(`Chromium: host identity contract ${width}px ${role} ${surface}`, async () => {
        const { page, errors } = await openHost({ width, role, surface });
        try {
          await page.waitForFunction((surface) => document.querySelector('.st-roadmap-identity')?.dataset.view === surface, surface);
          assert.deepEqual(await page.locator('.st-roadmap-identity').evaluate((row) => ({
            band: ['phone', 'tablet', 'desktop'].find((value) => row.classList.contains('st-roadmap-identity--' + value)),
            role: row.dataset.role, view: row.dataset.view,
            title: row.querySelector('.st-roadmap-context').textContent,
            progress: row.querySelector('.st-roadmap-progress').getAttribute('aria-label'),
            next: row.querySelector('[aria-label="Next · 1"]') !== null,
            sheet: row.querySelector('.st-roadmap-title-button') !== null,
          })), {
            band, role, view: surface, title: 'Learn to sail', progress: '1 of 3 steps done',
            next: surface === 'tree' && role === 'owner' && band !== 'phone',
            sheet: band === 'phone' && role === 'owner',
          });
          assert.equal(await page.locator('.st-roadmap-identity').count(), 1);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

hostTest('Chromium: one unfinished step has Next · 1 and a completed roadmap has no Next chip', async () => {
  const { page, errors } = await openHost({ single: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 1);
    await page.evaluate(() => window.scene.select('course'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 1 step done');
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [744, 1024, 1440]) {
  for (const menu of [false, true]) {
    hostTest(`Chromium: Board identity precedes cards and Tab exits ${menu ? 'open menu' : 'More'} at ${width}px`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board' });
      try {
        assert.equal(await page.evaluate(() => {
          const row = document.querySelector('.st-roadmap-identity');
          const board = document.querySelector('.st-board');
          return Boolean(row.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), true);
        const more = page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true });
        if (menu) await more.click();
        else await more.focus();
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.querySelector('.st-board')?.contains(document.activeElement));
        assert.equal(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[inert]')), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
