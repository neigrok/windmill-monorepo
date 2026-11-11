import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ANONYMOUS_OWNER } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const guideEvents = (page) => page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_guide').map(({ props }) => props));
const box = (page, selector) => page.locator(selector).evaluate((element) => {
  const { left, top, right, bottom, width } = element.getBoundingClientRect();
  return { left, top, right, bottom, width };
});

hostTest('Chromium: at 1440px the guide is a card on the Graph\'s canvas, written through the room\'s session; on the Board it sits in the flow over no card, and an open note follows it there', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960, shell: true });
  try {
    const add = page.getByRole('button', { name: 'Add guide', exact: true });
    await add.waitFor();
    assert.equal(await page.locator('.st-roadmap-identity .st-guide-card, .st-roadmap-identity [aria-label^="Guide"]').count(), 0);
    await add.click();
    await page.getByRole('dialog', { name: 'Add guide' }).waitFor();
    await page.keyboard.type('One step a week.\nA step is done on the water.');
    await page.getByRole('button', { name: 'Save' }).click();
    const card = page.getByRole('button', { name: 'Guide: One step a week.' });
    await card.waitFor();
    assert.equal(await page.evaluate(() => window.session.lattice.guide), 'One step a week.\nA step is done on the water.');
    const [row, onGraph] = [await box(page, '.st-roadmap-identity'), await box(page, '.st-guide-card')];
    assert.deepEqual({ left: onGraph.left, under: onGraph.top - row.bottom, width: onGraph.width }, { left: 28, under: 38, width: 414 });

    await card.click();
    const note = page.getByRole('dialog', { name: 'Guide' });
    await note.waitFor();
    const reading = await box(page, '.st-guide-paper');
    assert.deepEqual({ left: reading.left, under: reading.top - row.bottom, width: reading.width }, { left: 24, under: 22, width: 642 });

    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card').first().waitFor();
    const onBoard = await box(page, '.st-guide-card');
    assert.equal(await page.locator('.st-guide-card').count(), 1);
    assert.deepEqual(await page.evaluate((guide) => [...document.querySelectorAll('.st-board-card, .st-board-filter-strip, .st-board-sort-button')]
      .filter((element) => {
        const other = element.getBoundingClientRect();
        return other.left < guide.right && other.right > guide.left && other.top < guide.bottom && other.bottom > guide.top;
      }).map((element) => element.className), onBoard), []);
    assert.equal(onBoard.top >= row.bottom, true);
    const overBoard = await box(page, '.st-guide-paper');
    assert.deepEqual([overBoard.left - onBoard.left, overBoard.top - onBoard.top], [-4, -16]);
    assert.deepEqual(await guideEvents(page), [
      { step: 'open', door: 'card', view: 'graph', role: 'owner' },
      { step: 'edit', via: 'add' },
      { step: 'save', outcome: 'saved', length: '1-500' },
      { step: 'open', door: 'card', view: 'graph', role: 'owner' },
    ]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await note.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-guide-card'));
    await card.click();
    assert.deepEqual((await guideEvents(page)).at(-1), { step: 'open', door: 'card', view: 'board', role: 'owner' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const surface of ['tree', 'board']) {
  hostTest(`Chromium: on a phone ${surface === 'tree' ? 'Graph' : 'Board'} a device tree's Guide row sits flush beneath its device line, under the head`, async () => {
    const { page, errors } = await openHost({ width: 390, height: 844, role: 'ghost', surface });
    try {
      await page.getByRole('button', { name: 'Add guide', exact: true }).waitFor();
      await page.evaluate(() => window.session.setGuide('One step a week.'));
      await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
      const line = await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).evaluate((element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      });
      const [head, row] = [await box(page, '.st-roadmap-identity'), await box(page, '.st-guide-row')];
      assert.deepEqual({ lineUnderHead: line.top - head.bottom, rowUnderLine: row.top - line.bottom, left: row.left, width: row.width },
        { lineUnderHead: 0, rowUnderLine: 0, left: 16, width: 358 });
      if (surface === 'tree') {
        const camera = await box(page, '.st-graph-chrome [aria-label="Camera"]');
        assert.equal(camera.top >= row.bottom, true);
      }
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      assert.equal(await page.locator('.st-guide-audience').textContent(), 'Only on this device until you sign in.');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: a reader on the app route sees the author\'s note on the tree, and the share route shows no guide', async () => {
  const reader = await openHost({ width: 390, height: 844, role: 'reader', appUrl: true });
  try {
    assert.equal(await reader.page.locator('.st-guide-row').count(), 0);
    await reader.page.evaluate(() => window.session.setGuide('One step a week.'));
    await reader.page.getByRole('button', { name: 'Author’s note: One step a week.' }).click();
    await reader.page.getByRole('dialog', { name: 'Author’s note' }).waitFor();
    assert.equal(await reader.page.getByRole('button', { name: 'Edit guide' }).count(), 0);
    assert.deepEqual(await guideEvents(reader.page), [{ step: 'open', door: 'row', view: 'graph', role: 'reader' }]);
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
  for (const width of [390, 1440]) {
    const shared = await openHost({ width, height: 844, role: 'reader' });
    try {
      await shared.page.evaluate(() => window.session.setGuide('One step a week.'));
      await shared.page.waitForFunction(() => window.session.lattice.guide === 'One step a week.');
      assert.equal(await shared.page.locator('.st-guide-row, .st-guide-card').count(), 0);
      assert.deepEqual(shared.errors, []);
    } finally { await shared.page.close(); }
  }
});
