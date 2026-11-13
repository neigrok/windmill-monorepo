// §2.5 of the wave-8 architecture: deleting a step and scoping to a branch have their Board homes.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { DELETE_CONFIRM, LABELS, STEP_DETAIL, branchChip, deletedToast } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

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

hostTest('§2.5 Delete: the desktop Graph keeps the sole root at every door and offers Delete for everything else', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    const steps = () => page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort());
    const deletes = () => page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_delete' || name === 'roadmap_board_bulk'));
    const nextFrame = () => page.evaluate(() => new Promise(requestAnimationFrame));
    const pressDelete = async () => {
      await nextFrame();
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Delete');
      await nextFrame();
    };

    await page.evaluate(() => window.scene.select('course'));
    await page.locator('.st-detail-panel--open .st-step-name', { hasText: 'Choose a course' }).waitFor();
    assert.equal(await page.locator('.st-step-delete').count(), 0);
    await pressDelete();
    assert.deepEqual(await steps(), ['course', 'dock', 'wind']);

    await page.evaluate(() => window.scene.options.onMarqueeSelect(['course', 'wind'], false));
    await page.locator('.st-selection-bar').waitFor();
    assert.equal(await page.locator('.st-selection-delete').count(), 0);
    await pressDelete();
    assert.deepEqual([await steps(), await deletes()], [['course', 'dock', 'wind'], []]);

    await page.evaluate(() => window.scene.options.onMarqueeSelect(['wind', 'dock'], false));
    await page.locator('.st-selection-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => window.session.lattice.toTreeData().nodes.length === 1);
    assert.deepEqual([await steps(), await deletes()], [['course'], [{ name: 'roadmap_board_bulk', props: { step: 'delete', count: '2-5', view: 'graph' } }]]);

    await page.evaluate(() => window.scene.select('course'));
    await page.locator('.st-detail-panel--open .st-step-name', { hasText: 'Choose a course' }).waitFor();
    assert.equal(await page.locator('.st-step-delete').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('§2.5 Delete: under a hold the Graph refuses the last root standing, and the hold keeps its toast', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => window.session.dispatch({ kind: 'CreateNode', id: 'solo', label: 'Sail solo', icon: 'sparkles', color: 'gold' }));
    await page.evaluate(() => { window.location.hash = `${window.location.hash.split('?')[0]}?step=solo`; });
    const layer = page.locator('.st-board-step-layer');
    await layer.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete step' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    const toast = page.locator('.st-graph-toast .st-board-toast');
    await toast.waitFor();
    await page.evaluate(() => window.scene.select('course'));
    await page.locator('.st-detail-panel--open .st-step-name', { hasText: 'Choose a course' }).waitFor();
    assert.equal(await page.locator('.st-step-delete').count(), 0);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await toast.locator('.st-board-toast-message').textContent(), deletedToast({ step: 'Sail solo' }));
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort()), ['course', 'dock', 'solo', 'wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('§2.5 Delete: a signed-in reader at the app address gets a reader\'s dock, and Delete writes nothing', async () => {
  const { page, errors } = await openHost({ width: 1440, role: 'reader', appUrl: true });
  try {
    await page.evaluate(() => window.scene.select('dock'));
    await page.locator('.st-detail-panel--open', { hasText: 'Leave the dock' }).waitFor();
    assert.equal(await page.locator('.st-step-delete').count(), 0);
    assert.equal(await page.locator('.st-detail-panel--open').getByRole('textbox').count(), 0);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort()), ['course', 'dock', 'wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('§2.5 Delete: signing in on a roadmap that loaded as someone else\'s loads it again, since it may be theirs', async () => {
  const { page, errors } = await openHost({ width: 1440, role: 'reader', appUrl: true });
  try {
    await page.evaluate(() => { window.stayed = true; });
    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => window.setFixtureAuth('signed-in'));
    await reloaded;
    assert.equal(await page.evaluate(() => window.stayed), undefined);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('§2.5 Delete: the desktop dock offers Delete for a step the roadmap can lose', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => window.scene.select('dock'));
    await page.locator('.st-step-delete').click();
    await page.waitForFunction(() => window.session.lattice.toTreeData().nodes.length === 2);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_delete')),
      [{ name: 'roadmap_board_delete', props: { step: 'sent', via: 'direct', view: 'graph' } }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('§2.5 Delete: under a hold the tablet\'s bulk bar holding the last root standing does not offer Delete', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => window.session.dispatch({ kind: 'CreateNode', id: 'solo', label: 'Sail solo', icon: 'sparkles', color: 'gold' }));
    await page.evaluate(() => { window.location.hash = `${window.location.hash.split('?')[0]}?step=solo`; });
    await page.locator('.st-board-step-layer').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete step' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.locator('.st-graph-toast .st-board-toast').waitFor();
    await page.evaluate(() => window.longPress('course'));
    await page.getByRole('group', { name: '1 selected', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Delete 1 step', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [held, offered] of [['course', 0], ['wind', 1]]) {
  hostTest(`§2.5 Delete: the tablet's bulk bar holding ${held} ${offered ? 'offers' : 'does not offer'} Delete`, async () => {
    const { page, errors } = await openHost({ width: 744 });
    try {
      await page.evaluate((id) => window.longPress(id), held);
      await page.getByRole('group', { name: '1 selected', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Delete 1 step', exact: true }).count(), offered);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
