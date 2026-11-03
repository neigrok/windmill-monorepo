import assert from 'node:assert/strict';
import { hostTest, openHost, origin, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, ASK_AI_PLACEHOLDER, DEMO_BYLINE, DELETE_CONFIRM, EDIT_STEP, FORK_OFFER, LABELS, LINK_COPIED, OPEN_STEP, ROADMAP_SHEET, ROADMAP_VERBS, STEP_DETAIL, backTo, deletedToast } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('wave8');

for (const width of [320, 390]) {
  for (const role of ['owner', 'reader', 'demo']) {
    for (const theme of ['light', 'dark']) {
      hostTest(`Chromium: Graph bar ${role} at ${width}px in ${theme} opens its step and returns to its primary`, async () => {
        const { page, errors } = await openHost({ width, role: role === 'demo' ? 'reader' : role, demo: role === 'demo' });
        try {
          await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
          await page.evaluate(() => window.scene.select('wind'));
          const bar = page.locator('[data-graph-step-bar]');
          await bar.waitFor();
          const palette = await bar.evaluate((element) => {
            const selected = document.documentElement.dataset.theme;
            const background = getComputedStyle(element).backgroundColor;
            document.documentElement.dataset.theme = selected === 'dark' ? 'light' : 'dark';
            const other = getComputedStyle(element).backgroundColor;
            document.documentElement.dataset.theme = selected;
            return { selected, background, other };
          });
          assert.equal(palette.selected, theme);
          assert.notEqual(palette.background, palette.other);
          assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), role === 'owner' ? OPEN_STEP : FORK_OFFER);
          assert.equal(await page.locator('.st-step-name, .st-aim-bar, .st-remove-link-bar, .st-bulk-bar').count(), 0);
          if (role === 'owner') assert.deepEqual(await page.evaluate(() => [window.longPress, window.editTap]), [null, null]);
          await page.waitForFunction(() => window.cameraInsets.bottom >= document.querySelector('[data-graph-step-bar]').getBoundingClientRect().height + 12);
          const before = await page.evaluate(() => window.scene.getViewpoint());
          if (role === 'owner') await bar.getByRole('button', { name: OPEN_STEP, exact: true }).click();
          else await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
          await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
          assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'tree');
          assert.equal(await page.locator('canvas.st-canvas').evaluate((element) => element.inert), true);
          assert.equal(await page.locator('.st-roadmap-identity-host').evaluate((element) => element.inert), true);
          await page.getByRole('button', { name: backTo({ screen: 'Learn to sail' }), exact: true }).click();
          await bar.waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-graph-step-primary'));
          assert.deepEqual(await page.evaluate(() => window.scene.getViewpoint()), before);
          assert.equal(await bar.locator('.st-graph-step-title').textContent(), 'Read the wind');
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

hostTest('Chromium: Graph detail edits through the composer and held delete Undo targets that step', async () => {
  const { page, errors } = await openHost({ width: 390, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
    await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
    await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
    await page.getByRole('dialog', { name: 'Read gusts', exact: true }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.clock.runFor(300);
    await page.locator('.st-graph-toast').waitFor();
    await page.waitForFunction(() => !window.scene.nodesById.has('wind'));
    assert.equal(await page.locator('.st-board-toast-message').textContent(), deletedToast({ step: 'Read gusts' }));
    await page.locator('.st-board-toast-undo').click();
    await page.clock.runFor(300);
    await page.locator('[data-graph-step-bar]').waitFor();
    assert.equal(await page.locator('.st-graph-step-title').textContent(), 'Read gusts');
    assert.equal(await page.evaluate(() => window.scene.nodesById.has('wind')), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: bar Fork returns focus and deselection deliberately focuses the pressed switch', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader' });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    const primary = page.locator('[data-graph-step-primary]');
    await primary.click();
    await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-graph-step-primary'));
    await page.evaluate(() => window.scene.select(null));
    await primary.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.st-board-switch-option[aria-pressed="true"]'));
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_verb' && props.door === 'bar')), [
      { name: 'roadmap_verb', props: { verb: 'fork', door: 'bar', view: 'graph', band: 'phone' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

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

for (const [role, demo] of [['owner', false], ['reader', false], ['reader', true]]) {
  hostTest(`Chromium: view-open is once per visit for ${demo ? 'demo' : role}`, async () => {
    const { page, errors } = await openHost({ role, demo });
    try {
      await page.getByRole('button', { name: 'Board', exact: true }).click();
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_view_open')), [
        { name: 'roadmap_view_open', props: { view: 'graph', band: 'desktop', role: demo ? 'demo' : role, door: role === 'reader' && !demo ? 'default' : 'saved' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

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

for (const width of [1440, 744, 390]) {
  hostTest(`Chromium: demo identity at ${width}px keeps ${width >= 744 ? 'Share and Fork in the Board row' : 'its phone Board offer without a roadmap sheet'}`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true });
    try {
      const row = page.locator('.st-roadmap-identity[data-role="demo"]');
      await row.waitFor();
      assert.equal(await row.getByText(width < 744 ? DEMO_BYLINE.phone : DEMO_BYLINE.wide, { exact: true }).count(), 1);
      assert.equal(await page.locator('.st-demo-board-identity').count(), 0);
      if (width >= 744) {
        await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
        await page.locator('.st-board-toast-message').filter({ hasText: LINK_COPIED }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.copied), [`${origin}/t/t_sail`]);
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        assert.equal(await row.getAttribute('data-view'), 'board');
        await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
        await page.waitForFunction(() => window.copied.length === 2);
        assert.deepEqual(await page.evaluate(() => window.copied), [`${origin}/t/t_sail`, `${origin}/t/t_sail`]);
        assert.equal(await page.locator('.st-board-toast-message').textContent(), LINK_COPIED);
        await row.getByRole('button', { name: ROADMAP_VERBS.fork, exact: true }).click();
      } else {
        assert.equal(await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).count(), 0);
        assert.equal(await row.locator('.st-roadmap-title-button').count(), 0);
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        await page.getByRole('button', { name: FORK_OFFER, exact: true }).click();
      }
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement !== document.body);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [320, 390]) {
  for (const close of ['Escape', 'scrim', 'submit']) {
    hostTest(`Chromium: host phone Ask AI at ${width}px follows the keyboard and ${close} returns to the sheet title`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board' });
      try {
        await page.evaluate(() => {
          const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: 500, offsetTop: 0, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
        });
        const title = page.locator('.st-roadmap-title-button');
        await title.click();
        await page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true })
          .getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
        const input = dialog.getByRole('textbox');
        await input.waitFor();
        await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
        assert.equal(await input.getAttribute('placeholder'), ASK_AI_PLACEHOLDER.phone);
        await page.waitForFunction(() => document.querySelector('.st-tend-overlay form').getBoundingClientRect().bottom === 488);
        assert.equal(await dialog.getAttribute('aria-modal'), 'true');
        if (close === 'Escape') await page.keyboard.press('Escape');
        if (close === 'scrim') await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
        if (close === 'submit') {
          await input.fill('Add a practice step');
          await input.press('Enter');
        }
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-title-button'));
        assert.equal(await title.evaluate((element) => element === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: the host 744 Ask AI overlay follows the measured row and Board filter strip', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'board', shell: true });
  try {
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
    await page.getByRole('menuitem', { name: ROADMAP_VERBS.askAI }).click();
    const dialog = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.wide);
    assert.equal(await page.evaluate(() => {
      const row = document.querySelector('.st-roadmap-identity').getBoundingClientRect();
      const filters = document.querySelector('.st-view-layer--board.is-active .st-board-strip').getBoundingClientRect();
      const form = document.querySelector('.st-tend-overlay form').getBoundingClientRect();
      return form.top === Math.max(row.bottom, filters.bottom) + 16;
    }), true);
    await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('button.st-roadmap-icon[aria-haspopup="menu"]'));
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

for (const width of [320, 390]) {
  hostTest(`Chromium: Graph BoardToast clears a selected bar at ${width}px during a held delete`, async () => {
    const { page, errors } = await openHost({ width, role: 'owner', fixedClock: true });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
      await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
      await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
      await page.clock.runFor(300);
      await page.locator('.st-graph-toast .st-board-toast').waitFor();
      await page.evaluate(() => window.scene.select('course'));
      await page.clock.runFor(300);
      await page.locator('[data-graph-step-bar]').waitFor();
      assert.equal(await page.evaluate(() => {
        const bar = document.querySelector('[data-graph-step-bar]').getBoundingClientRect();
        const toast = document.querySelector('.st-graph-toast .st-board-toast').getBoundingClientRect();
        return toast.bottom <= bar.top;
      }), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: unnamed Graph steps share the detail title rule for owner and reader', async () => {
  for (const role of ['owner', 'reader']) {
    const { page, errors } = await openHost({ width: 390, role });
    try {
      await page.evaluate(() => {
        window.session.dispatch({ kind: 'RenameNode', id: 'wind', label: '   ' });
        window.scene.select('wind');
      });
      const title = page.locator('.st-graph-step-title');
      await title.waitFor();
      assert.equal(await title.textContent(), STEP_DETAIL.unnamed);
      if (role === 'reader') {
        await page.getByRole('button', { name: STEP_DETAIL.unnamed, exact: true }).click();
        await page.getByRole('dialog', { name: STEP_DETAIL.unnamed, exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

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
