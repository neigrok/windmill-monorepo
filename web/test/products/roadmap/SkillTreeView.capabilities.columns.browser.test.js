// §2.5 of the wave-8 architecture: what a roadmap shows lives in its columns.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { backTo, roadmapComplete } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const everyWidth = [320, 390, 744, 1440];
const bothRoles = ['owner', 'reader'];

async function openStep(page, id) {
  await page.locator(`.st-board-card[data-step-id="${id}"]`).evaluate((card) => card.click());
  await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
}

for (const width of everyWidth) {
  for (const role of bothRoles) {
    hostTest(`§2.5 Next up shelf: Up next shows what is ready at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board' });
      try {
        const upNext = width < 744 ? '.st-board-phone-pane.is-shown[data-column="upNext"]' : '[data-column="upNext"]';
        assert.deepEqual(await page.locator(`${upNext} .st-board-card`).evaluateAll((cards) => cards.map((card) => card.dataset.stepId)), ['wind']);
        assert.equal(await page.locator(`${upNext} .st-board-card-reason`).textContent(), 'Unlocks Leave the dock');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Jump to a related step and back: step rows and Back at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board' });
      try {
        await openStep(page, 'wind');
        await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Leave the dock, locked', exact: true }).click();
        await page.getByRole('dialog', { name: 'Leave the dock', exact: true }).waitFor();
        if (width < 744) await page.getByRole('button', { name: backTo({ screen: 'Read the wind' }), exact: true }).click();
        else await page.goBack();
        await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Roadmap complete crown: the complete state at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role, surface: 'board', allDone: true });
      try {
        const copy = roadmapComplete({ total: 3 });
        const state = page.locator('.st-board-complete');
        await state.waitFor();
        assert.equal(await state.locator('.st-board-complete-title').textContent(), copy.title);
        assert.equal(await state.locator('.st-board-complete-crown').count(), width < 744 ? 1 : 0);
        assert.equal(await state.getByRole('button', { name: copy.share, exact: true }).count(), role === 'owner' ? 1 : 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
