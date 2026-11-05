// §2.5 of the wave-8 architecture: every way to edit a step has its Board home.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { COMPOSER, EDIT_STEP, LABELS, PICKER, STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const everyWidth = [320, 390, 744, 1440];

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

function savedStep(page, id) {
  return page.evaluate((id) => {
    const { label, description, color, prerequisites } = window.session.lattice.toTreeData().nodes.find((node) => node.id === id);
    return { label, description, color, prerequisites: [...prerequisites].sort() };
  }, id);
}

for (const width of everyWidth) {
  hostTest(`§2.5 Rename, describe, recolor one: Edit step at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await openStep(page, 'wind');
      await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
      await page.getByRole('textbox', { name: COMPOSER.name, exact: true }).fill('Read gusts');
      await page.getByRole('textbox', { name: COMPOSER.description }).fill('Watch the water.');
      await page.getByRole('dialog', { name: EDIT_STEP.title, exact: true }).getByRole('radio', { name: 'Sky', exact: true }).click();
      await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
      await page.getByRole('dialog', { name: 'Read gusts', exact: true }).waitFor();
      assert.deepEqual(await savedStep(page, 'wind'), { label: 'Read gusts', description: 'Watch the water.', color: 'sky', prerequisites: ['course'] });
      assert.equal(await page.locator('.st-ticker').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Rename, describe, recolor one · add a prerequisite: a reader has no Edit step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', surface: 'board' });
    try {
      await openStep(page, 'wind');
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Add a prerequisite: Edit step's picker at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await openColumn(page, width, 'Locked');
      await openStep(page, 'dock');
      await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: /^Choose a course/ }).click();
      await page.getByRole('button', { name: PICKER.apply, exact: true }).click();
      await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
      await page.getByRole('dialog', { name: 'Leave the dock', exact: true }).waitFor();
      assert.deepEqual((await savedStep(page, 'dock')).prerequisites, ['course', 'wind']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Add a step under this one (G8-L1): New step and choose the prerequisite at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await page.getByRole('button', { name: LABELS.newStep, exact: true }).first().click();
      await page.getByRole('textbox', { name: COMPOSER.name, exact: true }).fill('Reef the sail');
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: /^Read the wind/ }).click();
      await page.getByRole('button', { name: PICKER.apply, exact: true }).click();
      await page.getByRole('button', { name: COMPOSER.create, exact: true }).click();
      await page.locator('.st-board-toast-message').waitFor();
      const created = await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ label }) => label === 'Reef the sail').id);
      assert.deepEqual((await savedStep(page, created)).prerequisites, ['wind']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('A rename on the Graph\'s dock announces on the ticker, and the ticker stands only over the Graph', async () => {
  const { page, errors } = await openHost({ surface: 'tree' });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.locator('.st-detail-panel--open .st-step-name').click();
    const name = page.locator('.st-step-name-input');
    await name.fill('Read gusts');
    await name.press('Enter');
    await page.locator('.st-ticker').waitFor();
    await page.getByRole('radio', { name: 'Board', exact: true }).or(page.getByRole('button', { name: 'Board', exact: true })).first().click();
    await page.locator('.st-roadmap-identity[data-view="board"]').waitFor();
    assert.equal(await page.locator('.st-ticker').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
