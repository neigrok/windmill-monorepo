import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ROADMAP_VERBS, SORT_MENU, nextChip, sortButtonLabel } from '../../../src/products/roadmap/copy.js';

const selectors = {
  more: { trigger: '[data-roadmap-more]', popup: '.st-roadmap-menu', item: '[role="menuitem"]' },
  next: { trigger: '.st-roadmap-popover-anchor .st-roadmap-chip[aria-haspopup="dialog"]', popup: '.st-roadmap-next', item: '.st-roadmap-next-card' },
  sort: { trigger: '.st-board-sort-button', popup: '.st-board-sort-popover', item: '[role="menuitemradio"]' },
};

async function openMenu(page, kind, input = 'click') {
  const { trigger, popup } = selectors[kind];
  await page.locator(trigger)[input]();
  await page.locator(popup).waitFor();
  await page.waitForFunction((selector) => document.querySelector(selector)?.contains(document.activeElement), popup);
}

async function returned(page, kind) {
  const { trigger, popup } = selectors[kind];
  await page.locator(popup).waitFor({ state: 'detached' });
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), trigger);
}

export function menuCases({ browserType, width }) {
  const browserName = browserType.name();
  startRoadmapHost({ browserTypes: { [browserName]: browserType } });

  for (const input of ['click', 'tap']) {
    const options = { browserName, width, touch: input === 'tap' };
    const label = `${browserName}: ${input} at ${width}px`;

    hostTest(`${label} activates every More item and returns focus from its destination`, async () => {
      const { page, errors } = await openHost(options);
      const verbs = [];
      const pick = async (verb, name) => {
        await openMenu(page, 'more', input);
        await page.getByRole('menuitem', { name, exact: true })[input]();
        await page.locator(selectors.more.popup).waitFor({ state: 'detached' });
        verbs.push(verb);
      };
      try {
        if (width === 744) {
          await pick('askAI', ROADMAP_VERBS.askAI);
          const ask = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
          await ask.getByRole('textbox').waitFor();
          await page.keyboard.press('Escape');
          await ask.waitFor({ state: 'detached' });
          await returned(page, 'more');

          await pick('share', ROADMAP_VERBS.shareRoadmap);
          const share = page.getByRole('dialog').filter({ hasText: ROADMAP_VERBS.shareRoadmap });
          await share.waitFor();
          await page.keyboard.press('Escape');
          await share.waitFor({ state: 'detached' });
          await returned(page, 'more');
        }

        await pick('activity', ROADMAP_VERBS.activity);
        await page.locator('[data-roadmap-more][aria-pressed="true"]').waitFor();
        await page.locator(width === 744 ? '.st-roadmap-activity-panel' : '.st-activity').waitFor();
        await returned(page, 'more');
        await pick('activity', ROADMAP_VERBS.activity);
        await page.locator('[data-roadmap-more][aria-pressed="false"]').waitFor();
        await returned(page, 'more');

        await pick('shortcuts', ROADMAP_VERBS.keyboardShortcuts);
        const shortcuts = page.getByRole('dialog').filter({ hasText: ROADMAP_VERBS.keyboardShortcuts });
        await shortcuts.waitFor();
        await page.keyboard.press('Escape');
        await shortcuts.waitFor({ state: 'detached' });
        await returned(page, 'more');

        await openMenu(page, 'more', input);
        const download = page.waitForEvent('download');
        await page.getByRole('menuitem', { name: ROADMAP_VERBS.export, exact: true })[input]();
        assert.equal((await download).suggestedFilename(), 'learn-to-sail-sail.md');
        verbs.push('export');
        await returned(page, 'more');
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_export')), [
          { name: 'roadmap_export', props: { outcome: 'done', door: 'more' } },
        ]);

        await pick('settings', ROADMAP_VERBS.settings);
        await page.waitForFunction(() => location.pathname === '/app/settings');
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_verb' && props.door === 'more')),
          verbs.map((verb) => ({ name: 'roadmap_verb', props: { verb, door: 'more', view: 'graph', band: width === 744 ? 'tablet' : 'desktop' } })));
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`${label} applies every Sort option exactly once and restores its trigger`, async () => {
      const { page, errors } = await openHost({ ...options, surface: 'board' });
      try {
        for (const sort of ['newest', 'oldest', 'roadmap']) {
          await openMenu(page, 'sort', input);
          await page.getByRole('menuitemradio', { name: SORT_MENU.options[sort], exact: sort !== 'roadmap' })[input]();
          await returned(page, 'sort');
          assert.deepEqual(await page.locator(selectors.sort.trigger).evaluate((button) => ({
            label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded'),
          })), { label: sortButtonLabel({ sort }), expanded: 'false' });
        }
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_sort')), [
          { name: 'roadmap_board_sort', props: { sort: 'newest' } },
          { name: 'roadmap_board_sort', props: { sort: 'oldest' } },
          { name: 'roadmap_board_sort', props: { sort: 'roadmap' } },
        ]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`${label} picks What's next without reporting a dismissal`, async () => {
      const { page, errors } = await openHost(options);
      try {
        await openMenu(page, 'next', input);
        await page.locator('.st-roadmap-next-card')[input]();
        await returned(page, 'next');
        await page.waitForFunction(() => window.revealed.at(-1) === 'wind');
        assert.equal(await page.locator(selectors.next.trigger).getAttribute('aria-label'), nextChip({ count: 1 }));
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_whats_next')), [
          { name: 'roadmap_whats_next', props: { step: 'open', count: '1' } },
          { name: 'roadmap_whats_next', props: { step: 'pick', count: '1' } },
        ]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`${label} dismisses all popovers outside and keeps inside presses separate from later focus changes`, async () => {
      for (const kind of ['more', 'next', 'sort']) {
        const { page, errors } = await openHost({ ...options, surface: kind === 'sort' ? 'board' : 'tree' });
        const { popup, trigger } = selectors[kind];
        try {
          await openMenu(page, kind, input);
          const inside = kind === 'more' ? page.locator(popup) : page.locator(kind === 'next' ? '.st-roadmap-next h2' : '.st-board-sort-group');
          const position = kind === 'more' ? { position: { x: 130, y: 4 } } : {};
          // Chromium's touch adjustment snaps a finger anywhere inside More onto an item, so only a pointer presses its padding.
          const press = kind === 'more' && browserName === 'chromium' ? 'click' : input;
          await inside[press](position);
          assert.equal(await page.locator(trigger).getAttribute('aria-expanded'), 'true');
          await page.keyboard.press('Escape');
          await returned(page, kind);

          await openMenu(page, kind, input);
          await inside[press](position);
          await page.locator('.st-board-switch-option[aria-pressed="true"]').focus();
          await page.locator(popup).waitFor({ state: 'detached' });
          assert.equal(await page.locator('.st-board-switch-option[aria-pressed="true"]').evaluate((element) => document.activeElement === element), true);

          await openMenu(page, kind, input);
          await page.locator('.st-roadmap-progress')[input]();
          await page.locator(popup).waitFor({ state: 'detached' });
          assert.equal(await page.locator(trigger).getAttribute('aria-expanded'), 'false');
          if (kind !== 'sort') await returned(page, kind);
          if (kind === 'next') {
            assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_whats_next')),
              Array.from({ length: 3 }, () => [
                { name: 'roadmap_whats_next', props: { step: 'open', count: '1' } },
                { name: 'roadmap_whats_next', props: { step: 'close', count: '1' } },
              ]).flat());
          }
          assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_sort')), []);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    });
  }

  hostTest(`${browserName}: Tab and Shift+Tab leave each popover at ${width}px without stealing destination focus`, async () => {
    // Safari's Tab reaches only text fields; Option+Tab reaches every control, as Tab does in Chromium.
    const [forward, backward] = browserName === 'webkit' ? ['Alt+Tab', 'Alt+Shift+Tab'] : ['Tab', 'Shift+Tab'];
    for (const kind of ['more', 'next', 'sort']) {
      for (const key of [forward, backward]) {
        const { page, errors } = await openHost({ browserName, width, surface: kind === 'sort' ? 'board' : 'tree' });
        const { popup, item } = selectors[kind];
        try {
          await openMenu(page, kind);
          const items = page.locator(popup).locator(item);
          await (key === forward ? items.last() : items.first()).focus();
          await page.keyboard.press(key);
          if (key === backward && kind !== 'more') await page.keyboard.press(key);
          await page.locator(popup).waitFor({ state: 'detached' });
          assert.equal(await page.evaluate(() => document.activeElement !== document.body && document.activeElement.isConnected), true);
          assert.equal(await page.evaluate(() => document.activeElement.closest('.st-roadmap-menu, .st-roadmap-next, .st-board-sort-popover') === null), true);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    }
  });

  if (browserName === 'webkit') {
    hostTest(`webkit: plain Tab from each popover's last item closes it at ${width}px, wherever focus lands`, async () => {
      for (const kind of ['more', 'next', 'sort']) {
        const { page, errors } = await openHost({ browserName, width, surface: kind === 'sort' ? 'board' : 'tree' });
        const { popup, item } = selectors[kind];
        try {
          await openMenu(page, kind);
          await page.locator(popup).locator(item).last().focus();
          await page.keyboard.press('Tab');
          await page.locator(popup).waitFor({ state: 'detached' });
          assert.equal(await page.evaluate(() => document.activeElement.closest('.st-roadmap-menu, .st-roadmap-next, .st-board-sort-popover') === null), true);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    });
  }
}
