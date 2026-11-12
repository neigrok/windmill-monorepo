import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { withBrowserErrors } from '../browserFixture.js';
import {
  ELSEWHERE, GUIDE, WORDS, browserOnline, caretState, complaintsOf, events, field, hostGuideSurfaces, issues, open,
  origin, prose, settled,
} from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-footer-test' });

const tint = (page, selector, token) => page.locator(selector).evaluate((element, name) => {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `var(${name})`;
  element.append(probe);
  const expected = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return getComputedStyle(element).backgroundColor === expected;
}, token);
// The icon a line draws: which one, its size, and its stroke as drawn, in px.
const strokeOf = (page, selector) => page.locator(selector).evaluate((icon) => {
  const size = icon.getBoundingClientRect().width;
  return { name: [...icon.classList].find((name) => name.startsWith('lucide-')), size, stroke: Math.round(Number(icon.getAttribute('stroke-width')) * size / 24 * 100) / 100 };
});
// A clipboard either engine can read back: what the note wrote, in order.
const readableClipboard = (page) => page.evaluate(() => {
  window.copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied.push(text); } } });
});

// The server's door as the browser meets it: the preflight passes, and each PATCH in turn is lost on the way, answered
// with a status, or taken.
async function serverDoor(page, answers) {
  const sent = [];
  await page.route('**/v1/trees/**', async (route) => {
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    sent.push(JSON.parse(route.request().postData()).guide);
    const answer = answers.shift() ?? 200;
    if (answer === 'lost') await route.abort('internetdisconnected');
    else await route.fulfill({ status: answer, contentType: 'application/json', headers, body: '{}' });
  });
  return sent;
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: a save lost with the browser offline says so in one line with Try again, which runs the save again; the line follows the reason, and editing restores Save`, async () => {
    const page = await open({ guide: GUIDE, door: 'server' }, { engine });
    const complaints = complaintsOf(page);
    try {
      const sent = await serverDoor(page, ['lost', 503, 200]);
      await browserOnline(page, false);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      const fieldBox = () => field(page).evaluate((box) => [getComputedStyle(box).borderTopWidth, getComputedStyle(box).paddingTop, box.getBoundingClientRect().height]);
      const written = await fieldBox();
      await page.getByRole('button', { name: 'Save' }).click();
      const line = page.getByRole('alert');
      await line.waitFor();
      await settled(page);
      assert.deepEqual({
        line: await line.textContent(),
        footer: await page.locator('.st-guide-footer').textContent(),
        focus: await page.evaluate(() => document.activeElement.textContent),
        draft: await field(page).inputValue(),
        held: await field(page).evaluate((box) => box.readOnly),
        described: await field(page).evaluate((box) => box.getAttribute('aria-describedby') === document.querySelector('[role="alert"]').id),
        block: await page.locator('.st-guide-closing').evaluate((block) => {
          const [box, footer, act] = [block, block.parentElement, block.querySelector('.st-guide-actions > :last-child')].map((element) => element.getBoundingClientRect());
          return { around: [act.top - box.top, box.bottom - act.bottom, box.right - act.right], fills: box.width === footer.width };
        }),
        tinted: await tint(page, '.st-guide-closing', '--color-danger-bg'),
        icon: await strokeOf(page, '[role="alert"] > svg'),
        field: {
          box: await fieldBox(),
          fits: await field(page).evaluate((box) => box.scrollHeight === box.clientHeight),
          plainEdge: await field(page).evaluate((box) => getComputedStyle(box).borderTopColor === getComputedStyle(box.closest('.st-guide-paper')).borderTopColor),
        },
        issues: await issues(page),
      }, {
        line: 'You’re offline. Try again when you’re back online.',
        footer: 'You’re offline. Try again when you’re back online.CancelTry again',
        focus: 'Try again',
        draft: `${GUIDE} Written`,
        held: false,
        described: true,
        block: { around: [14, 14, 14], fills: true },
        tinted: true,
        icon: { name: 'lucide-circle-alert', size: 20, stroke: 1.67 },
        field: { box: written, fits: true, plainEdge: true },
        issues: [],
      });
      const stops = [];
      for (let press = 0; press < 3; press += 1) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(() => (document.activeElement.tagName === 'TEXTAREA' ? 'TEXTAREA' : document.activeElement.textContent)));
      }
      assert.deepEqual(stops, ['TEXTAREA', 'Cancel', 'Try again']);
      await browserOnline(page, true);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent === 'Couldn’t save just now. Try again in a moment.');
      assert.equal(await page.locator('.st-guide-footer').textContent(), 'Couldn’t save just now. Try again in a moment.CancelTry again');
      await field(page).fill(`${GUIDE} Rewritten`);
      assert.deepEqual({ line: await line.count(), footer: await page.locator('.st-guide-footer').textContent() },
        { line: 0, footer: 'Your agents and people you share this tree with can read the guide.CancelSave' });
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual(sent, [`${GUIDE} Written`, `${GUIDE} Written`, `${GUIDE} Rewritten`]);
      assert.deepEqual((await events(page)).slice(2), [
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'offline' },
        { step: 'retry', reason: 'offline' },
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'server' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ]);
      assert.deepEqual(await issues(page), [{ operation: 'roadmap-guide-save', stack: true }]);
      const told = JSON.stringify([await page.evaluate(() => window.events), await issues(page), complaints]);
      for (const word of WORDS) assert.equal(told.includes(word), false, word);
      assert.deepEqual(complaints, []);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: on a phone a refused save offers Copy draft, which copies the whole draft; Done returns to Copy draft with the draft kept, and leaving it still asks`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone', door: 'server' },
      { engine, width: 390, height: 844, permissions: engine === chromium ? ['clipboard-read', 'clipboard-write'] : [] });
    const complaints = complaintsOf(page);
    try {
      const sent = await serverDoor(page, [403]);
      if (engine === webkit) await readableClipboard(page);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.getByRole('button', { name: 'Save' }).click();
      const line = page.getByRole('alert');
      await line.waitFor();
      await settled(page);
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        focus: await page.evaluate(() => document.activeElement.textContent),
        ring: await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle),
        draft: await field(page).inputValue(),
        tinted: await tint(page, '[role="alert"]', '--color-danger-bg'),
        icon: await strokeOf(page, '[role="alert"] > svg'),
        ...await page.locator('.st-guide-paper').evaluate((sheet) => {
          const [said, cancel, act] = ['[role="alert"]', '.st-guide-cancel', '.st-guide-save'].map((selector) => sheet.querySelector(selector).getBoundingClientRect());
          return {
            line: [said.left, said.width, said.height],
            actions: [act.top - said.bottom, cancel.left, cancel.height, sheet.getBoundingClientRect().bottom - act.bottom],
            act: [act.width, act.height, window.innerWidth - act.right],
            ruled: getComputedStyle(sheet.querySelector('.st-guide-footer')).borderTopColor === getComputedStyle(sheet).backgroundColor,
          };
        }),
      }, {
        footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft',
        focus: 'Copy draft',
        ring: 'none',
        draft: `${GUIDE} Written`,
        tinted: true,
        icon: { name: 'lucide-circle-alert', size: 16, stroke: 1.67 },
        line: [16, 358, 58],
        actions: [8, 16, 44, 16],
        act: [104, 44, 16],
        ruled: false,
      });
      await page.getByRole('button', { name: 'Copy draft' }).click();
      const copied = page.getByRole('status');
      await copied.waitFor();
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        failed: await line.count(),
        focus: await page.evaluate(() => document.activeElement.textContent),
        icon: await strokeOf(page, '[role="status"] > svg'),
        clipboard: await page.evaluate(() => window.copied?.at(-1) ?? navigator.clipboard.readText()),
      }, {
        footer: 'Draft copied. The guide still has your last saved version.CancelDone',
        failed: 0,
        focus: 'Done',
        icon: { name: 'lucide-check', size: 16, stroke: 1.67 },
        clipboard: `${GUIDE} Written`,
      });
      await page.getByRole('button', { name: 'Done' }).click();
      await line.waitFor();
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        note: await page.getByRole('dialog', { name: 'Edit guide' }).count(),
        draft: await field(page).inputValue(),
        focus: await page.evaluate(() => document.activeElement.textContent),
        events: (await events(page)).slice(2),
      }, {
        footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft',
        note: 1,
        draft: `${GUIDE} Written`,
        focus: 'Copy draft',
        events: [{ step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' }, { step: 'copy', outcome: 'copied' }],
      });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual({ read: await prose(page).textContent(), sent, issues: await issues(page), last: (await events(page)).at(-1) },
        { read: GUIDE, sent: [`${GUIDE} Written`], issues: [], last: { step: 'discard' } });
      assert.deepEqual(complaints, []);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: on a phone a guide changed elsewhere mid-edit says what Save and Load latest each replace, and after Load latest Cancel leaves without asking`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone' }, { engine, width: 390, height: 844 });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await page.keyboard.type(' Written');
        await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
        const notice = page.getByRole('status');
        await notice.waitFor();
        await settled(page);
        assert.deepEqual({
          footer: await page.locator('.st-guide-footer').textContent(),
          draft: await field(page).inputValue(),
          notice: await notice.evaluate((said) => {
            const [box, load] = [said.getBoundingClientRect(), said.querySelector('button').getBoundingClientRect()];
            return [box.left, box.width, box.height, load.width, load.height, box.right - load.right];
          }),
        }, {
          footer: 'Guide changed elsewhere. Save replaces the newer guide. Load latest replaces your draft.Load latestVisible to your agents and people you share with.CancelSave',
          draft: `${GUIDE} Written`,
          notice: [16, 358, 65, 100, 44, 6],
        });
        const stops = [];
        for (let press = 0; press < 4; press += 1) {
          await page.keyboard.press('Tab');
          stops.push(await page.evaluate(() => (document.activeElement.tagName === 'TEXTAREA' ? 'TEXTAREA' : document.activeElement.textContent)));
        }
        assert.deepEqual(stops, ['Load latest', 'Cancel', 'Save', 'TEXTAREA']);
        await page.getByRole('button', { name: 'Load latest' }).click();
        assert.deepEqual({ draft: await field(page).inputValue(), notice: await notice.count(), focused: (await caretState(page)).focused },
          { draft: ELSEWHERE, notice: 0, focused: true });
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual({ asked: await page.getByRole('alertdialog').count(), read: await prose(page).textContent() }, { asked: 0, read: ELSEWHERE });
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await page.keyboard.type(' Written');
        await page.evaluate((text) => window.setElsewhere(text), GUIDE);
        await notice.waitFor();
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.writes), [`${ELSEWHERE} Written`]);
        assert.deepEqual((await events(page)).slice(2), [
          { step: 'loadLatest' },
          { step: 'edit', via: 'pencil' },
          { step: 'save', outcome: 'saved', length: '1-500' },
          { step: 'conflict' },
        ]);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: after ⌘↩ a refusal leaves focus in the field, where typing goes on and clears the line; with Copy draft or Done standing ⌘↩ sends nothing, and Escape still asks`, async () => {
    const page = await open({ guide: GUIDE, door: 'server' }, { engine });
    const complaints = complaintsOf(page);
    try {
      const sent = await serverDoor(page, [403, 403]);
      await readableClipboard(page);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.keyboard.press('Meta+Enter');
      const line = page.getByRole('alert');
      await line.waitFor();
      assert.deepEqual(await caretState(page), { start: GUIDE.length + 8, end: GUIDE.length + 8, focused: true });
      await page.keyboard.type(' and one more');
      assert.deepEqual({ draft: await field(page).inputValue(), line: await line.count(), footer: await page.locator('.st-guide-footer').textContent() },
        { draft: `${GUIDE} Written and one more`, line: 0, footer: 'Your agents and people you share this tree with can read the guide.CancelSave' });
      await page.keyboard.press('Meta+Enter');
      await line.waitFor();
      await page.keyboard.press('Meta+Enter');
      await page.keyboard.press('Control+Enter');
      await page.getByRole('button', { name: 'Copy draft' }).click();
      const copied = page.getByRole('status');
      await copied.waitFor();
      await page.keyboard.press('Meta+Enter');
      await page.keyboard.press('Escape');
      const question = page.getByRole('alertdialog', { name: 'Discard draft?' });
      await question.waitFor();
      await page.keyboard.press('Escape');
      await question.waitFor({ state: 'detached' });
      await settled(page);
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        draft: await field(page).inputValue(),
        copied: await page.evaluate(() => window.copied),
        sent,
        events: (await events(page)).slice(2),
      }, {
        footer: 'Draft copied. The guide still has your last saved version.CancelDone',
        draft: `${GUIDE} Written and one more`,
        copied: [`${GUIDE} Written and one more`],
        sent: [`${GUIDE} Written`, `${GUIDE} Written and one more`],
        events: [
          { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' },
          { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' },
          { step: 'copy', outcome: 'copied' },
        ],
      });
      assert.deepEqual(complaints, []);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a held key is one press: a held ⌘↩ sends one save, a held Enter on Save under a refusal presses nothing after it, and a second press on Copy draft keeps the draft`, async () => {
    const held = await open({ guide: GUIDE, door: 'server' }, { engine });
    try {
      const sent = await serverDoor(held, ['lost', 'lost', 'lost', 'lost']);
      await held.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await held.getByRole('button', { name: 'Edit guide' }).click();
      await held.keyboard.type(' Written');
      await held.keyboard.down('Meta');
      await held.keyboard.down('Enter');
      await held.getByRole('alert').waitFor();
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await held.keyboard.down('Enter');
        await held.waitForFunction(() => document.querySelector('.st-guide-actions > :last-child').getAttribute('aria-busy') === null);
      }
      await held.keyboard.up('Enter');
      await held.keyboard.up('Meta');
      assert.deepEqual({ sent, draft: await field(held).inputValue(), events: (await events(held)).slice(2) },
        { sent: [`${GUIDE} Written`], draft: `${GUIDE} Written`, events: [{ step: 'save', outcome: 'failed', length: '1-500', reason: 'server' }] });
    } finally { await held.close(); }

    const page = await open({ guide: GUIDE, door: 'server' }, { engine });
    try {
      const sent = await serverDoor(page, [403, 403, 403]);
      await readableClipboard(page);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Save');
      await page.keyboard.down('Enter');
      await page.getByRole('alert').waitFor();
      for (let repeat = 0; repeat < 3; repeat += 1) await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await settled(page);
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        focus: await page.evaluate(() => document.activeElement.textContent),
        draft: await field(page).inputValue(),
        copied: await page.evaluate(() => window.copied),
        sent,
        events: (await events(page)).slice(2),
      }, {
        footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft',
        focus: 'Copy draft',
        draft: `${GUIDE} Written`,
        copied: [],
        sent: [`${GUIDE} Written`],
        events: [{ step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' }],
      });
      await page.getByRole('button', { name: 'Copy draft' }).dblclick();
      await page.getByRole('alert').waitFor();
      assert.deepEqual({
        footer: await page.locator('.st-guide-footer').textContent(),
        note: await page.getByRole('dialog', { name: 'Edit guide' }).count(),
        draft: await field(page).inputValue(),
        copied: await page.evaluate(() => window.copied),
        events: (await events(page)).slice(3),
      }, {
        footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft',
        note: 1,
        draft: `${GUIDE} Written`,
        copied: [`${GUIDE} Written`],
        events: [{ step: 'copy', outcome: 'copied' }],
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: on a phone 320px wide with the keyboard's room gone, a changed-elsewhere notice and a failed save's line leave Cancel and Try again on screen, and the sheet scrolls to the line`, async () => {
    for (const height of [400, 300, 280]) {
      const page = await open({ guide: GUIDE, band: 'phone', door: 'server' }, { engine, width: 320, height });
      try {
        await serverDoor(page, ['lost']);
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await page.keyboard.type(' Written');
        await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
        await page.locator('.st-guide-status').waitFor();
        await settled(page);
        const reach = () => page.locator('.st-guide-paper').evaluate((sheet) => {
          const [paper, cancel, act, said] = [sheet, ...['.st-guide-cancel', '.st-guide-save', '.st-guide-line, .st-guide-audience'].map((selector) => sheet.querySelector(selector))].map((element) => element.getBoundingClientRect());
          return {
            onScreen: [cancel, act].every((button) => button.top >= paper.top && button.bottom <= window.innerHeight && button.height === 44),
            atFoot: paper.bottom === window.innerHeight,
            saidAboveActions: said.bottom <= act.top,
          };
        });
        assert.deepEqual({ onScreen: (await reach()).onScreen, atFoot: (await reach()).atFoot }, { onScreen: true, atFoot: true }, `notice at 320×${height}`);
        await page.keyboard.press('Meta+Enter');
        await page.getByRole('alert').waitFor();
        await settled(page);
        assert.deepEqual({ onScreen: (await reach()).onScreen, atFoot: (await reach()).atFoot }, { onScreen: true, atFoot: true }, `notice and line at 320×${height}`);
        await page.locator('.st-guide-paper').evaluate((sheet) => { sheet.scrollTop = sheet.scrollHeight; });
        assert.deepEqual(await reach(), { onScreen: true, atFoot: true, saidAboveActions: true }, `scrolled to the line at 320×${height}`);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: crossing 744px while a line stands leaves focus where it was: on the line's act after a press, in the field after ⌘↩`, async () => {
    const page = await open({ guide: GUIDE, door: 'server' }, { engine, width: 1024, height: 800 });
    try {
      await serverDoor(page, [503, 503]);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('alert').waitFor();
      const focus = () => page.evaluate(() => (document.activeElement.tagName === 'TEXTAREA' ? 'TEXTAREA' : document.activeElement.tagName === 'BODY' ? 'BODY' : document.activeElement.textContent));
      const cross = async (band) => {
        await page.setViewportSize(band === 'phone' ? { width: 390, height: 844 } : { width: 1024, height: 800 });
        await page.evaluate((next) => window.setRoom({ band: next }), band);
        await page.locator(band === 'phone' ? '.st-guide-paper--phone' : '.st-guide-paper:not(.st-guide-paper--phone)').waitFor();
        return [await focus(), await page.locator('.st-guide-footer').textContent()];
      };
      assert.deepEqual([await focus(), await cross('phone'), await cross('desktop')], [
        'Try again',
        ['Try again', 'Couldn’t save just now. Try again in a moment.CancelTry again'],
        ['Try again', 'Couldn’t save just now. Try again in a moment.CancelTry again'],
      ]);
      await field(page).focus();
      await page.keyboard.press('Meta+Enter');
      await page.waitForFunction(() => window.events.filter(({ props }) => props.outcome === 'failed').length === 2);
      assert.deepEqual([await focus(), (await cross('phone'))[0], (await cross('desktop'))[0]], ['TEXTAREA', 'TEXTAREA', 'TEXTAREA']);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: on a phone the notice that arrives over a long draft keeps the caret's line in view, at the draft's end and at its start`, async () => {
    const long = Array.from({ length: 16 }, (_, line) => `Line ${line + 1} of the guide.`).join('\n');
    for (const at of ['end', 'start']) {
      const page = await open({ guide: long, band: 'phone' }, { engine, width: 390, height: 592 });
      try {
        await withBrowserErrors(page, async () => {
          await page.getByRole('button', { name: 'Guide: Line 1 of the guide.' }).click();
          await page.getByRole('button', { name: 'Edit guide' }).click();
          await page.keyboard.type(' x');
          if (at === 'start') await field(page).evaluate((box) => { box.setSelectionRange(0, 0); box.scrollTop = 0; });
          const shown = () => field(page).evaluate((box) => ({ height: box.clientHeight, top: box.scrollTop, below: box.scrollHeight - box.clientHeight - box.scrollTop }));
          const before = await shown();
          await page.evaluate((text) => window.setElsewhere(text), `${long}\nAgents: ask first.`);
          await page.locator('.st-guide-status').waitFor();
          await settled(page);
          await page.waitForFunction((height) => document.querySelector('.st-guide-field').clientHeight < height, before.height);
          const after = await shown();
          assert.equal(after.height < before.height, true, 'the field gave up height to the notice');
          if (at === 'end') assert.equal(after.below <= 12, true, `the last line is ${after.below}px below the field's foot`);
          else assert.equal(after.top, 0);
        });
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: on a phone the footer's button wears no ring after a tap, and one when a key brings focus back to it or puts it there`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone', door: 'server' }, { engine, width: 390, height: 844 });
    try {
      await serverDoor(page, [503, 503]);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      const ring = () => page.evaluate(() => [document.activeElement.textContent, getComputedStyle(document.activeElement).outlineStyle]);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('alert').waitFor();
      await settled(page);
      const tapped = await ring();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const tabbedBack = await ring();
      await field(page).fill(`${GUIDE} Rewritten`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.getByRole('alert').waitFor();
      await settled(page);
      assert.deepEqual([tapped, tabbedBack, await ring()], [['Try again', 'none'], ['Try again', 'solid'], ['Try again', 'solid']]);
    } finally { await page.close(); }
  });
}

test('Chromium: a first guide the server refuses can be copied whole from the note; ⌘↩ leaves focus in the field, and after Done leaving it asks and returns to Add guide', async () => {
  const page = await open({ door: 'server' }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const complaints = complaintsOf(page);
  try {
    await serverDoor(page, [401]);
    await page.getByRole('button', { name: 'Add guide', exact: true }).click();
    await page.keyboard.type('Maya and I take the dinghy out on Sundays.\nNext Sunday, practice coming alongside the dock.');
    await page.keyboard.press('Meta+Enter');
    await page.getByRole('alert').waitFor();
    assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), focused: (await caretState(page)).focused },
      { footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft', focused: true });
    await page.getByRole('button', { name: 'Copy draft' }).click();
    await page.getByRole('status').waitFor();
    await settled(page);
    assert.deepEqual({
      footer: await page.locator('.st-guide-footer').textContent(),
      block: await page.locator('.st-guide-closing').evaluate((block) => block.getBoundingClientRect().height),
      tinted: await tint(page, '.st-guide-closing', '--surface-sunken'),
      icon: await strokeOf(page, '[role="status"] > svg'),
      clipboard: await page.evaluate(() => navigator.clipboard.readText()),
    }, {
      footer: 'Draft copied. The guide still has your last saved version.CancelDone',
      block: 92,
      tinted: true,
      icon: { name: 'lucide-check', size: 20, stroke: 1.67 },
      clipboard: 'Maya and I take the dinghy out on Sundays.\nNext Sunday, practice coming alongside the dock.',
    });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await field(page).inputValue(), 'Maya and I take the dinghy out on Sundays.\nNext Sunday, practice coming alongside the dock.');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-guide-card[aria-label="Add guide"]'));
    assert.deepEqual((await events(page)).slice(2), [
      { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' },
      { step: 'copy', outcome: 'copied' },
      { step: 'discard' },
    ]);
    const told = JSON.stringify([await page.evaluate(() => window.events), await issues(page), complaints]);
    for (const word of ['Maya', 'dinghy', 'Sunday', 'dock']) assert.equal(told.includes(word), false, word);
    assert.deepEqual({ issues: await issues(page), complaints }, { issues: [], complaints: [] });
  } finally { await page.close(); }
});

test('Chromium: a device tree whose store could not take the guide says the save failed, and each failed Try again is said anew', async () => {
  const page = await open({ guide: GUIDE, door: 'device', device: true });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.locator('.st-guide-footer').textContent(), 'Couldn’t save just now. Try again in a moment.CancelTry again');
      await page.evaluate(() => { window.firstLine = document.querySelector('[role="alert"]'); });
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => window.events.filter(({ props }) => props.outcome === 'failed').length === 2);
      await page.waitForFunction(() => document.querySelector('.st-guide-actions > :last-child').getAttribute('aria-busy') === null);
      assert.deepEqual({
        saidAnew: await page.evaluate(() => document.querySelector('[role="alert"]') !== window.firstLine && !window.firstLine.isConnected),
        footer: await page.locator('.st-guide-footer').textContent(),
        draft: await field(page).inputValue(),
      }, { saidAnew: true, footer: 'Couldn’t save just now. Try again in a moment.CancelTry again', draft: `${GUIDE} Written` });
      assert.deepEqual((await events(page)).slice(2), [
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'device' },
        { step: 'retry', reason: 'device' },
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'device' },
      ]);
      assert.deepEqual(await issues(page), [{ operation: 'roadmap-guide-save', stack: true }, { operation: 'roadmap-guide-save', stack: true }]);
    });
  } finally { await page.close(); }
});

test('Chromium: a request lost while the browser is online reads as the server\'s failure and reports, and Try again that succeeds returns to the note read', async () => {
  const page = await open({ guide: GUIDE, door: 'server' });
  const complaints = complaintsOf(page);
  try {
    const sent = await serverDoor(page, ['lost', 200]);
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('alert').waitFor();
    assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), issues: await issues(page) },
      { footer: 'Couldn’t save just now. Try again in a moment.CancelTry again', issues: [{ operation: 'roadmap-guide-save', stack: true }] });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
    assert.deepEqual({ sent, asked: await page.getByRole('alertdialog').count(), events: (await events(page)).slice(2) }, {
      sent: [`${GUIDE} Written`, `${GUIDE} Written`],
      asked: 0,
      events: [
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'server' },
        { step: 'retry', reason: 'server' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ],
    });
    assert.deepEqual(complaints, []);
  } finally { await page.close(); }
});

test('Chromium: a guide changed elsewhere while a failed save\'s line stands is said above it, and Load latest clears both', async () => {
  const page = await open({ guide: GUIDE, door: 'server' });
  const complaints = complaintsOf(page);
  try {
    await serverDoor(page, [503]);
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('alert').waitFor();
    await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
    await page.getByRole('status').waitFor();
    assert.equal(await page.locator('.st-guide-footer').textContent(),
      'Changed elsewhere. Saving replaces that version.Load latestCouldn’t save just now. Try again in a moment.CancelTry again');
    await page.getByRole('button', { name: 'Load latest' }).click();
    assert.deepEqual({ draft: await field(page).inputValue(), footer: await page.locator('.st-guide-footer').textContent() },
      { draft: ELSEWHERE, footer: 'Your agents and people you share this tree with can read the guide.CancelSave' });
    assert.deepEqual(complaints, []);
  } finally { await page.close(); }
});

test('Chromium: Load latest waits while a save is in flight, as Cancel does', async () => {
  const page = await open({ guide: GUIDE, door: 'server' });
  try {
    await withBrowserErrors(page, async () => {
      let settle;
      const gate = new Promise((resolve) => { settle = resolve; });
      await page.route('**/v1/trees/**', async (route) => {
        await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' }, body: '{}' });
      });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      await page.getByRole('status').waitFor();
      await page.keyboard.press('Meta+Enter');
      await page.waitForFunction(() => document.querySelector('.st-guide-field').readOnly);
      await page.getByRole('button', { name: 'Load latest' }).click();
      assert.deepEqual({ draft: await field(page).inputValue(), busy: await page.getByRole('button', { name: 'Save' }).getAttribute('aria-busy'), events: (await events(page)).slice(2) },
        { draft: `${GUIDE} Written`, busy: 'true', events: [] });
      settle();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual((await events(page)).slice(2), [{ step: 'save', outcome: 'saved', length: '1-500' }, { step: 'conflict' }]);
    });
  } finally { await page.close(); }
});
