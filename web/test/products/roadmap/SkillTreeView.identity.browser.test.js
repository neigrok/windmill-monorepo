import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ROADMAP_VERBS } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1024, 'desktop'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    for (const surface of ['tree', 'board']) {
      hostTest(`Chromium: host identity contract ${width}px ${role} ${surface}`, async () => {
        const { page, errors } = await openHost({ width, role, surface });
        try {
          await page.waitForFunction((surface) => document.querySelector('.st-roadmap-identity')?.dataset.view === surface, surface);
          assert.deepEqual(await page.locator('.st-roadmap-identity').evaluate((row) => ({
            band: ['phone', 'tablet', 'desktop'].find((value) => row.classList.contains('st-roadmap-identity--' + value)),
            role: row.dataset.role, view: row.dataset.view,
            title: row.querySelector('.st-roadmap-context').textContent,
            progress: row.querySelector('.st-roadmap-progress').getAttribute('aria-label'),
            next: row.querySelector('[aria-label="Next · 1"]') !== null,
            sheet: row.querySelector('.st-roadmap-title-button') !== null,
          })), {
            band, role, view: surface, title: 'Learn to sail', progress: '1 of 3 steps done',
            next: surface === 'tree' && role === 'owner' && band !== 'phone',
            sheet: band === 'phone' && role === 'owner',
          });
          assert.equal(await page.locator('.st-roadmap-identity').count(), 1);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

hostTest('Chromium: one unfinished step has Next · 1 and a completed roadmap has no Next chip', async () => {
  const { page, errors } = await openHost({ single: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 1);
    await page.evaluate(() => window.scene.select('course'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 1 step done');
    assert.equal(await page.getByRole('button', { name: 'Next · 1', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [744, 1024, 1440]) {
  for (const menu of [false, true]) {
    hostTest(`Chromium: Board identity precedes cards and Tab exits ${menu ? 'open menu' : 'More'} at ${width}px`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board' });
      try {
        assert.equal(await page.evaluate(() => {
          const row = document.querySelector('.st-roadmap-identity');
          const board = document.querySelector('.st-board');
          return Boolean(row.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), true);
        const more = page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true });
        if (menu) await more.click();
        else await more.focus();
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.querySelector('.st-board')?.contains(document.activeElement));
        assert.equal(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[inert]')), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: the 744 Activity panel sits below the filter strip with the row menu and sort menu above it', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'board', shell: true });
  try {
    await page.evaluate(() => document.fonts.ready);
    await page.keyboard.press('a');
    const panel = page.locator('.st-roadmap-activity-panel');
    await panel.waitFor();
    assert.deepEqual(await panel.evaluate((element) => {
      const strip = document.querySelector('.st-view-layer--board.is-active .st-board-strip').getBoundingClientRect();
      return { gapBelowStrip: element.getBoundingClientRect().top - strip.bottom, floor: Math.max(172, strip.bottom + 12) === element.getBoundingClientRect().top };
    }), { gapBelowStrip: 12, floor: true });
    await page.getByRole('button', { name: /Roadmap order/ }).click();
    const newest = page.getByRole('menuitemradio', { name: 'Newest first' });
    await newest.click();
    await panel.waitFor();
    await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
    await page.getByRole('menuitem', { name: ROADMAP_VERBS.activity }).click();
    await panel.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('button.st-roadmap-icon[aria-haspopup="menu"]'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the 744 Activity panel keeps its drawn height on the Graph and clears a refusal banner', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'tree', shell: true });
  try {
    await page.keyboard.press('a');
    const panel = page.locator('.st-roadmap-activity-panel');
    await panel.waitFor();
    assert.equal(await panel.evaluate((element) => element.getBoundingClientRect().top), 172);
    await page.evaluate(() => {
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('fixture-refused', session.lattice.frontier());
      session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
    });
    await page.getByRole('alert').waitFor();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-activity-panel').getBoundingClientRect().top
      === document.querySelector('.st-graph-refusal').getBoundingClientRect().bottom + 12);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 744]) {
  hostTest(`Chromium: touch Activity rows at ${width}px wear the drawn sunken avatar, inset badge and 11px kind dot`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      if (width === 744) {
        await page.keyboard.press('a');
      } else {
        await page.locator('.st-roadmap-title-button').click();
        await page.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
      }
      const row = page.locator('.st-roadmap-activity-rows button.st-event', { has: page.locator('.st-event-badge') }).first();
      await row.waitFor();
      assert.deepEqual(await row.evaluate((element) => {
        const box = (part) => {
          const bounds = part.getBoundingClientRect();
          const origin = element.querySelector('.st-event-avatar').getBoundingClientRect();
          return [bounds.left - origin.left, bounds.top - origin.top, bounds.width, bounds.height];
        };
        const avatar = element.querySelector('.st-event-avatar > div');
        const badge = element.querySelector('.st-event-badge');
        const dot = element.querySelector('.st-event-obj i');
        const styles = getComputedStyle(avatar);
        const sunken = document.createElement('i');
        sunken.style.color = 'var(--surface-sunken)';
        document.body.append(sunken);
        const expected = getComputedStyle(sunken).color;
        sunken.remove();
        return {
          avatar: box(avatar), badge: box(badge), dot: [dot.offsetWidth, dot.offsetHeight],
          background: styles.backgroundColor === expected, shadow: styles.boxShadow, size: styles.fontSize, weight: styles.fontWeight,
          ring: getComputedStyle(badge).borderTopWidth,
        };
      }), {
        avatar: [0, 0, 22, 22], badge: [12, 12, 13, 13], dot: [11, 11],
        background: true, shadow: 'none', size: '10px', weight: '700', ring: '2px',
      });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [744, 1024, 1440]) {
  hostTest(`Chromium: with a step selected on the Graph at ${width}px, More and What's next stand over its panel`, async () => {
    const { page, errors } = await openHost({ width, surface: 'tree' });
    const onTop = (locator) => locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
        && element.contains(document.elementFromPoint(box.right - 8, box.top + box.height / 2));
    });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.locator('.st-detail-panel--open').waitFor();
      await page.locator('[data-roadmap-more]').click();
      assert.equal(await onTop(page.locator('.st-roadmap-menu [role="menuitem"]').first()), true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Next/ }).click();
      assert.equal(await onTop(page.locator('.st-roadmap-next-card').first()), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
