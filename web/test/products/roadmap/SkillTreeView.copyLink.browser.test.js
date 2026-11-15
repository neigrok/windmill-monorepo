import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost({ browserTypes: { chromium, webkit } });

for (const browserName of ['chromium', 'webkit']) {
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
