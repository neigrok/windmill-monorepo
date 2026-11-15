import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStepDetailHost, calls, card, events, focusedName, hash } from './stepDetailHost.js';

const host = createStepDetailHost('copy-recovery');
const { start, openRoom } = host;
after(host.close);

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: copy recovery shows a clipboard refusal and focuses Try again after the phone menu closes`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 } }, errors);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = () => { throw new DOMException('private clipboard detail', 'NotAllowedError'); }; });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.waitForFunction(() => window.events.some((line) => line.includes('"outcome":"failed"')));
      await page.locator('.st-step-copy-recovery').waitFor({ timeout: 3000 });
      assert.equal(await page.getByRole('heading', { name: 'Couldn’t copy link', exact: true }).count(), 1);
      await page.waitForFunction(() => document.activeElement.textContent === 'Try again');
      assert.deepEqual([await page.getByRole('menu').count(), await calls(page), await page.evaluate(() => window.reports ?? []), await events(page)], [0, [], [], [
        'roadmap_board_step_open {"surface":"document","column":"upNext","door":"card"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
      ]]);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  test(`${engine}: copy recovery retries, reveals the full address, selects it and reports success once`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 744, height: 960 } }, errors);
    try {
      await page.evaluate(() => {
        window.copyRequests = [];
        navigator.clipboard.writeText = async (link) => {
          window.copyRequests.push(link);
          if (window.copyRequests.length === 1) throw new DOMException('private clipboard detail', 'NotAllowedError');
          if (window.copyRequests.length === 2) throw new Error('private clipboard detail');
        };
        window.setLinkPrefix('https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=');
      });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
      await recovery.waitFor();
      assert.equal(await recovery.textContent(), 'Couldn’t copy linkTry again or select the link manually.Try againShow link');
      assert.equal(await recovery.getByRole('textbox').count(), 0);
      await page.waitForFunction(() => document.activeElement.textContent === 'Try again');
      await page.evaluate(() => {
        window.copyAnnouncements = [];
        const status = [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent === 'Couldn’t copy link');
        new MutationObserver(() => window.copyAnnouncements.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
      });
      await recovery.getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => (window.reports ?? []).length === 1);
      assert.equal(await recovery.textContent(), 'Couldn’t copy linkTry again or select the link manually.Try againShow link');
      await recovery.getByRole('button', { name: 'Show link' }).click();
      const field = recovery.getByRole('textbox', { name: 'Step link', exact: true });
      await page.waitForFunction(() => document.activeElement.matches('input[readonly]'));
      assert.deepEqual(await field.evaluate((input) => [input.value, input.readOnly]), ['https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=wind', true]);
      await recovery.getByRole('button', { name: 'Select link' }).click();
      assert.deepEqual(await field.evaluate((input) => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 0, 94]);
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Try again');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Select link');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      assert.equal(await focusedName(page), 'Complete');
      assert.deepEqual(await page.evaluate(() => window.copyAnnouncements), []);
      await recovery.getByRole('button', { name: 'Try again' }).focus();
      await page.keyboard.press('Enter');
      await recovery.waitFor({ state: 'detached' });
      assert.equal(await focusedName(page), 'More');
      assert.deepEqual(await page.evaluate(() => [window.copyRequests, window.reports, window.calls]), [
        Array(3).fill('https://windmill.test/t/sail?preserve=the-full-current-address-and-its-entire-query#?step=wind'),
        ['roadmap-step-copy'], ['notify Link copied'],
      ]);
      assert.deepEqual((await events(page)).slice(1), [
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"reveal"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"select"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}',
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  for (const dismiss of ['Escape', 'Close']) {
    test(`${engine}: copy recovery ${dismiss} restores More, cancels late retry feedback and prevents simultaneous clipboard writes`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ engine, viewport: { width: 390, height: 844 } }, errors);
      try {
        await page.evaluate(() => {
          window.copyRequests = [];
          navigator.clipboard.writeText = (link) => new Promise((resolve, reject) => {
            window.copyRequests.push(link);
            window.finishCopy = resolve;
            window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError'));
          });
        });
        await card(page, 'Read the wind').click();
        await page.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Copy link' }).click();
        await page.getByRole('button', { name: 'More' }).click();
        assert.equal(await page.getByRole('menuitem', { name: 'Copy link' }).getAttribute('aria-disabled'), 'true');
        await page.keyboard.press('Enter');
        assert.deepEqual([await page.getByRole('menu').count(), await focusedName(page)], [1, 'Copy link']);
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.evaluate(() => window.copyRequests), ['https://windmill.test/t/sail#?step=wind']);
        await page.evaluate(() => window.refuseCopy());
        const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
        await recovery.waitFor();
        assert.equal(await focusedName(page), 'More');
        await recovery.getByRole('button', { name: 'Try again' }).focus();
        await recovery.getByRole('button', { name: 'Try again' }).click();
        await page.keyboard.press('Enter');
        assert.equal(await recovery.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await page.evaluate(() => window.copyRequests), Array(2).fill('https://windmill.test/t/sail#?step=wind'));
        if (dismiss === 'Escape') await page.keyboard.press('Escape');
        else await recovery.getByRole('button', { name: 'Close', exact: true }).click();
        await recovery.waitFor({ state: 'detached' });
        assert.equal(await focusedName(page), 'More');
        await page.evaluate(() => window.refuseCopy());
        await page.waitForFunction(() => window.events.filter((line) => line.includes('"outcome":"failed"')).length === 2);
        assert.deepEqual([await recovery.count(), await calls(page), await focusedName(page), await hash(page)], [0, [], 'More', '#/app/sail?step=wind']);
        assert.deepEqual((await events(page)).slice(1), [
          'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"retry"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"dismiss"}',
          'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
        ]);
        await page.keyboard.press('Escape');
        await page.getByRole('article').waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }

  for (const change of ['step', 'link', 'eligibility', 'close']) {
    test(`${engine}: copy recovery ignores delayed results after ${change} changes, including a return to the same step address`, async () => {
      await start();
      for (const result of ['ok', 'failed']) {
        const errors = [];
        const page = await openRoom({ engine, viewport: { width: 1440, height: 960 } }, errors);
        try {
          await page.evaluate(() => {
            navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
              window.finishCopy = (result) => result === 'ok' ? resolve() : reject(new DOMException('private detail', 'NotAllowedError'));
            });
          });
          await card(page, 'Read the wind').click();
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('menuitem', { name: 'Copy link' }).click();
          if (change === 'step') {
            await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
            await page.getByRole('article', { name: 'Name the boat parts', exact: true }).waitFor();
            await page.getByRole('button', { name: 'Read the wind, up next' }).click();
          } else if (change === 'close') {
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await page.getByRole('article').waitFor({ state: 'detached' });
            await card(page, 'Read the wind').click();
          } else {
            await page.evaluate((change) => window.setLinkPrefix(change === 'link' ? 'https://windmill.test/t/other#?step=' : null), change);
            await page.getByRole('button', { name: 'More' }).click();
            assert.equal(await page.getByRole('menuitem', { name: 'Copy link' }).count(), change === 'link' ? 1 : 0);
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.setLinkPrefix('https://windmill.test/t/sail#?step='));
          }
          await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
          await page.getByRole('button', { name: 'Collapse Coach' }).focus();
          await page.evaluate((result) => window.finishCopy(result), result);
          await page.waitForFunction((result) => window.events.some((line) => line === `roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"${result}"}`), result);
          assert.deepEqual([await calls(page), await page.locator('.st-step-copy-recovery').count(), await focusedName(page)], [[], 0, 'Collapse Coach']);
          assert.deepEqual((await events(page)).filter((line) => line.includes('copyLink')), [`roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"${result}"}`]);
          assert.deepEqual(errors, []);
        } finally { await page.context().close(); }
      }
    });
  }

  for (const width of [390, 744]) {
    test(`${engine}: a pointer retry returns native clipboard success to More at ${width}px`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ engine, viewport: { width, height: 960 }, permissions: engine === 'Chromium' ? ['clipboard-read', 'clipboard-write'] : [] }, errors);
      try {
        await page.evaluate(() => {
          window.nativeCopy = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = async () => { throw new DOMException('Synthetic denial', 'NotAllowedError'); };
        });
        await card(page, 'Read the wind').click();
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
        const recovery = page.getByRole('region', { name: 'Couldn’t copy link', exact: true });
        await recovery.getByRole('button', { name: 'Show link', exact: true }).click();
        await recovery.getByRole('button', { name: 'Select link', exact: true }).click();
        await page.evaluate(() => { navigator.clipboard.writeText = window.nativeCopy; });
        await recovery.getByRole('button', { name: 'Try again', exact: true }).click();
        await recovery.waitFor({ state: 'detached' });
        assert.equal(await focusedName(page), 'More');
        assert.deepEqual(await calls(page), ['notify Link copied']);
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }

  test(`${engine}: copy recovery uses the native clipboard success path without a recovery card`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 }, permissions: engine === 'Chromium' ? ['clipboard-read', 'clipboard-write'] : [] }, errors);
    try {
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.waitForFunction(() => window.events.some((line) => line.includes('"action":"copyLink"')));
      assert.deepEqual([await calls(page), (await events(page)).slice(1), await page.locator('.st-step-copy-recovery').count()], [['notify Link copied'], [
        'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}',
      ], 0]);
      if (engine === 'Chromium') assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://windmill.test/t/sail#?step=wind');
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  test(`${engine}: copy recovery removes a revealed address when its link changes or eligibility is revoked`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 390, height: 844 }, editable: false }, errors);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('private detail', 'SecurityError'); }; });
      await card(page, 'Read the wind').click();
      for (const next of ['https://windmill.test/t/another#?step=', null]) {
        await page.getByRole('button', { name: 'More' }).click();
        assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Copy link', 'Open in Graph']);
        await page.getByRole('menuitem', { name: 'Copy link' }).click();
        await page.getByRole('button', { name: 'Show link' }).click();
        await page.getByRole('textbox', { name: 'Step link', exact: true }).waitFor();
        await page.evaluate((next) => window.setLinkPrefix(next), next);
        await page.locator('.st-step-copy-recovery').waitFor({ state: 'detached' });
        assert.deepEqual([await page.getByRole('textbox').count(), await page.evaluate(() => window.reports ?? [])], [0, []]);
      }
      await page.getByRole('button', { name: 'More' }).click();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in Graph']);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
}

test('Chromium: copy recovery handles a real browser clipboard permission denial without a Sentry issue', async () => {
  await start();
  const errors = [];
  const page = await openRoom({ viewport: { width: 390, height: 844 } }, errors);
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'denied', origin: host.origin });
    await card(page, 'Read the wind').click();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).waitFor();
    assert.deepEqual([await calls(page), await page.evaluate(() => window.reports ?? []), (await events(page)).slice(1)], [[], [], [
      'roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"failed"}',
      'roadmap_board_step_action {"surface":"document","action":"copyLinkRecovery","step":"shown"}',
    ]]);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});
