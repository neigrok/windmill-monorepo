import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost({ browserTypes: { chromium, webkit }, port: 5440 });

hostTest('Chromium: tablet Board load error retains account navigation without owner verbs', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'board', shell: true, loadFailure: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Your roadmaps', exact: true }).count(), 1);
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-role'), 'reader');
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const browserName of ['chromium', 'webkit']) {
  for (const width of [743, 744, 1023, 1024]) {
    hostTest(`${browserName}: load-error recovery is limited to the tablet Board at ${width}px`, async () => {
      const { page, errors } = await openHost({ browserName, width, surface: 'board', shell: true, loadFailure: true });
      try {
        const eligible = width >= 744 && width < 1024;
        assert.equal(await page.locator('.st-recovery-trigger').count(), eligible ? 1 : 0);
        assert.equal(await page.locator('.st-roadmap-progress, .st-roadmap-title, [data-roadmap-more]').count(), 0);
        if (eligible) {
          await page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
          await page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
          assert.deepEqual(await page.locator('.st-recovery-trigger').evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const panel = document.querySelector('.st-recovery-panel').getBoundingClientRect();
            return { trigger: [rect.x, rect.y, rect.height], panel: [panel.x, panel.y, panel.width], rows: [...document.querySelectorAll('.st-recovery-pick, .st-recovery-action')].map((row) => row.getBoundingClientRect().height) };
          }), { trigger: [24, 62, 44], panel: [24, 116, 356], rows: [44, 44, 44] });
          assert.equal(await page.getByRole('button', { name: 'Open Learn to sail', exact: true }).count(), 0);
          assert.equal(await page.locator('.st-recovery-panel [aria-current], .st-recovery-panel [aria-checked]').count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1);
        }
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest(`${browserName}: account list failure retries independently, announces its result and navigates real rows`, async () => {
    const { page, errors, requests } = await openHost({ browserName, width: 744, surface: 'board', shell: true, loadFailure: true, deviceTrees: true });
    try {
      let calls = 0;
      await page.route('**/v1/trees', (route) => {
        calls += 1;
        if (calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trees: [
          { id: 't_year', title: 'My year' }, { id: 't_read', title: 'Reading list', openers: [{ treeId: 't_year', steps: 1 }] },
        ] }) });
      });
      const requestedReads = requests.filter((path) => path === '/v1/trees/t_sail').length;
      const trigger = page.getByRole('button', { name: 'Your roadmaps', exact: true });
      await trigger.click();
      const retry = page.getByRole('button', { name: 'Retry list', exact: true });
      await retry.waitFor();
      assert.equal(await retry.evaluate((element) => document.activeElement === element), true, await page.evaluate(() => document.activeElement.outerHTML));
      assert.equal(await page.getByRole('status').filter({ hasText: 'Couldn’t load your roadmaps.' }).count(), 1);
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.equal(await page.getByText('Local practice', { exact: true }).count(), 0);
      assert.equal(await page.getByText('No roadmaps in this account.', { exact: true }).count(), 0);
      await page.keyboard.press('Enter');
      const search = page.getByRole('textbox', { name: 'Search roadmaps', exact: true });
      await search.waitFor();
      assert.equal(await search.evaluate((element) => document.activeElement === element), true);
      assert.equal(await page.getByRole('dialog', { name: 'Your roadmaps', exact: true }).count(), 1);
      assert.equal(await page.getByRole('status').filter({ hasText: 'Roadmaps loaded.' }).count(), 1);
      assert.equal(requests.filter((path) => path === '/v1/trees/t_sail').length, requestedReads);
      assert.equal(calls, 2);
      await page.getByRole('button', { name: 'Expand My year', exact: true }).click();
      assert.equal(await page.locator('.st-recovery-row--child').textContent(), 'Reading list');
      assert.equal(await page.getByRole('button', { name: 'Expand Reading list', exact: true }).count(), 0);
      await search.fill('Reading');
      assert.deepEqual(await page.locator('.st-recovery-pick').allTextContents(), ['Reading list']);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('button', { name: 'Open Reading list', exact: true }).evaluate((element) => document.activeElement === element), true);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => location.hash === '#/app/t_read');
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.goBack();
      assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail');
      const telemetry = await page.evaluate(() => ({
        events: window.events.filter((event) => event.name === 'roadmap_recovery'),
        issues: window.issues.filter((issue) => issue.operation === 'roadmap-recovery-list'),
      }));
      assert.deepEqual(telemetry.events, [
        { name: 'roadmap_recovery', props: { step: 'open', place: 'account' } },
        { name: 'roadmap_recovery', props: { step: 'list', place: 'account', outcome: 'failed' } },
        { name: 'roadmap_recovery', props: { step: 'retry', place: 'account' } },
        { name: 'roadmap_recovery', props: { step: 'list', place: 'account', outcome: 'available' } },
        { name: 'roadmap_recovery', props: { step: 'expand', place: 'account' } },
        { name: 'roadmap_recovery', props: { step: 'search', place: 'account' } },
        { name: 'roadmap_recovery', props: { step: 'switch', place: 'account' } },
      ]);
      assert.deepEqual(telemetry.issues, [{ operation: 'roadmap-recovery-list', stack: true, tags: { place: 'account', reason: 'server' } }]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`${browserName}: successful empty list focuses the first action; Escape and outside clicks preserve focus`, async () => {
    const { page, errors, requests } = await openHost({ browserName, width: 1023, surface: 'board', shell: true, loadFailure: true });
    try {
      await page.route('**/v1/trees', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"trees":[]}' }));
      const trigger = page.getByRole('button', { name: 'Your roadmaps', exact: true });
      await trigger.click();
      await page.getByText('No roadmaps in this account.', { exact: true }).waitFor();
      const newTree = page.getByRole('button', { name: 'New tree', exact: true });
      assert.equal(await newTree.evaluate((element) => document.activeElement === element), true, await page.evaluate(() => document.activeElement.outerHTML));
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Retry list', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await trigger.click();
      await page.getByText('No roadmaps in this account.', { exact: true }).waitFor();
      const reads = requests.filter((path) => path === '/v1/trees').length;
      const tryAgain = page.getByRole('button', { name: 'Try again', exact: true });
      await tryAgain.click();
      await page.waitForFunction(() => !document.querySelector('.st-recovery-panel'));
      await tryAgain.waitFor();
      assert.equal(requests.filter((path) => path === '/v1/trees').length, reads);
      // A stable outside action keeps its own focus rather than restoring the trigger.
      await trigger.click();
      await page.getByText('No roadmaps in this account.', { exact: true }).waitFor();
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Outside action';
        button.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:100';
        document.body.append(button);
      });
      const outside = page.getByRole('button', { name: 'Outside action', exact: true });
      await outside.click();
      assert.equal(await page.locator('.st-recovery-panel').count(), 0);
      // WebKit does not focus buttons on a pointer click; it must never focus the recovery trigger.
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), false);
      await outside.focus();
      assert.equal(await outside.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`${browserName}: list loading stays distinct from empty and a late answer cannot reopen or steal focus`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, surface: 'board', shell: true, loadFailure: true });
    let finish;
    try {
      await page.route('**/v1/trees', async (route) => {
        await new Promise((resolve) => { finish = resolve; });
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"trees":[]}' });
      });
      const trigger = page.getByRole('button', { name: 'Your roadmaps', exact: true });
      await trigger.click();
      await page.getByText('Loading your roadmaps…', { exact: true }).waitFor();
      assert.equal(await page.getByText('No roadmaps in this account.', { exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      finish();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('.st-recovery-panel').count(), 0);
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(await page.evaluate(() => window.events.filter((event) => event.name === 'roadmap_recovery')), [
        { name: 'roadmap_recovery', props: { step: 'open', place: 'account' } },
        { name: 'roadmap_recovery', props: { step: 'close', place: 'account' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { finish?.(); await page.close(); }
  });

  for (const address of ['?view', '#/t/', '#/demo', '/t/']) {
    hostTest(`${browserName}: signed-in shared ${address} has no recovery control or account list read`, async () => {
      const { page, errors, requests } = await openHost({ browserName, width: 744, surface: 'board', shell: true, auth: 'signed-in', role: 'reader', appUrl: true, address, loadFailure: true });
      try {
        assert.equal(await page.locator('.st-recovery-trigger').count(), 0);
        assert.equal(requests.filter((path) => path === '/v1/trees').length, 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest(`${browserName}: confirmed anonymous device route lists only readable local records and retries index failure`, async () => {
    const { page, errors, requests } = await openHost({ browserName, width: 744, surface: 'board', shell: true, role: 'reader', auth: 'ghost', appUrl: true, loadFailure: true, deviceTrees: true });
    try {
      const trigger = page.getByRole('button', { name: 'On this device', exact: true });
      await trigger.click();
      await page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
      assert.deepEqual(await page.locator('.st-recovery-pick').allTextContents(), ['Local practice']);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.savedDeviceIndex = localStorage.getItem('windmill:device-trees'); localStorage.setItem('windmill:device-trees', '{'); });
      await trigger.click();
      await page.getByRole('button', { name: 'Retry list', exact: true }).waitFor();
      assert.equal(await page.getByText('No roadmaps on this device.', { exact: true }).count(), 0);
      await page.evaluate(() => localStorage.setItem('windmill:device-trees', window.savedDeviceIndex));
      await page.getByRole('button', { name: 'Retry list', exact: true }).click();
      await page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
      assert.deepEqual(await page.locator('.st-recovery-pick').allTextContents(), ['Local practice']);
      assert.equal(requests.filter((path) => path === '/v1/trees').length, 0);
      assert.deepEqual(await page.evaluate(() => window.issues.filter((issue) => issue.operation === 'roadmap-recovery-list')), [
        { operation: 'roadmap-recovery-list', stack: true, tags: { place: 'device', reason: 'read' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`${browserName}: anonymous unknown failed route never asserts device ownership`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, surface: 'board', role: 'reader', auth: 'ghost', appUrl: true, loadFailure: true });
    try {
      assert.equal(await page.locator('.st-recovery-trigger').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const browserName of ['chromium', 'webkit']) {
  for (const failure of ['auth', 'network', 'shape']) {
    hostTest(`${browserName}: ${failure} list response is a failure with Retry list, never an empty account`, async () => {
      const { page, errors } = await openHost({ browserName, width: 744, surface: 'board', loadFailure: true });
      try {
        await page.route('**/v1/trees', (route) => {
          if (failure === 'network') return route.abort('failed');
          return route.fulfill({ status: failure === 'auth' ? 401 : 200, contentType: 'application/json', body: '{}' });
        });
        await page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
        await page.getByRole('button', { name: 'Retry list', exact: true }).waitFor();
        assert.equal(await page.getByText('Couldn’t load your roadmaps.', { exact: true }).count(), 1);
        assert.equal(await page.getByText('No roadmaps in this account.', { exact: true }).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.issues.filter((issue) => issue.operation === 'roadmap-recovery-list')), [
          { operation: 'roadmap-recovery-list', stack: true, tags: { place: 'account', reason: failure } },
        ]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest(`${browserName}: recovery leaves on a band or auth change, and does not appear for a loaded reader or failed Graph`, async () => {
    const failed = await openHost({ browserName, width: 744, surface: 'board', loadFailure: true });
    try {
      await failed.page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
      await failed.page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
      await failed.page.setViewportSize({ width: 1024, height: 1000 });
      await failed.page.locator('.st-recovery-trigger').waitFor({ state: 'detached' });
      await failed.page.setViewportSize({ width: 744, height: 1000 });
      await failed.page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
      await failed.page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
      await failed.page.evaluate(() => window.setFixtureAuth('ghost'));
      await failed.page.locator('.st-recovery-trigger').waitFor({ state: 'detached' });
      assert.deepEqual(failed.errors, []);
    } finally { await failed.page.close(); }
    for (const options of [{ role: 'reader', auth: 'signed-in', appUrl: true, surface: 'board' }, { surface: 'tree', loadFailure: true }]) {
      const { page, errors } = await openHost({ browserName, width: 744, ...options });
      try {
        assert.equal(await page.locator('.st-recovery-trigger').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  hostTest(`${browserName}: unavailable localStorage never establishes device ownership`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, surface: 'board', role: 'reader', auth: 'ghost', appUrl: true, loadFailure: true, storageRefused: true });
    try {
      assert.equal(await page.locator('.st-recovery-trigger').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.issues.filter((issue) => issue.operation === 'roadmap-recovery-list')), [
        { operation: 'roadmap-recovery-list', stack: true, tags: { place: 'device', reason: 'index' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`${browserName}: the account list times out into retry without changing requested-tree recovery`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, surface: 'board', loadFailure: true });
    try {
      await page.clock.install();
      await page.route('**/v1/trees', () => {});
      await page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
      await page.getByText('Loading your roadmaps…', { exact: true }).waitFor();
      await page.clock.runFor(15001);
      await page.getByRole('button', { name: 'Retry list', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1);
      assert.equal(await page.getByText('No roadmaps in this account.', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: approved recovery tokens and geometry carry light and dark states', async () => {
  const { page, errors } = await openHost({ width: 744, height: 960, surface: 'board', shell: true, loadFailure: true });
  try {
    await page.route('**/v1/trees', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trees: [
      { id: 't_year', title: 'My year' }, { id: 't_read', title: 'Reading list', openers: [{ treeId: 't_year', steps: 1 }] },
    ] }) }));
    await page.getByRole('button', { name: 'Your roadmaps', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search roadmaps' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        for (const scope of document.querySelectorAll('[data-theme]')) scope.setAttribute('data-theme', theme);
      }, theme);
      assert.deepEqual(await page.locator('.st-recovery-panel').evaluate((element) => {
        const style = getComputedStyle(element);
        const token = document.createElement('span');
        token.style.color = 'var(--surface-card)';
        element.append(token);
        const background = getComputedStyle(token).color;
        token.remove();
        return { width: element.getBoundingClientRect().width, padding: style.padding, radius: style.borderRadius, backgroundMatches: style.backgroundColor === background,
          focus: getComputedStyle(element.querySelector('.st-recovery-search')).outlineWidth };
      }), { width: 356, padding: '12px', radius: '14px', backgroundMatches: true, focus: '2px' });
      if (process.env.WM_RECOVERY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_RECOVERY_SCREENSHOTS}/recovery-${theme}.png` });
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
