import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTreeSwitcherHost, openMenu } from './treeSwitcherHost.js';

const { withSwitcher, close } = createTreeSwitcherHost('mutations');
after(close);

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: touch rename saves through server and device callbacks without row navigation`, async () => {
    await withSwitcher([
      { id: 'sail', title: 'Learn to sail', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
    ], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
      const input = page.getByRole('textbox', { name: 'Tree name' });
      await input.fill('  Device plan  ');
      await input.press('Enter');
      const localRename = page.getByRole('button', { name: 'Rename Device plan' });
      assert.equal(await localRename.evaluate((button) => document.activeElement === button), true);
      await page.getByRole('button', { name: 'Rename Learn to sail' }).tap();
      await input.fill('Sailing plan');
      await page.getByRole('menuitem').first().locator(':scope > span').first().tap();
      await page.getByRole('button', { name: 'Rename Sailing plan' }).waitFor();
      await page.waitForTimeout(250);
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames, hash: location.hash, events: window.events })), {
        renames: [['device', 'Device plan', { local: true }], ['sail', 'Sailing plan', { local: false }]], hash: '',
        events: ['open', 'rename', 'rename'].map((step) => ({ name: 'roadmap_sheet', props: { step, door: 'switcher' } })),
      });
      assert.equal(await page.getByRole('menu').count(), 1);
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: delete keeps its existing callbacks and route while focus follows surviving rows`, async () => {
    await withSwitcher([
      { id: 'sail', title: 'Learn to sail', origin: 'server' },
      { id: 'server', title: 'Another roadmap', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
    ], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      for (const [title, next] of [['Another roadmap', 'Device roadmap'], ['Device roadmap', 'Learn to sail']]) {
        await page.getByRole('button', { name: `Delete ${title}` }).tap();
        await page.getByRole('button', { name: 'Delete', exact: true }).tap();
        await page.getByRole('button', { name: `Delete ${title}` }).waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('menuitem').filter({ hasText: next }).evaluate((row) => document.activeElement === row), true);
        assert.equal(await page.evaluate(() => location.hash), '');
      }
      await page.getByRole('button', { name: 'Delete Learn to sail' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#fixture [aria-haspopup="menu"]').evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({ deletes: window.deletes, hash: location.hash, events: window.events })), {
        deletes: [['server', { local: false }], ['device', { local: true }], ['sail', { local: false }]], hash: '#/app',
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          ...['account', 'device', 'account'].map((place) => ({ name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place } })),
        ],
      });
    }, { engine, width: 1023, touch: true });
  });

  test(`${engine}: failed mutations retain static failure operations and bounded events`, async () => {
    await withSwitcher([{ id: 'device', title: 'Device roadmap', origin: 'device', claimed: false }], async (page) => {
      await page.evaluate(() => { window.failRename = true; window.failDelete = true; });
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
      await page.getByRole('textbox', { name: 'Tree name' }).fill('Private draft');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Delete Device roadmap' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      const del = page.getByRole('button', { name: 'Delete Device roadmap' });
      await del.waitFor();
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({
        failures: window.failures.map(([kind, operation, stack, route, tags]) => ({ kind, operation, private: /Private/.test(stack), route, tags })),
        events: window.events, hash: location.hash,
      })), {
        failures: ['rename', 'delete'].map((action) => ({ kind: 'roadmap', operation: `roadmap-switcher-${action}`, private: false, route: '#/app', tags: undefined })),
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          { name: 'roadmap_sheet', props: { step: 'rename', door: 'switcher', outcome: 'failed' } },
          { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', outcome: 'failed', place: 'device' } },
        ], hash: '',
      });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: a delayed delete does not take focus from a later action`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Delete Another roadmap' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      const nextAction = page.getByRole('menuitem', { name: 'New tree', exact: true });
      await nextAction.focus();
      await page.evaluate(() => window.finishDelete());
      await page.getByRole('button', { name: 'Delete Another roadmap' }).waitFor({ state: 'detached' });
      assert.equal(await nextAction.evaluate((button) => document.activeElement === button), true);
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: pending deletion preserves later claims, renames and other deletions`, async () => {
    await withSwitcher([
      { id: 'other', title: 'Another roadmap', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
      { id: 'rename', title: 'Roadmap to rename', origin: 'server' },
      { id: 'third', title: 'Third roadmap', origin: 'server' },
    ], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await openMenu(page);
      await page.getByRole('button', { name: 'Delete Another roadmap' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } })));
      await page.getByRole('button', { name: 'Rename Device roadmap' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Rename Roadmap to rename' }).click();
      await page.getByRole('textbox', { name: 'Tree name' }).fill('Saved after delete began');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Delete Third roadmap' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.evaluate(() => window.finishDeletes.third());
      await page.getByRole('button', { name: 'Delete Third roadmap' }).waitFor({ state: 'detached' });
      await page.evaluate(() => window.finishDeletes.other());
      await page.getByRole('button', { name: 'Delete Another roadmap' }).waitFor({ state: 'detached' });
      assert.deepEqual(await page.locator('.st-switcher-row').evaluateAll((rows) => rows.map((row) => ({ title: row.querySelector('[title]')?.textContent, actions: [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')) }))), [
        { title: 'Learn to sail', actions: [] },
        { title: 'Device roadmap', actions: [] },
        { title: 'Saved after delete began', actions: ['Rename Saved after delete began', 'Delete Saved after delete began'] },
      ]);
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames, deletes: window.deletes, events: window.events })), {
        renames: [['rename', 'Saved after delete began', { local: false }]],
        deletes: [['other', { local: false }], ['third', { local: false }]],
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          { name: 'roadmap_sheet', props: { step: 'rename', door: 'switcher' } },
          ...Array.from({ length: 2 }, () => ({ name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } })),
        ],
      });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: a claim during confirmation remains in force after another delete`, async () => {
    await withSwitcher([
      { id: 'other', title: 'Another roadmap', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
    ], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await openMenu(page);
      await page.getByRole('button', { name: 'Delete Another roadmap' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('button', { name: 'Delete Device roadmap' }).click();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } })));
      await page.evaluate(() => { window.deferDelete = false; window.finishDelete(); });
      await page.getByRole('button', { name: 'Delete Another roadmap' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.deletes), [['other', { local: false }]]);
      assert.equal(await page.getByRole('menuitem').filter({ hasText: 'Device roadmap' }).getByRole('button').count(), 0);
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: held Enter cannot confirm deletion or submit duplicate pending mutations`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await openMenu(page);
      const action = page.getByRole('button', { name: 'Delete Another roadmap' });
      await action.focus();
      await page.keyboard.down('Enter');
      await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
      for (let repeat = 0; repeat < 3; repeat += 1) await page.keyboard.down('Enter');
      assert.deepEqual(await page.evaluate(() => window.deletes ?? []), []);
      await page.keyboard.up('Enter');
      await page.keyboard.press('Enter');
      await action.waitFor();
      for (let press = 0; press < 3; press += 1) await page.keyboard.press('Enter');
      await action.click();
      assert.deepEqual(await page.evaluate(() => window.deletes), [['other', { local: false }]]);
      await action.focus();
      await page.keyboard.down('Enter');
      await page.evaluate(() => window.finishDelete());
      await action.waitFor({ state: 'detached' });
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      assert.equal(await page.getByRole('menu').count(), 1);
      assert.equal(await page.evaluate(() => location.hash), '');
      assert.deepEqual(await page.evaluate(() => window.events), [
        { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
        { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
      ]);
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: a failed pending delete permits a fresh intentional retry`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await openMenu(page);
      await page.getByRole('button', { name: 'Delete Another roadmap' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.evaluate(() => window.rejectDelete(new Error('Private delete failure')));
      await page.waitForFunction(() => window.events.some((event) => event.props.outcome === 'failed'));
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
      await page.keyboard.press('Enter');
      await page.evaluate(() => window.finishDelete());
      await page.getByRole('button', { name: 'Delete Another roadmap' }).waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => ({ deletes: window.deletes, events: window.events })), {
        deletes: [['other', { local: false }], ['other', { local: false }]],
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', outcome: 'failed', place: 'account' } },
          { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
        ],
      });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: a pending current-tree delete respects later route and menu departures`, async () => {
    for (const departure of ['browse', 'switch', 'close', 'reopen']) {
      await withSwitcher([
        { id: 'sail', title: 'Learn to sail', origin: 'server' },
        { id: 'other', title: 'Another roadmap', origin: 'server' },
      ], async (page) => {
        await page.evaluate(() => { window.deferDelete = true; });
        await openMenu(page);
        await page.getByRole('button', { name: 'Delete Learn to sail' }).click();
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        if (departure === 'browse') await page.getByRole('menuitem', { name: 'Browse trees planted in public' }).click();
        if (departure === 'switch') await page.getByRole('menuitem').filter({ hasText: 'Another roadmap' }).locator('[title]').click();
        if (departure === 'close' || departure === 'reopen') await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        if (departure === 'reopen') {
          await openMenu(page);
          await page.getByRole('button', { name: 'Rename Another roadmap' }).focus();
        }
        const before = await page.evaluate(() => ({ hash: location.hash, focus: document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent }));
        await page.evaluate(() => window.finishDelete());
        await page.waitForFunction(() => window.events.some((event) => event.props.step === 'delete'));
        assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, focus: document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent })), before);
        assert.equal(await page.getByRole('menu').count(), departure === 'reopen' ? 1 : 0);
        assert.deepEqual(await page.evaluate(() => window.deletes), [['sail', { local: false }]]);
      }, { engine, width: 744, touch: true });
    }
  });

  for (const [action, claimAtEnter] of [['rename', false], ['rename', true], ['delete', false]]) {
    test(`${engine}: a device claim while ${action} is open cannot use a server mutation callback${claimAtEnter ? ' when Enter preempts the claim render' : ''}`, async () => {
      await withSwitcher([{ id: 'device', title: 'Device roadmap', origin: 'device', claimed: false }], async (page) => {
        await page.locator('#fixture [aria-haspopup="menu"]').tap();
        if (action === 'rename') {
          await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
          await page.getByRole('textbox', { name: 'Tree name' }).fill('Claimed draft');
        } else {
          await page.getByRole('button', { name: 'Delete Device roadmap' }).tap();
        }
        await page.evaluate((claimAtEnter) => {
          const claim = () => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } }));
          // A claim can reach the registry before React renders it, then Enter closes the editor first.
          if (claimAtEnter) return void document.addEventListener('keydown', claim, { capture: true, once: true });
          claim();
        }, claimAtEnter);
        if (action === 'rename') await page.keyboard.press('Enter');
        else await page.getByRole('button', { name: 'Delete', exact: true }).tap();
        assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], previews: window.previews ?? [], events: window.events, hash: location.hash })), {
          renames: [], deletes: [], previews: action === 'rename' ? [['device', 'Claimed draft'], ['device', 'Device roadmap']] : [],
          events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }], hash: '',
        });
        const row = page.getByRole('menuitem').filter({ hasText: 'Device roadmap' });
        await page.waitForFunction((element) => document.activeElement === element && element.querySelectorAll('button').length === 0, await row.elementHandle());
        assert.equal(await row.evaluate((element) => document.activeElement === element), true);
        assert.equal(await row.getByRole('button').count(), 0);
      }, { engine, width: 744, touch: true });
    });
  }
}

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: current-tree deletion waits for navigation admission before deleting or closing`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      await page.evaluate(async () => {
        const { registerNavigationGuard } = await import('/src/shell/navigation.js');
        registerNavigationGuard({ blocked: () => true, onBlocked: (notice) => { window.navigationNotice = notice; }, onUnrestorableNavigation() {} });
      });
      await openMenu(page);
      await page.getByRole('button', { name: 'Delete Learn to sail' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => ({ deletes: window.deletes ?? [], events: window.events, hash: location.hash })), {
        deletes: [], events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }], hash: '',
      });
      await page.evaluate(() => window.navigationNotice.cancel());
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.evaluate(() => { window.navigationNotice.proceed(); window.navigationNotice.proceed(); });
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => ({ deletes: window.deletes, hash: location.hash })), { deletes: [['sail', { local: false }]], hash: '#/app' });
    }, { engine, width: 744, touch: true });
  });
}
