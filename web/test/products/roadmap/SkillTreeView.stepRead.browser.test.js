import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { DELETE_CONFIRM, EDIT_STEP, STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

for (const width of [320, 390, 744, 1024, 1440]) {
  for (const role of ['owner', 'reader', 'demo']) {
    hostTest(`Chromium: explicit Graph activation opens one ${role} document at ${width}px and closes to its canvas`, async () => {
      const { page, errors } = await openHost({ width, role: role === 'demo' ? 'reader' : role, demo: role === 'demo' });
      try {
        await page.evaluate(() => window.scene.select('wind'));
        assert.equal(await page.locator('article, [data-graph-step-bar], .st-detail-panel--open').count(), 0);
        const before = await page.evaluate(() => window.scene.getViewpoint());
        await page.evaluate(() => window.scene.activate('wind'));
        const step = page.getByRole('article', { name: 'Read the wind', exact: true });
        await step.waitFor();
        assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail?step=wind');
        assert.equal(await page.locator('.st-product-canvas').evaluate((element) => element.inert), true);
        assert.equal(await step.getAttribute('aria-modal'), null);
        assert.equal(await step.getByRole('tablist').count(), 0);
        assert.equal(await page.locator('.st-board-workspace').count(), role === 'owner' ? 1 : 0);
        await step.focus();
        await page.keyboard.press('Escape');
        await step.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.matches('canvas[data-graph-focus]'));
        assert.deepEqual(await page.evaluate(() => window.scene.getViewpoint()), before);
        assert.equal(await page.locator('.st-product-canvas').evaluate((element) => element.inert), false);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: Enter belongs to the selected Graph canvas; Shell and Coach retain their own keyboard', async () => {
  const { page, errors } = await openHost({ width: 1440, shell: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.locator('canvas[data-graph-focus]').focus();
    await page.keyboard.press('Enter');
    const step = page.getByRole('article', { name: 'Read the wind', exact: true });
    await step.waitFor();
    const coach = page.getByRole('button', { name: 'Collapse Coach' });
    await coach.focus();
    await page.keyboard.press('Escape');
    assert.equal(await step.count(), 1);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Expand Coach' }).waitFor();
    assert.equal(await page.locator('.wm-shell').evaluate((shell) => shell.closest('[inert]') === null), true);
    assert.equal(await page.locator('article').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Graph document keeps the complete edit contract and held delete Undo never reopens it', async () => {
  const { page, errors } = await openHost({ width: 390, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
    await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
    await page.getByRole('article', { name: 'Read gusts', exact: true }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.clock.runFor(300);
    await page.waitForFunction(() => !window.scene.nodesById.has('wind'));
    await page.locator('.st-board-toast-undo').click();
    await page.clock.runFor(300);
    assert.equal(await page.evaluate(() => window.scene.nodesById.has('wind')), true);
    assert.equal(await page.locator('article').count(), 0);
    assert.equal(await page.evaluate(() => location.hash.includes('step=')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: tablet Connect leaves the document for the existing aim tool, and Add step retains blank-name handoff', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => window.editTap(10, 10, 'wind'));
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('group', { name: 'Choose a step' }).waitFor();
    assert.equal(await page.locator('article').count(), 0);
    await page.getByRole('button', { name: 'Cancel connect' }).click();
    await page.evaluate(() => window.editTap(10, 10, 'wind'));
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add step', exact: true }).click();
    await page.locator('.st-step-name-input').waitFor();
    await page.locator('.st-step-name-input').fill('Watch the water');
    await page.locator('.st-step-name-input').press('Enter');
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.filter((node) => node.label === 'Watch the water').map((node) => node.prerequisites)), [['wind']]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


for (const surface of ['tree', 'board']) {
  hostTest(`Chromium: a direct step link closes to the ${surface} identity without discarding unrelated address state`, async () => {
    const { page, errors } = await openHost({ width: 1440, surface });
    try {
      await page.evaluate(() => history.replaceState({ retained: true }, '', location.hash + '?inspect=1&step=wind'));
      await page.reload();
      const step = page.getByRole('article', { name: 'Read the wind', exact: true });
      await step.waitFor();
      await step.getByRole('button', { name: STEP_DETAIL.close, exact: true }).click();
      await step.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity'));
      assert.deepEqual(await page.evaluate(() => [location.hash, history.state]), ['#/app/t_sail?inspect=1', { retained: true }]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: a delayed copy result cannot announce on a later step or steal Coach focus', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => new Promise((resolve) => { window.finishCopy = resolve; });
      window.scene.activate('wind');
    });
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.copyLink, exact: true }).click();
    await page.locator('.st-board-step-row').filter({ hasText: 'Leave the dock' }).click();
    await page.getByRole('article', { name: 'Leave the dock', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Collapse Coach' }).focus();
    await page.evaluate(() => window.finishCopy());
    await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_board_step_action' && props.action === 'copyLink' && props.outcome === 'ok'));
    assert.equal(await page.locator('.st-graph-toast').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Collapse Coach');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const role of ['owner', 'reader']) {
  hostTest(`Chromium: a signed-in ${role} on a shared URL reads shared content without device-private workspace`, async () => {
    const { page, errors, requests } = await openHost({ width: 744, role, address: '#/t/', auth: 'signed-in' });
    try {
      await page.evaluate(() => localStorage.setItem('windmill:workspace:t_sail', JSON.stringify({
        wind: { note: 'Private preparation note', subtasks: [{ id: 'secret', label: 'Private task', done: false }], links: [] },
      })));
      await page.reload();
      await page.waitForFunction(() => window.session?.ready && window.scene?.nodesById.has('wind'));
      await page.evaluate(() => window.scene.activate('wind'));
      const step = page.getByRole('article', { name: 'Read the wind', exact: true });
      await step.waitFor();
      assert.equal(await step.locator('.st-board-workspace').count(), 0);
      assert.equal(await step.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 0);
      assert.equal(await page.getByText('Private preparation note', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Private task', { exact: true }).count(), 0);
      assert.equal(await step.locator('.st-step-history-section').count(), 1);
      assert.deepEqual(requests.filter((path) => path.endsWith('/guides')), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}


hostTest('Chromium: Open in Graph focuses its canvas and View branch reveals the existing Board filter', async () => {
  const { page, errors } = await openHost({ width: 1440, surface: 'board', broad: true });
  try {
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.locator('.st-step-toolbar').getByRole('button', { name: STEP_DETAIL.openInGraph, exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('canvas[data-graph-focus]'));
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'tree');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: STEP_DETAIL.viewBranch, exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.locator('.st-roadmap-identity[data-view="board"]').waitFor();
    await page.locator('.st-board-card[data-step-id="knots"]').waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId).sort()), ['course', 'dock', 'wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
