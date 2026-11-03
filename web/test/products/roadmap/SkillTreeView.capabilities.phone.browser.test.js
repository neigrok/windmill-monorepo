// §2.5 of the wave-8 architecture: the phone's switching, Ask AI and Share have their homes in the roadmap sheet.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ASK_AI_PLACEHOLDER, ROADMAP_SHEET, ROADMAP_VERBS, roadmapMatches, roadmapsHeading } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesPhone');

const phones = [320, 390];

function openSheet(page) {
  return page.locator('.st-roadmap-title-button').click().then(() => page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true }));
}

for (const width of phones) {
  hostTest(`§2.5 Switch roadmap · Plant · Planted in public: the roadmap sheet at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      const sheet = await openSheet(page);
      assert.equal(await sheet.locator('.st-roadmap-sheet-tree[aria-current="true"] .st-roadmap-sheet-tree-name').textContent(), 'Learn to sail');
      await sheet.getByRole('button', { name: /^Spanish basics/ }).click();
      await page.waitForFunction(() => location.hash === '#/app/t_other');
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/app/new');
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/browse');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Switcher search above eight roadmaps: the sheet's Find a roadmap at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, manyTrees: true });
    try {
      const sheet = await openSheet(page);
      await sheet.getByRole('heading', { name: roadmapsHeading({ count: 13 }), exact: true }).waitFor();
      await sheet.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap, exact: true }).fill('basics');
      await sheet.getByRole('heading', { name: roadmapMatches({ shown: 1, total: 13 }), exact: true }).waitFor();
      assert.deepEqual(await sheet.locator('.st-roadmap-sheet-tree-name').allTextContents(), ['Spanish basics']);
      assert.equal(await sheet.locator('mark').textContent(), 'basics');
      assert.equal(await sheet.getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).count(), 1);
      await sheet.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap, exact: true }).fill('nothing like this');
      await sheet.getByRole('heading', { name: roadmapMatches({ shown: 0, total: 13 }), exact: true }).waitFor();
      await sheet.getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/app/new');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Ask AI on phones: the sheet's docked bar at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).click();
      const bar = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
      await bar.waitFor();
      assert.equal(await bar.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.phone);
      assert.equal(await page.locator('.st-tend-overlay').getAttribute('data-presentation'), 'docked');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Ask AI · Share on phones: a reader has neither at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      assert.equal(await page.locator('.st-roadmap-title-button').count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Share on phones: the sheet's Share at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
      await page.getByRole('dialog').filter({ hasText: ROADMAP_VERBS.shareRoadmap }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
