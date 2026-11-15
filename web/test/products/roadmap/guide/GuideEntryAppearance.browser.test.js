import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE, hostGuideSurfaces, open } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-entry-appearance-test' });

test('the identity entry represents own, parent, unknown and empty states at every wide band and theme', async () => {
  for (const width of [744, 1024, 1440]) for (const theme of ['light', 'dark']) {
    for (const [state, options, expected] of [
      ['own', { guide: GUIDE }, { label: 'Guide: One step a week.', line: 'One step a week.', count: '' }],
      ['reader', { guide: GUIDE, role: 'reader' }, { label: 'Author’s note: One step a week.', line: 'One step a week.', count: '' }],
      ['parents', { above: [{ treeId: 'life', title: 'My life', text: 'Life guide' }, { treeId: 'year', title: 'My year', text: 'Year guide' }] },
        { label: 'Guide · 2 guides from above', line: '2 guides from above', count: '2' }],
      ['both', { guide: GUIDE, above: [{ treeId: 'life', title: 'My life', text: 'Life guide' }, { treeId: 'year', title: 'My year', text: 'Year guide' }] },
        { label: 'Guide: One step a week. · 2 guides from above', line: '+2 above · One step a week.', count: '2' }],
      ['unknown', { aboveUnread: true }, { label: 'Guide · parent status unknown', line: 'Guide · unknown', count: '?' }],
      ['own-unknown', { guide: GUIDE, aboveUnread: true }, { label: 'Guide · parent status unknown', line: '? · One step a week.', count: '?' }],
      ['empty', {}, { label: 'Add guide', line: 'Add guide', count: '' }],
      ['empty-reader', { role: 'reader' }, null],
    ]) {
      const page = await open({ ...options, band: width < 1024 ? 'tablet' : 'desktop' }, { width, height: 960, reducedMotion: 'reduce' });
      try {
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        await page.evaluate(() => document.fonts.ready);
        const entry = page.locator('.st-guide-entry');
        if (!expected) {
          assert.equal(await entry.count(), 0);
          continue;
        }
        const actual = await entry.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const row = button.closest('.st-roadmap-identity');
          const switchBox = row.querySelector('.st-board-switch').getBoundingClientRect();
          const rowBox = row.getBoundingClientRect();
          const icon = button.querySelector('svg').getBoundingClientRect();
          return { label: button.getAttribute('aria-label'), text: button.textContent, height: box.height,
            width: box.width, afterSwitch: Math.abs(box.left - switchBox.right - 8) < 1,
            insideRow: box.top >= rowBox.top && box.bottom <= rowBox.bottom,
            icon: [icon.width, icon.height], dashed: getComputedStyle(button).borderStyle === 'dashed' };
        });
        assert.deepEqual({ ...actual, width: undefined }, {
          label: expected.label, text: width === 744 ? expected.count : expected.line, height: 44,
          width: undefined, afterSwitch: true, insideRow: true, icon: [20, 20], dashed: state === 'empty',
        }, `${width} ${theme} ${state}`);
        assert.equal(actual.width <= (width === 744 ? 72 : width === 1024 ? 200 : 320), true);
        if (process.env.GUIDE_ARTIFACT_DIR && ['both', 'unknown'].includes(state)) {
          await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/${width}-${theme}-${state}.png` });
        }
      } finally { await page.close(); }
    }
  }
});
