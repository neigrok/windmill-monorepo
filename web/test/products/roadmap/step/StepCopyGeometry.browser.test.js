import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStepDetailHost, calls, card } from './stepDetailHost.js';

const host = createStepDetailHost('copy-geometry');
const { start, openRoom } = host;
after(host.close);

for (const engine of ['Chromium', 'WebKit']) {
  for (const options of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 744, height: 960 }, { width: 744, height: 960, expanded: true }, { width: 1440, height: 960 }]) {
    for (const theme of ['light', 'dark']) {
      test(`${engine}: copy recovery fits ${theme} ${options.width}px ${options.expanded ? 'expanded' : 'default'} Coach without covering pinned Undo`, async () => {
        await start();
        const errors = [];
        const page = await openRoom({ engine, viewport: { width: options.width, height: options.height } }, errors);
        try {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            navigator.clipboard.writeText = async () => { throw new DOMException('private detail', 'NotAllowedError'); };
          }, theme);
          await card(page, 'Read the wind').click();
          if (options.expanded) await page.getByRole('button', { name: 'Expand Coach' }).click();
          await page.getByRole('button', { name: 'Complete', exact: true }).click();
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('menuitem', { name: 'Copy link' }).click();
          const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
          await recovery.waitFor();
          await page.evaluate(() => document.fonts.ready);
          const geometry = () => recovery.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const article = node.closest('article');
            const documentBox = article.getBoundingClientRect();
            const actions = article.querySelector('.st-step-pinned-actions').getBoundingClientRect();
            return {
              height: Math.round(box.height),
              inside: box.left >= documentBox.left && box.right <= documentBox.right && box.top >= 0,
              footerGap: Math.round(actions.top - box.bottom),
              modal: !!node.closest('[aria-modal="true"]'),
              controls: [...node.querySelectorAll('button, input')].map((control) => {
                const bounds = control.getBoundingClientRect();
                return bounds.width >= 44 && bounds.height >= 44 && control.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
              }),
            };
          });
          assert.deepEqual(await geometry(), { height: 161, inside: true, footerGap: 12, modal: false, controls: [true, true, true] });
          if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${theme}-${options.width}-${options.expanded ? 'expanded' : 'default'}-failure.png` });
          await recovery.getByRole('button', { name: 'Show link' }).click();
          assert.deepEqual(await geometry(), { height: 244, inside: true, footerGap: 12, modal: false, controls: [true, true, true, true] });
          assert.deepEqual(await recovery.getByRole('textbox').evaluate((input) => [getComputedStyle(input).outlineWidth, getComputedStyle(input).outlineStyle]), ['2px', 'solid']);
          if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${theme}-${options.width}-${options.expanded ? 'expanded' : 'default'}-reveal.png` });
          if (process.env.WM_COPY_SCREENSHOTS && theme === 'dark' && options.width === 390) {
            await recovery.getByRole('button', { name: 'Select link' }).click();
            await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-dark-390-selected.png` });
          }
          assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).evaluate((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }), true);
          assert.deepEqual(errors, []);
        } finally { await page.context().close(); }
      });
    }
  }

  for (const viewport of [{ width: 568, height: 320 }, { width: 844, height: 390 }]) {
    test(`${engine}: copy recovery scrolls within the available landscape region at ${viewport.width}x${viewport.height}`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ engine, viewport }, errors);
      try {
        await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('private detail', 'NotAllowedError'); }; });
        await card(page, 'Read the wind').click();
        await page.getByRole('button', { name: 'Complete', exact: true }).click();
        await page.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Copy link' }).click();
        const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
        await recovery.getByRole('button', { name: 'Show link' }).click();
        const field = recovery.getByRole('textbox', { name: 'Step link', exact: true });
        assert.equal(await field.evaluate((node) => node === document.activeElement), true);
        assert.deepEqual(await recovery.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const article = node.closest('article');
          const area = article.querySelector('.st-step-document-scroll').getBoundingClientRect();
          const footer = article.querySelector('.st-step-pinned-actions').getBoundingClientRect();
          return { belowToolbar: box.top >= area.top, aboveFooter: box.bottom <= area.bottom, footerGap: Math.round(footer.top - box.bottom), fits: box.height <= area.height };
        }), { belowToolbar: true, aboveFooter: true, footerGap: 12, fits: true });
        const select = recovery.getByRole('button', { name: 'Select link' });
        await select.click();
        assert.deepEqual(await field.evaluate((node) => [node === document.activeElement, node.selectionStart, node.selectionEnd, node.value]), [true, 0, 39, 'https://windmill.test/t/sail#?step=wind']);
        if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${viewport.width}x${viewport.height}-selected.png` });
        const undo = page.getByRole('button', { name: 'Undo', exact: true });
        assert.equal(await undo.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true);
        await recovery.hover();
        await page.mouse.wheel(0, -1000);
        const close = recovery.getByRole('button', { name: 'Close', exact: true });
        await page.waitForFunction(() => {
          const node = document.querySelector('.st-step-copy-recovery button[aria-label="Close"]');
          const box = node.getBoundingClientRect();
          return box.top >= 0 && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }, null, { timeout: 3000 });
        if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${viewport.width}x${viewport.height}-close.png` });
        await close.click();
        await recovery.waitFor({ state: 'detached' });
        await undo.click();
        assert.deepEqual(await calls(page), ['complete wind', 'restore wind']);
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }
}
