import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStepDetailHost, calls, events, focusedName } from './stepDetailHost.js';

const host = createStepDetailHost('actions');
after(host.close);

const actionBoxes = (page) => page.locator('.st-step-pinned-actions button').evaluateAll((buttons) => buttons.map((button) => {
  const { x, y, width, height } = button.getBoundingClientRect();
  return { name: button.textContent, x, y, width, height };
}));

for (const engine of ['Chromium', 'WebKit']) {
  for (const viewport of [
    { width: 744, height: 960 },
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
    { width: 1440, height: 960 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
  ]) {
    for (const theme of ['light', 'dark']) {
      test(`${engine}: Reset preview keeps pointer and keyboard Undo stable at ${viewport.width}x${viewport.height} in ${theme}`, { timeout: 20000 }, async () => {
        await host.start();
        const errors = [];
        const page = await host.openRoom({ engine, viewport, start: '#/app/sail?step=wind' }, errors);
        page.setDefaultTimeout(5000);
        try {
          await page.evaluate(async (theme) => {
            document.documentElement.dataset.theme = theme;
            await document.fonts.ready;
          }, theme);
          const complete = page.getByRole('button', { name: 'Complete', exact: true });
          const undo = page.getByRole('button', { name: 'Undo', exact: true });
          const reset = page.getByRole('button', { name: 'Reset', exact: true });
          const preview = page.locator('.st-board-step-preview');
          await complete.click();
          await page.mouse.move(0, 0);
          const beforeHover = await actionBoxes(page);
          await reset.hover();
          if (viewport.width >= 744) await preview.waitFor();
          else assert.equal(await preview.count(), 0);
          const duringHover = await actionBoxes(page);
          const target = duringHover.find((button) => button.name === 'Undo');
          const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
          await page.mouse.move(point.x, point.y);
          await preview.waitFor({ state: 'detached' });
          const afterHover = await actionBoxes(page);
          const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null, point);
          await page.mouse.click(point.x, point.y);
          assert.deepEqual(await calls(page), ['complete wind', 'restore wind'], JSON.stringify({ beforeHover, duringHover, afterHover, hit }));
          assert.equal(hit, 'Undo');
          assert.deepEqual(duringHover, beforeHover);
          assert.deepEqual(afterHover, beforeHover);
          assert.equal(await page.locator('.st-board-step-status-label').textContent(), 'Up next');

          await complete.focus();
          await page.keyboard.press('Enter');
          await undo.focus();
          const beforeFocus = await actionBoxes(page);
          await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
          assert.equal(await focusedName(page), 'Reset');
          await preview.waitFor();
          assert.equal(await preview.textContent(), 'Reset returns 1 step to Locked');
          assert.deepEqual(await actionBoxes(page), beforeFocus);
          assert.deepEqual(await preview.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const article = node.closest('article');
            const documentBox = article.getBoundingClientRect();
            const footer = article.querySelector('.st-step-pinned-actions').getBoundingClientRect();
            return {
              inside: box.left >= documentBox.left && box.right <= documentBox.right && box.top >= documentBox.top,
              aboveFooter: box.bottom <= footer.top,
              readable: node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
              targets: [...article.querySelectorAll('.st-step-pinned-actions button')].map((button) => {
                const target = button.getBoundingClientRect();
                const style = getComputedStyle(button);
                const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
                return target.width >= 44 && target.height >= 44 && target.bottom <= innerHeight
                  && box.bottom < target.top - ring
                  && button.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2));
              }),
            };
          }), { inside: true, aboveFooter: true, readable: true, targets: [true, true] });
          assert.deepEqual(await reset.evaluate((button) => [getComputedStyle(button).outlineWidth, getComputedStyle(button).outlineStyle]), ['2px', 'solid']);
          if (process.env.WM_STEP_ACTION_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_STEP_ACTION_SCREENSHOTS}/${engine}-${theme}-${viewport.width}x${viewport.height}.png` });
          await page.keyboard.press(engine === 'WebKit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
          assert.equal(await focusedName(page), 'Undo');
          await preview.waitFor({ state: 'detached' });
          assert.deepEqual(await actionBoxes(page), beforeFocus);
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('.st-board-step-status-label').textContent(), 'Up next');
          assert.deepEqual(await calls(page), ['complete wind', 'restore wind', 'complete wind', 'restore wind']);
          assert.deepEqual(await events(page), [
            'roadmap_board_step_open {"surface":"document","column":"upNext","door":"link"}',
            'roadmap_board_step_action {"surface":"document","action":"complete"}',
            'roadmap_board_step_action {"surface":"document","action":"undo"}',
            'roadmap_board_step_action {"surface":"document","action":"complete"}',
            'roadmap_board_step_action {"surface":"document","action":"undo"}',
          ]);
          assert.deepEqual(await page.evaluate(() => window.reports ?? []), []);
          assert.deepEqual(errors, []);
        } finally { await page.context().close(); }
      });
    }
  }
}
