// §2.5 of the wave-8 architecture: deleting a step and scoping to a branch have their Board homes.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { DELETE_CONFIRM, LABELS, STEP_DETAIL, branchChip, deletedToast } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesDelete');

const everyWidth = [320, 390, 744, 1440];

function cardIds(page) {
  return page.locator('.st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId).sort());
}

async function openStep(page, id) {
  await page.locator(`.st-board-card[data-step-id="${id}"]`).evaluate((card) => card.click());
  await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
}

async function openColumn(page, width, column) {
  if (width >= 1024) return;
  if (width >= 744) {
    const show = page.getByRole('button', { name: `${LABELS.show} ${column}`, exact: true });
    if (await show.count() > 0) await show.click();
    return;
  }
  await page.getByRole('tab', { name: new RegExp(`^${column},`) }).click();
}

for (const width of everyWidth) {
  hostTest(`§2.5 Delete: the step menu and held Undo at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', fixedClock: true });
    try {
      const deleteDock = async () => {
        await openColumn(page, width, 'Locked');
        await openStep(page, 'dock');
        await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
        await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
        await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
        await page.clock.runFor(800);
        await page.locator('.st-board-toast-message').filter({ hasText: deletedToast({ step: 'Leave the dock' }) }).waitFor();
      };
      await deleteDock();
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock')), true);
      await page.locator('.st-board-toast-undo').click();
      await page.clock.runFor(800);
      await page.locator('.st-board-card[data-step-id="dock"]').waitFor({ state: 'attached' });
      await deleteDock();
      await page.clock.runFor(9500);
      await page.waitForFunction(() => !window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock'));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Delete: a reader's step menu offers no Delete at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', surface: 'board' });
    try {
      await openStep(page, 'wind');
      await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
      assert.equal(await page.getByRole('menuitem', { name: STEP_DETAIL.openInGraph, exact: true }).count(), 1);
      assert.equal(await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Sections by branch: View branch scopes the Board at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', broad: true });
    try {
      await openColumn(page, width, 'Done');
      assert.deepEqual(await cardIds(page), ['charts', 'course', 'dock', 'knots', 'wind'].filter((id) => width !== 744 || id !== 'dock'));
      await openStep(page, 'wind');
      await page.getByRole('button', { name: STEP_DETAIL.viewBranch, exact: true }).click();
      await page.getByRole('button', { name: branchChip({ step: 'Read the wind' }) }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.st-board-card[data-step-id="knots"]'));
      assert.deepEqual(await cardIds(page), ['course', 'dock', 'wind'].filter((id) => width !== 744 || id !== 'dock'));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Sections by branch: a reader's step offers no branch scope at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', surface: 'board' });
    try {
      await openStep(page, 'wind');
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.viewBranch, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
