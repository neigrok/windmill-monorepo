// §2.5 of the wave-8 architecture: every way to find a step has its Board home.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { LABELS, removeChip } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

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

for (const width of [744, 1024]) {
  for (const touch of [false, true]) {
    hostTest(`A press on the view switch lands with the folded Find open at ${width}px, ${touch ? 'by touch' : 'by mouse'}, and the field then folds`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board', touch, longTitle: true });
      const press = async (selector) => {
        const target = page.locator(selector);
        if (!touch) { await target.click(); return; }
        const box = await target.boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      };
      try {
        await press('.st-board-find-toggle');
        await page.getByRole('searchbox', { name: LABELS.findStep }).waitFor();
        await press('.st-roadmap-identity button[aria-label="Graph"]');
        await page.locator('.st-roadmap-identity[data-view="tree"]').waitFor();
        await page.locator('.st-board-find-toggle').waitFor();
        assert.equal(await page.getByRole('searchbox', { name: LABELS.findStep }).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Clearing a folded Find with its × keeps the field open and focused', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'board' });
  try {
    await page.locator('.st-board-find-toggle').click();
    const field = page.getByRole('searchbox', { name: LABELS.findStep });
    await field.fill('wind');
    await page.locator('.st-board-find-clear').click();
    await page.waitForTimeout(100);
    assert.equal(await field.evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
