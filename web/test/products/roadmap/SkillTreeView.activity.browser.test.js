import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, LABELS, ROADMAP_SHEET, ROADMAP_VERBS } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

for (const width of [744, 1024, 1440]) {
  for (const surface of ['board', 'tree']) {
    hostTest(`Chromium: Activity A and More use the ${width}px destination from ${surface}`, async () => {
      const { page, errors } = await openHost({ width, surface });
      try {
        await page.keyboard.press('a');
        const feed = page.locator(width === 744 ? '.st-roadmap-activity-panel' : '.st-detail-panel--open .st-activity');
        await feed.waitFor();
        assert.equal(await page.locator('button.st-roadmap-icon[aria-haspopup="menu"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), width === 744 ? surface : 'tree');
        await page.keyboard.press('Escape');
        await feed.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.matches('button.st-roadmap-icon[aria-haspopup="menu"]'));
        await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
        await page.getByRole('menuitem', { name: ROADMAP_VERBS.activity }).click();
        await feed.waitFor();
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: the docked Activity head keeps Close at its far end', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.keyboard.press('a');
    const head = page.locator('.st-detail-panel--open .st-activity-head');
    await head.waitFor();
    assert.deepEqual(await head.evaluate((element) => {
      const close = element.querySelector('button');
      return element.getBoundingClientRect().right - parseFloat(getComputedStyle(element).paddingRight) - close.getBoundingClientRect().right;
    }), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: empty tablet Activity uses shipped copy, shrinks, and leaves the Board usable', async () => {
  const { page, errors } = await openHost({ width: 744, empty: true, surface: 'board' });
  try {
    await page.keyboard.press('a');
    const panel = page.locator('.st-roadmap-activity-panel');
    await panel.waitFor();
    assert.equal(await panel.locator('.st-activity-empty').textContent(), ACTIVITY.empty);
    assert.equal(await page.locator('.st-view-layer--board').evaluate((element) => element.inert), false);
    assert.deepEqual(await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, right: innerWidth - bounds.right, top: bounds.top, shrunk: bounds.height < 200 };
    }), { width: 320, right: 16, top: 172, shrunk: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [320, 390]) {
  for (const surface of ['board', 'tree']) {
    hostTest(`Chromium: phone Activity page at ${width}px opens a step over ${surface} and Escape backs out first`, async () => {
      const { page, errors } = await openHost({ width, surface });
      try {
        await page.keyboard.press('a');
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_verb' && props.verb === 'activity')), []);
        const title = page.locator('.st-roadmap-title-button');
        await title.click();
        const roadmap = page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true });
        await roadmap.waitFor();
        const before = await roadmap.evaluate((element) => element.getBoundingClientRect().top);
        await roadmap.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
        const activity = page.getByRole('dialog', { name: ACTIVITY.heading, exact: true });
        await activity.waitFor();
        assert.equal(await activity.evaluate((element) => element.getBoundingClientRect().top), before);
        assert.equal(await activity.locator('.st-roadmap-activity-rows').getAttribute('tabindex'), '-1');
        await page.keyboard.press('Escape');
        await roadmap.waitFor();
        await page.waitForFunction((label) => document.activeElement?.textContent?.trim() === label, ROADMAP_VERBS.activity);
        await page.keyboard.press('Escape');
        await roadmap.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-title-button'));
        await title.click();
        await roadmap.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
        await activity.locator('button.st-event').first().click();
        await activity.waitFor({ state: 'detached' });
        await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
        assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), surface);
        assert.equal(await page.locator('.st-board-step-layer').evaluate((element) => element.contains(document.activeElement)), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: empty phone Activity has shipped copy and Close returns to the roadmap title', async () => {
  const { page, errors } = await openHost({ width: 320, empty: true, surface: 'board' });
  try {
    await page.locator('.st-roadmap-title-button').click();
    await page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true })
      .getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
    const activity = page.getByRole('dialog', { name: ACTIVITY.heading, exact: true });
    await activity.waitFor();
    assert.equal(await activity.locator('.st-activity-empty').textContent(), ACTIVITY.empty);
    assert.equal(await activity.locator('button.st-event').count(), 0);
    await activity.getByRole('button', { name: LABELS.close, exact: true }).click();
    await activity.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-title-button'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
