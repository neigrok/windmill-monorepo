// §2.5 of the wave-8 architecture: the Tree / List pill and the plaque have their homes in the identity row.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost('capabilitiesIdentity');

const everyWidth = [320, 390, 744, 1440];
const bothRoles = ['owner', 'reader'];

function identityView(page) {
  return page.locator('.st-roadmap-identity').getAttribute('data-view');
}

for (const width of everyWidth) {
  for (const role of bothRoles) {
    hostTest(`§2.5 Tree / List pill: the identity switch at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        const row = page.locator('.st-roadmap-identity');
        assert.equal(await identityView(page), 'tree');
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
        await page.locator('.st-view-layer--board.is-active .st-board-card').first().waitFor({ state: 'attached' });
        await row.getByRole('button', { name: 'Graph', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'tree');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Reader plaque: author line (G8-R1): no author in the row at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        assert.equal(await page.locator('.st-roadmap-identity').evaluate((row) => row.textContent.includes('Ada Lovelace')), false);
        assert.equal(await page.getByText('Ada Lovelace').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
