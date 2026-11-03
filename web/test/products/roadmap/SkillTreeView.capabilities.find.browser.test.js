// §2.5 of the wave-8 architecture: every way the List found a step has its Board home.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { LABELS, removeChip } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesFind');

const everyWidth = [320, 390, 744, 1440];
const bothRoles = ['owner', 'reader'];

function cardIds(page) {
  return page.locator('.st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId).sort());
}

async function openFind(page, width) {
  if (width >= 744 && width < 1280) await page.locator('.st-board-find-toggle').click();
  return page.getByRole('searchbox', { name: LABELS.findStep, exact: true });
}

for (const width of everyWidth) {
  for (const role of bothRoles) {
    hostTest(`§2.5 Find a step by title: Find a step at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board' });
      try {
        const find = await openFind(page, width);
        await find.fill('Leave');
        await page.waitForFunction(() => document.querySelectorAll('.st-board-card').length === 1);
        assert.deepEqual(await cardIds(page), ['dock']);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Find by description (G8-L2): the card shows its excerpt, not the hit, at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board', described: true });
      try {
        const find = await openFind(page, width);
        await find.fill('fenders');
        await page.waitForFunction(() => document.querySelectorAll('.st-board-card').length === 1);
        assert.deepEqual(await cardIds(page), ['dock']);
        assert.deepEqual(await page.locator('.st-board-card[data-step-id="dock"]').evaluate((card) => ({
          excerpt: card.querySelector('.st-board-card-excerpt').textContent,
          highlighted: card.querySelectorAll('mark').length,
        })), { excerpt: 'Cast off on an ebb tide after checking the fenders.', highlighted: 0 });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Kind lens: Filter narrows by kind at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board', legend: true });
      try {
        if (width < 744) {
          await page.getByRole('button', { name: LABELS.filterByKind, exact: true }).click();
          await page.getByRole('dialog', { name: LABELS.filterByKind, exact: true }).getByRole('button', { name: 'Learn' }).click();
          await page.getByRole('dialog', { name: LABELS.filterByKind, exact: true }).getByRole('button', { name: LABELS.close, exact: true }).click();
          await page.getByRole('button', { name: removeChip({ label: 'Learn' }), exact: true }).waitFor();
        } else {
          await page.getByRole('group', { name: LABELS.filterByKind, exact: true }).getByRole('button', { name: 'Learn' }).click();
        }
        await page.waitForFunction(() => document.querySelectorAll('.st-board-card').length === 1);
        assert.deepEqual(await cardIds(page), ['wind']);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
