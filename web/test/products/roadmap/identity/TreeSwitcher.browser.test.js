import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTreeSwitcherHost, openMenu } from './treeSwitcherHost.js';

const { withSwitcher, close } = createTreeSwitcherHost('interactions');
after(close);

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: tablet touch exposes 44px switcher actions before hover`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      const rename = page.getByRole('button', { name: 'Rename Learn to sail' });
      await rename.waitFor();
      assert.deepEqual(await rename.evaluate((button) => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        opacity: getComputedStyle(button.parentElement).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      })), { coarse: true, opacity: '1', pointerEvents: 'auto', width: 44, height: 44 });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: keyboard focus reveals the switcher actions without hover`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem').first().waitFor();
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      const rename = page.getByRole('button', { name: 'Rename Learn to sail' });
      await page.waitForFunction(() => getComputedStyle(document.activeElement.parentElement).opacity === '1');
      assert.deepEqual(await rename.evaluate((button) => ({
        focused: document.activeElement === button,
        opacity: getComputedStyle(button.parentElement).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
        outline: getComputedStyle(button).outlineStyle,
      })), { focused: true, opacity: '1', pointerEvents: 'auto', outline: 'solid' });
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-keyboard-focus.png` });
    }, { engine, width: 744 });
  });

  test(`${engine}: tablet actions keep titles clear, hit their full targets, and respect row permissions`, async () => {
    const title = 'A very long roadmap title that must leave both row actions available';
    for (const width of [744, 834, 1023]) {
      await withSwitcher([
        { id: 'sail', title: 'Learn to sail', origin: 'server' },
        { id: 'long', title, origin: 'server' },
        { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
        { id: 'claimed', title: 'Claimed roadmap', origin: 'device', claimed: true },
        { id: 'readonly', title: 'Read only roadmap' },
      ], async (page) => {
        await page.locator('#fixture [aria-haspopup="menu"]').tap();
        await page.getByRole('button', { name: `Rename ${title}` }).waitFor();
        assert.deepEqual(await page.locator('.st-switcher-actions button').evaluateAll((buttons) => buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return {
            name: button.getAttribute('aria-label'), width, height,
            edges: [[2, height / 2], [width - 2, height / 2], [width / 2, 2], [width / 2, height - 2]]
              .every(([dx, dy]) => button.contains(document.elementFromPoint(x + dx, y + dy))),
          };
        })), ['Learn to sail', title, 'Device roadmap'].flatMap((name) => ['Rename', 'Delete'].map((action) => ({ name: `${action} ${name}`, width: 44, height: 44, edges: true }))));
        const longRow = page.getByRole('menuitem').filter({ hasText: title });
        assert.deepEqual(await longRow.evaluate((row) => {
          const name = row.querySelector('[title]');
          return { truncated: name.scrollWidth > name.clientWidth, clear: name.getBoundingClientRect().right < row.querySelector('button').getBoundingClientRect().left };
        }), { truncated: true, clear: true });
        if (process.env.WM_SWITCHER_SCREENSHOTS && width === 744) {
          await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-touch-light.png` });
          await page.evaluate(() => {
            document.documentElement.setAttribute('data-brand', 'roadmap');
            document.documentElement.setAttribute('data-theme', 'dark');
          });
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor === 'rgb(23, 23, 25)');
          await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-touch-dark.png` });
        }
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } })));
        await page.getByRole('button', { name: 'Rename Device roadmap' }).waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('button', { name: 'Delete Device roadmap' }).count(), 0);
        assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], hash: location.hash })), { renames: [], deletes: [], hash: '' });
      }, { engine, width, touch: true });
    }
  });

  test(`${engine}: rename and delete cancellation restore the row action before outer Escape closes`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      const tab = engine === 'WebKit' ? 'Alt+Tab' : 'Tab';
      const trigger = page.locator('#fixture [aria-haspopup="menu"]');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem').first().waitFor();
      await page.keyboard.press(tab);
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      const input = page.getByRole('textbox', { name: 'Tree name' });
      await input.waitFor();
      assert.deepEqual(await input.evaluate((field) => ({ focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd })), { focused: true, start: 0, end: 13 });
      await input.fill('Cancelled title');
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-rename.png` });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Rename Learn to sail' }).evaluate((button) => document.activeElement === button), true);
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.locator('.st-switcher-confirm-actions button').evaluateAll((buttons) => buttons.map((button) => ({ name: button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }))), [{ name: 'Delete', width: 84, height: 44 }, { name: 'Keep', width: 84, height: 44 }]);
      assert.equal(await page.getByRole('menuitem').first().textContent(), 'Delete Learn to sail? This can’t be undoneDeleteKeep');
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-delete-confirmation.png` });
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      const del = page.getByRole('button', { name: 'Delete Learn to sail' });
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Keep' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], hash: location.hash, events: window.events })), {
        renames: [], deletes: [], hash: '', events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }],
      });
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate((button) => document.activeElement === button), true);
    }, { engine, width: 834 });
  });

  test(`${engine}: fine pointer reveal and existing desktop and phone action sizes stay intact`, async () => {
    for (const width of [743, 744, 1024, 1440]) {
      await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
        await openMenu(page);
        const actions = page.locator('.st-switcher-actions');
        await actions.waitFor();
        assert.equal(await actions.evaluate((element) => getComputedStyle(element).opacity), '0');
        await page.getByRole('menuitem').first().hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-switcher-actions')).opacity === '1');
        assert.deepEqual(await page.getByRole('button', { name: 'Rename Learn to sail' }).evaluate((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })), { width: width === 744 ? 44 : 22, height: width === 744 ? 44 : 22 });
        await page.locator('#blank').hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-switcher-actions')).opacity === '0');
      }, { engine, width });
    }
  });

  test(`${engine}: row click and double click retain navigation and rename without an action activating the row`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await openMenu(page);
      const row = page.getByRole('menuitem').filter({ hasText: 'Another roadmap' });
      await row.locator('[title]').dblclick();
      await page.getByRole('textbox', { name: 'Tree name' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.keyboard.press('Escape');
      await row.locator('[title]').click();
      await page.getByRole('button', { name: 'Delete Another roadmap' }).click();
      await page.waitForTimeout(250);
      assert.equal(await page.getByRole('button', { name: 'Keep' }).count(), 1);
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.getByRole('button', { name: 'Keep' }).click();
      await row.locator('[title]').click();
      await page.waitForFunction(() => location.hash === '#/app/other');
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], events: window.events })), {
        renames: [], deletes: [], events: ['open', 'switch'].map((step) => ({ name: 'roadmap_sheet', props: { step, door: 'switcher' } })),
      });
    }, { engine, width: 834 });
  });
}

for (const via of ['blank', 'escape']) {
  test(`Chromium: the identity TreeSwitcher returns focus on ${via} dismissal`, async () => {
    await withSwitcher([], async (page) => {
      const trigger = page.locator('#fixture [aria-haspopup="menu"]');
      await openMenu(page);
      await page.getByRole('menuitem').first().focus();
      if (via === 'blank') await page.locator('#blank').click();
      if (via === 'escape') await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.deepEqual(await trigger.evaluate((button) => ({
        focused: document.activeElement === button,
        expanded: button.getAttribute('aria-expanded'),
        height: button.getBoundingClientRect().height,
        fontSize: getComputedStyle(button).fontSize,
        caret: { width: button.querySelector('svg').getBoundingClientRect().width, opacity: getComputedStyle(button.querySelector('svg')).opacity },
      })), { focused: true, expanded: 'false', height: 44, fontSize: '24px', caret: { width: 20, opacity: '1' } });
    });
  });
}
