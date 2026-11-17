import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost({ realScene: true, browserTypes: { chromium, webkit } });

async function nodePosition(page, id) {
  await page.waitForFunction((id) => {
    const scene = window.scene;
    const node = scene?.nodesById.get(id);
    if (!node) return false;
    const point = scene.projectToScreen(node.x, node.y);
    return scene.pick(point.x, point.y, 'mouse') === id;
  }, id);
  return page.evaluate((id) => {
    const node = window.scene.nodesById.get(id);
    return window.scene.projectToScreen(node.x, node.y);
  }, id);
}

for (const width of [390, 744, 1440]) {
  hostTest(`Chromium: actual canvas tap at ${width}px opens the shared step and restores its canvas`, async () => {
    const { page, errors } = await openHost({ width, touch: width < 1000 });
    try {
      const canvas = page.locator('canvas[data-graph-focus]');
      const point = await nodePosition(page, 'wind');
      if (width < 1000) await canvas.tap({ position: point });
      else await canvas.click({ position: point });
      const step = page.locator('.st-board-step-layer article');
      await step.waitFor();
      assert.equal(await page.getByRole('article', { name: 'Read the wind', exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail?step=wind');
      assert.equal(await step.getAttribute('aria-modal'), null);
      await step.getByRole('button', { name: STEP_DETAIL.close, exact: true }).click();
      await step.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('canvas[data-graph-focus]'));
      await page.keyboard.press('Enter');
      await step.waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: actual tablet edge tap followed by one node tap exits removal and opens the document', async () => {
  const { page, errors } = await openHost({ width: 744, touch: true });
  try {
    await nodePosition(page, 'wind');
    const canvas = page.locator('canvas[data-graph-focus]');
    const edge = await page.evaluate(() => {
      const scene = window.scene;
      const from = scene.nodesById.get('wind');
      const to = scene.nodesById.get('dock');
      const point = scene.projectToScreen((from.x + to.x) / 2, (from.y + to.y) / 2);
      const picked = scene.pickEdge(point.x, point.y);
      return { point, from: picked?.from, to: picked?.to };
    });
    assert.deepEqual([edge.from, edge.to], ['wind', 'dock']);
    await canvas.tap({ position: edge.point });
    await page.getByRole('group', { name: 'Remove this link', exact: true }).waitFor();
    await canvas.tap({ position: await nodePosition(page, 'wind') });
    await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'dock').prerequisites), ['wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: actual canvas Shift selection does not activate; Delete and Undo retain the Graph', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    const canvas = page.locator('canvas[data-graph-focus]');
    await canvas.click({ position: await nodePosition(page, 'dock'), modifiers: ['Shift'] });
    await page.waitForFunction(() => window.scene.selectedIds.has('dock'));
    assert.equal(await page.getByRole('article').count(), 0);
    await canvas.focus();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => !window.scene.nodesById.has('dock'));
    await page.locator('.st-graph-toast .st-board-toast-undo').click();
    await page.waitForFunction(() => window.scene.nodesById.has('dock'));
    assert.equal(await page.getByRole('article').count(), 0);
    assert.equal(await page.evaluate(() => location.hash.includes('step=')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [browserName, input] of [['chromium', 'touch'], ['chromium', 'keyboard'], ['webkit', 'touch'], ['webkit', 'keyboard']]) {
  hostTest(`${browserName}: an immediate ${input} action after a real tablet node tap follows the chosen relationship once`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, touch: true });
    try {
      await page.locator('canvas[data-graph-focus]').tap({ position: await nodePosition(page, 'wind') });
      const step = page.getByRole('article', { name: 'Read the wind', exact: true });
      assert.equal(await step.count(), 1);
      const relationship = step.locator('.st-board-step-row').filter({ hasText: 'Leave the dock' });
      if (input === 'touch') await relationship.tap();
      else await relationship.press('Enter');
      await page.getByRole('article', { name: 'Leave the dock', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail?step=dock');
      await page.getByRole('button', { name: 'Back to Read the wind', exact: true }).click();
      await step.waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
