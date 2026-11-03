// §2.5 of the wave-8 architecture: what the phone's lane and Graph sheet carried has its home in the bar, the step page and the coach.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { EDIT_STEP, FORK_OFFER, OPEN_STEP, PICKER, STEP_DETAIL } from '../../../src/products/roadmap/board/copy.js';
import { DEMO_COPY } from '../../../src/products/roadmap/demo/demoStage.js';

startRoadmapHost('capabilitiesPhoneGraph');

const phones = [320, 390];

function identityView(page) {
  return page.locator('.st-roadmap-identity').getAttribute('data-view');
}

for (const width of phones) {
  hostTest(`§2.5 Phone Graph: open a step's details (owner): the bar's Open step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 1);
      assert.equal(await identityView(page), 'tree');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: open a step's details (G8-H1): the bar's title opens a reader's read-only page, Fork stays primary, at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      const bar = page.locator('[data-graph-step-bar]');
      assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), FORK_OFFER);
      await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.complete, exact: true }).count(), 0);
      assert.equal(await identityView(page), 'tree');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: connect or remove a link: Edit step's prerequisites at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      assert.deepEqual(await page.evaluate(() => [window.longPress, window.editTap]), [null, null]);
      await page.evaluate(() => window.scene.select('dock'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: /^Read the wind/ }).click();
      await page.getByRole('checkbox', { name: /^Choose a course/ }).click();
      await page.getByRole('button', { name: PICKER.apply, exact: true }).click();
      await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
      await page.getByRole('dialog', { name: 'Leave the dock', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'dock').prerequisites), ['course']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: demo mark any step done (G8-M5): the bar offers Fork and the read-only page no mark at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      const bar = page.locator('[data-graph-step-bar]');
      assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), FORK_OFFER);
      assert.equal(await page.locator('.st-sheet, .st-step-panel').count(), 0);
      await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.complete, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: demo mark any step done (G8-M5): CoachChip keeps the play at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true });
    try {
      const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
      await mark.waitFor({ timeout: 8000 });
      assert.equal(await page.getByText(DEMO_COPY.coachSentence, { exact: true }).count(), 1);
      await mark.click();
      await page.locator('.st-board-toast-message').filter({ hasText: DEMO_COPY.unlockToast }).waitFor();
      await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 4 steps done');
      assert.equal(await mark.count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: demo mark any step done (G8-M5): CoachChip stays on screen and off its step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true });
    try {
      await page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true }).waitFor({ timeout: 8000 });
      const seatFor = async (y) => {
        await page.evaluate(({ x, y }) => {
          window.scene.projectToScreen = () => ({ x, y });
          window.dispatchEvent(new Event('resize'));
        }, { x: width / 2, y });
        const box = await page.locator('.wm-coach-card').boundingBox();
        return {
          onScreen: box.x >= 0 && box.x + box.width <= width,
          clearOfStep: box.y >= y || box.y + box.height <= y,
          under: box.y >= y,
          arrow: await page.locator('.wm-coach').evaluate((chip) => chip.classList.contains('wm-coach--left') || chip.classList.contains('wm-coach--right')),
        };
      };
      assert.deepEqual(await seatFor(300), { onScreen: true, clearOfStep: true, under: true, arrow: false });
      assert.deepEqual(await seatFor(900), { onScreen: true, clearOfStep: true, under: false, arrow: false });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo CTA echo on Fork (G8-M12): the pill alone pulses after the coached step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true, motion: true });
    try {
      const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
      await mark.waitFor({ timeout: 8000 });
      await mark.click();
      const pill = page.getByRole('button', { name: FORK_OFFER, exact: true });
      await page.waitForFunction((label) => [...document.querySelectorAll('button.wm-cta-echo')].some((button) => button.textContent.trim() === label), FORK_OFFER, { timeout: 4000 });
      assert.match(await pill.getAttribute('class'), /wm-cta-echo/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
