import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost({ browserTypes: { chromium, webkit } });

for (const browserName of ['chromium', 'webkit']) {
  for (const input of ['keyboard', 'touch']) {
    hostTest(`${browserName}: real Shell recovery keeps full controls reachable with a sync refusal using ${input}`, async () => {
      const { page, errors } = await openHost({ browserName, width: 568, height: 320, shell: true, clipboardRefused: true, fixedClock: true, touch: true });
      try {
        await page.evaluate(() => window.scene.activate('wind'));
        const step = page.getByRole('article', { name: 'Read the wind', exact: true });
        await step.getByRole('button', { name: 'Complete', exact: true }).tap();
        await page.evaluate(() => {
          session.inFlight.set('first-refusal', session.lattice.toFrame());
          session.receiveReject({ frameId: 'first-refusal', code: 'server-error' });
        });
        const alert = step.getByRole('alert');
        await alert.waitFor();
        await step.getByRole('button', { name: 'More', exact: true }).tap();
        await page.getByRole('menuitem', { name: 'Copy link', exact: true }).tap();
        const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
        await recovery.getByRole('button', { name: 'Show link', exact: true }).tap();
        await page.clock.runFor(100);
        assert.equal(await page.locator('.wm-head').evaluate((node) => node.getBoundingClientRect().height), 52);
        const controls = [];
        for (const control of await recovery.locator('button,input').all()) {
          await control.evaluate((node) => node.scrollIntoView({ block: 'center' }));
          controls.push(await control.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const card = node.closest('.st-step-copy-recovery').getBoundingClientRect();
            return {
              name: node.tagName === 'INPUT' ? 'Step link' : node.getAttribute('aria-label') ?? node.textContent,
              height: box.height,
              full: box.top >= card.top + 1 && box.bottom <= card.bottom - 1,
              hit: [box.top + 2, box.top + box.height / 2, box.bottom - 2].map((y) => node.contains(document.elementFromPoint(box.x + box.width / 2, y))),
            };
          }));
        }
        if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${browserName}-shell-refused-${input}.png` });
        assert.deepEqual(controls, ['Close', 'Step link', 'Try again', 'Select link'].map((name) => ({ name, height: 44, full: true, hit: [true, true, true] })));
        assert.deepEqual(await recovery.evaluate((node) => {
          const card = node.getBoundingClientRect();
          const article = node.closest('article');
          const toolbar = article.querySelector('.st-step-toolbar').getBoundingClientRect();
          const footer = article.querySelector('.st-step-pinned-actions').getBoundingClientRect();
          return { belowRefusal: card.top >= article.querySelector('[role="alert"]').getBoundingClientRect().bottom,
            aboveFooter: card.bottom <= footer.top, toolbarVisible: toolbar.top === 52,
            footerVisible: footer.bottom <= innerHeight, coachHeight: article.querySelector('.st-step-phone-coach').clientHeight };
        }), { belowRefusal: true, aboveFooter: true, toolbarVisible: true, footerVisible: true, coachHeight: 0 });
        assert.deepEqual(await step.locator('.st-step-refusal button, .st-board-step-undo').evaluateAll((buttons) => buttons.map((node) => {
          const box = node.getBoundingClientRect();
          return { name: node.textContent, hit: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
        })), [{ name: 'Discard change', hit: true }, { name: 'Retry', hit: true }, { name: 'Undo', hit: true }]);

        const field = recovery.getByRole('textbox', { name: 'Step link', exact: true });
        const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
        const focusedControl = () => page.evaluate(() => {
          const node = document.activeElement;
          const box = node.getBoundingClientRect();
          const card = node.closest('.st-step-copy-recovery').getBoundingClientRect();
          return { name: node.getAttribute('aria-label') ?? node.textContent, full: box.top >= card.top + 1 && box.bottom <= card.bottom - 1 };
        });
        if (input === 'keyboard') {
          await field.focus();
          await page.keyboard.press(tab);
          assert.deepEqual(await focusedControl(), { name: 'Try again', full: true });
          await page.keyboard.press('Enter');
          await page.keyboard.press(tab);
          assert.deepEqual(await focusedControl(), { name: 'Select link', full: true });
          await page.keyboard.press('Enter');
        } else {
          await recovery.getByRole('button', { name: 'Try again', exact: true }).tap();
          await recovery.getByRole('button', { name: 'Select link', exact: true }).tap();
        }
        const link = `${new URL(page.url()).origin}/t/t_sail#?step=wind`;
        assert.deepEqual(await field.evaluate((node) => [node === document.activeElement, node.value, node.selectionStart, node.selectionEnd]), [true, link, 0, link.length]);
        await alert.getByRole('button', { name: 'Retry', exact: true }).tap();
        await alert.waitFor({ state: 'detached' });
        await page.setViewportSize({ width: 568, height: 844 });
        await page.clock.runFor(100);
        await page.waitForFunction(() => document.querySelector('.st-step-copy-recovery').getBoundingClientRect().height === 244, null, { polling: 50, timeout: 3000 });
        assert.deepEqual(await recovery.evaluate((node) => ({ height: node.getBoundingClientRect().height,
          footerGap: node.closest('article').querySelector('.st-step-pinned-actions').getBoundingClientRect().top - node.getBoundingClientRect().bottom,
          coachHeight: node.closest('article').querySelector('.st-step-phone-coach').clientHeight })), { height: 244, footerGap: 12, coachHeight: 64 });
        await page.setViewportSize({ width: 568, height: 320 });
        await page.evaluate(() => {
          session.inFlight.set('second-refusal', session.lattice.toFrame());
          session.receiveReject({ frameId: 'second-refusal', code: 'server-error' });
        });
        await alert.getByRole('button', { name: 'Discard change', exact: true }).tap();
        await alert.waitFor({ state: 'detached' });
        await page.waitForFunction(() => !session.discardPending && session.rebaselining?.has('structure'));
        await page.evaluate(() => session.receiveState({ ...window.serverTree, seq: 2 }));
        await step.getByRole('button', { name: 'Undo', exact: true }).tap();
        assert.equal(await page.evaluate(() => session.progress.overlay().completed.has('wind')), false);
        if (input === 'keyboard') {
          await field.focus();
          await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
          assert.deepEqual(await focusedControl(), { name: 'Close', full: true });
          await page.keyboard.press('Enter');
        } else {
          await recovery.getByRole('button', { name: 'Close', exact: true }).tap();
        }
        await recovery.waitFor({ state: 'detached' });
        assert.equal(await step.getByRole('button', { name: 'More', exact: true }).evaluate((node) => node === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  for (const options of [
    { role: 'owner', visibility: 'public' },
    { role: 'owner', visibility: 'unlisted' },
    { role: 'owner', visibility: 'private' },
    { role: 'reader', visibility: 'public' },
    { role: 'reader', visibility: 'unlisted' },
    { role: 'reader', visibility: 'public', demo: true },
  ]) {
    hostTest(`${browserName}: the host keeps ${options.role} ${options.visibility}${options.demo ? ' demo' : ''} step-link recovery inside its existing authority`, async () => {
      const workspace = { wind: { note: 'Private preparation note', subtasks: [], links: [] } };
      const { page, errors } = await openHost({ browserName, width: 390, clipboardRefused: true, workspace, ...options });
      try {
        if (options.visibility !== 'public') {
          const data = await page.evaluate(() => window.fixture);
          await page.route('**/v1/trees/t_sail', (route) => route.fulfill({ json: {
            data, root: 't_sail', parent: null, path: [], depth: 0, mine: options.role === 'owner', visibility: options.visibility,
          } }));
          await page.reload();
          await page.waitForFunction(() => window.session?.ready);
          await page.locator('.st-roadmap-progress').waitFor();
        }
        await page.evaluate(() => window.scene.activate('wind'));
        const step = page.getByRole('article', { name: 'Read the wind', exact: true });
        await step.waitFor();
        await step.getByRole('button', { name: 'More', exact: true }).click();
        const shareable = options.visibility !== 'private' && !options.demo;
        assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
          ...(shareable ? ['Copy link'] : []), 'Open in Graph', ...(options.role === 'owner' ? ['Delete step'] : []),
        ]);
        if (shareable) {
          await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
          const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
          await recovery.getByRole('button', { name: 'Show link', exact: true }).click();
          assert.equal(await recovery.getByRole('textbox', { name: 'Step link', exact: true }).inputValue(), `${new URL(page.url()).origin}/t/t_sail#?step=wind`);
          await page.keyboard.press('Escape');
          await recovery.waitFor({ state: 'detached' });
          assert.equal(await step.getByRole('button', { name: 'More', exact: true }).evaluate((control) => control === document.activeElement), true);
          assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_board_step_action' && props.action.startsWith('copyLink'))), [
            { name: 'roadmap_board_step_action', props: { surface: 'document', action: 'copyLink', outcome: 'failed' } },
            { name: 'roadmap_board_step_action', props: { surface: 'document', action: 'copyLinkRecovery', step: 'shown' } },
            { name: 'roadmap_board_step_action', props: { surface: 'document', action: 'copyLinkRecovery', step: 'reveal' } },
            { name: 'roadmap_board_step_action', props: { surface: 'document', action: 'copyLinkRecovery', step: 'dismiss' } },
          ]);
          assert.deepEqual(await page.evaluate(() => window.issues), []);
        }
        assert.equal(await step.locator('.st-board-workspace').count(), options.role === 'owner' ? 1 : 0);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
