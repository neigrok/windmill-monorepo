import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { ELSEWHERE, GUIDE, complaintsOf, events, field, hostGuideSurfaces, issues, open, origin, settled } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-feedback-test' });

test('a clipboard refusal explains the failed copy and keeps the exact draft and Copy draft', async () => {
  const page = await open({ guide: GUIDE, door: 'server' });
  try {
    await page.route('**/v1/trees/**', async (route) => {
      await route.fulfill({ status: route.request().method() === 'PATCH' ? 403 : 204,
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' }, body: '' });
    });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Private draft sentence', 'NotAllowedError'); },
    } }));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await field(page).fill(`${GUIDE}\n Exact draft.  `);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Copy draft' }).click();
    await page.waitForFunction(() => window.events.some(({ props }) => props.step === 'copy'));
    assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), draft: await field(page).inputValue(), events: (await events(page)).slice(2), issues: await issues(page) }, {
      footer: 'Couldn’t copy your draft. Try Copy draft again.CancelCopy draft',
      draft: `${GUIDE}\n Exact draft.  `,
      events: [{ step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' }, { step: 'copy', outcome: 'failed' }],
      issues: [],
    });
    await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
    await page.getByRole('button', { name: 'Load latest' }).waitFor();
    assert.deepEqual({ conflict: await page.locator('.st-guide-status').textContent(), failure: await page.locator('.st-guide-line').textContent() },
      { conflict: 'Changed elsewhere. Saving replaces that version.Load latest', failure: 'Couldn’t copy your draft. Try Copy draft again.' });
    await page.getByRole('button', { name: 'Load latest' }).click();
    assert.deepEqual({ draft: await field(page).inputValue(), alerts: await page.getByRole('alert').count(), focus: await field(page).evaluate(field => document.activeElement === field) },
      { draft: ELSEWHERE, alerts: 0, focus: true });
  } finally { await page.close(); }
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: denied, blocked, missing and unexpected clipboard failures announce again; success and Done restore the server refusal`, async () => {
    const page = await open({ guide: GUIDE, door: 'server', band: 'phone' }, { engine, width: 390, height: 844 });
    const complaints = complaintsOf(page);
    try {
      await page.route('**/v1/trees/**', async (route) => {
        await route.fulfill({ status: route.request().method() === 'PATCH' ? 403 : 204,
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' }, body: '' });
      });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('Maya’s private draft.\n  Keep both spaces.  ');
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('button', { name: 'Copy draft' }).waitFor();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      for (const refusal of ['NotAllowedError', 'SecurityError', 'missing', 'unexpected']) {
        await page.evaluate((reason) => {
          window.previousLine = document.querySelector('.st-guide-line');
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: reason === 'missing' ? undefined : {
            writeText: async () => {
              if (reason === 'unexpected') throw new Error('Maya’s private draft.\n  Keep both spaces.  ');
              throw new DOMException('Maya’s private draft.\n  Keep both spaces.  ', reason);
            },
          } });
        }, refusal);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.st-guide-line') !== window.previousLine);
        assert.deepEqual(await page.locator('.st-guide-line').evaluate((line) => ({
          text: line.textContent, role: line.getAttribute('role'), oldDetached: !window.previousLine.isConnected,
          focused: document.activeElement.textContent, ring: getComputedStyle(document.activeElement).outlineStyle,
        })), { text: 'Couldn’t copy your draft. Try Copy draft again.', role: 'alert', oldDetached: true, focused: 'Copy draft', ring: 'solid' });
        const beforeShortcut = await events(page);
        await page.keyboard.press('Meta+Enter');
        await page.keyboard.press('Control+Enter');
        assert.deepEqual(await events(page), beforeShortcut);
      }
      assert.deepEqual(await issues(page), [{ operation: 'roadmap-guide-copy', stack: true }]);
      const telemetry = await page.evaluate(() => JSON.stringify([window.events, window.issueDetails]));
      for (const privateWord of ['Maya', 'private draft', 'Keep both spaces']) assert.equal(telemetry.includes(privateWord), false);
      await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied.push(text); } } });
      });
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      assert.deepEqual({ text: await page.locator('.st-guide-line').textContent(), role: await page.locator('.st-guide-line').getAttribute('role'), focus: await page.evaluate(() => document.activeElement.textContent) },
        { text: 'Draft copied. The guide still has your last saved version.', role: 'status', focus: 'Done' });
      await page.keyboard.press('Enter');
      assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), draft: await field(page).inputValue(), copied: await page.evaluate(() => window.copied), focus: await page.evaluate(() => document.activeElement.textContent) }, {
        footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft',
        draft: 'Maya’s private draft.\n  Keep both spaces.  ', copied: ['Maya’s private draft.\n  Keep both spaces.  '], focus: 'Copy draft',
      });
      await field(page).fill('A replacement draft.  ');
      await page.keyboard.press('Control+Enter');
      await page.getByRole('button', { name: 'Copy draft' }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copied), ['Maya’s private draft.\n  Keep both spaces.  ', 'A replacement draft.  ']);
      assert.deepEqual((await events(page)).slice(2), [
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' },
        ...Array.from({ length: 4 }, () => ({ step: 'copy', outcome: 'failed' })),
        { step: 'copy', outcome: 'copied' },
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' },
        { step: 'copy', outcome: 'copied' },
      ]);
      assert.deepEqual(complaints, []);
    } finally { await page.close(); }
  });
}

for (const width of [320, 390, 744, 1024, 1440]) for (const theme of ['light', 'dark']) {
  test(`${width}px ${theme}: ownership refusal is neutral, copy failure uses danger, and Done returns to the local refusal`, async () => {
    const phone = width < 744;
    const page = await open({ guide: GUIDE, band: phone ? 'phone' : 'desktop' }, { width, height: phone ? 844 : 960, reducedMotion: 'reduce' });
    const complaints = complaintsOf(page);
    try {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
          window.copied.push(text);
          if (window.copied.length === 1) throw new DOMException('Denied', 'NotAllowedError');
        } } });
      }, theme);
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill(`${GUIDE}\n  Exact draft.  `);
      await page.evaluate(() => window.setRoom({ owner: false }));
      await page.waitForFunction(() => document.querySelector('.st-guide-entry, .st-guide-row')?.getAttribute('aria-label').startsWith('Author’s note'));
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('button', { name: 'Copy draft' }).waitFor();
      await settled(page);
      assert.deepEqual(await page.locator('.st-guide-paper').evaluate((paper, phone) => {
        const line = paper.querySelector('.st-guide-line');
        const block = phone ? line : paper.querySelector('.st-guide-closing');
        const icon = line.querySelector('svg');
        const probe = document.createElement('span');
        probe.style.cssText = 'background:var(--surface-sunken);color:var(--text-secondary)';
        paper.append(probe);
        const tokens = getComputedStyle(probe);
        const neutral = getComputedStyle(block).backgroundColor === tokens.backgroundColor && getComputedStyle(icon).color === tokens.color;
        probe.remove();
        const box = paper.getBoundingClientRect();
        return { text: line.textContent, neutral, fullscreen: paper.classList.contains('st-guide-paper--owner-phone'), inset: box.left,
          fits: line.scrollWidth === line.clientWidth && paper.scrollWidth === paper.clientWidth,
          actions: [...paper.querySelectorAll('.st-guide-actions button')].map(button => button.getBoundingClientRect().height >= 44), writes: window.writes };
      }, phone), { text: 'You can’t save this guide. Copy your draft to keep it.', neutral: true, fullscreen: phone, inset: phone ? 0 : 24, fits: true, actions: [true, true], writes: [] });
      if (process.env.WM_GUIDE_CAPTURE_DIR) await page.screenshot({ path: `${process.env.WM_GUIDE_CAPTURE_DIR}/${width}-${theme}-local.png` });
      await page.getByRole('button', { name: 'Copy draft' }).click();
      await page.waitForFunction(() => document.querySelector('.st-guide-line')?.textContent === 'Couldn’t copy your draft. Try Copy draft again.');
      assert.deepEqual(await page.locator('.st-guide-line').evaluate((line, phone) => {
        const block = phone ? line : line.parentElement;
        const probe = document.createElement('span');
        probe.style.cssText = 'background:var(--color-danger-bg);color:var(--color-danger)';
        block.append(probe);
        const tokens = getComputedStyle(probe);
        const danger = getComputedStyle(block).backgroundColor === tokens.backgroundColor && getComputedStyle(line.querySelector('svg')).color === tokens.color;
        probe.remove();
        return { danger, fits: line.scrollWidth === line.clientWidth, focused: document.activeElement.textContent, role: line.getAttribute('role') };
      }, phone), { danger: true, fits: true, focused: 'Copy draft', role: 'alert' });
      if (process.env.WM_GUIDE_CAPTURE_DIR) await page.screenshot({ path: `${process.env.WM_GUIDE_CAPTURE_DIR}/${width}-${theme}-failed.png` });
      await page.getByRole('button', { name: 'Copy draft' }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      assert.deepEqual({ line: await page.locator('.st-guide-line').textContent(), draft: await field(page).inputValue(), copied: await page.evaluate(() => window.copied), events: (await events(page)).slice(2), issues: await issues(page), complaints }, {
        line: 'You can’t save this guide. Copy your draft to keep it.', draft: `${GUIDE}\n  Exact draft.  `, copied: [`${GUIDE}\n  Exact draft.  `, `${GUIDE}\n  Exact draft.  `],
        events: [{ step: 'save', outcome: 'failed', length: '1-500', reason: 'not-owner' }, { step: 'copy', outcome: 'failed' }, { step: 'copy', outcome: 'copied' }], issues: [], complaints: [],
      });
    } finally { await page.close(); }
  });
}

for (const outcome of ['copied', 'failed']) for (const action of ['edit', 'loadLatest', 'leave', 'unmount', 'newerAttempt']) {
  test(`a clipboard ${outcome} result after ${action} reports its outcome without replacing the current feedback`, async () => {
    const page = await open({ guide: GUIDE }, { reducedMotion: 'reduce' });
    const complaints = complaintsOf(page);
    try {
      await page.evaluate(() => {
        window.copies = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: (text) => new Promise((resolve, reject) => window.copies.push({ text, resolve, reject })),
        } });
      });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('First private draft.  ');
      await page.evaluate(() => window.setRoom({ owner: false }));
      await page.waitForFunction(() => document.querySelector('.st-guide-entry, .st-guide-row')?.getAttribute('aria-label').startsWith('Author’s note'));
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('button', { name: 'Copy draft' }).click();
      if (action === 'edit') {
        await field(page).fill('Second private draft.  ');
        await page.keyboard.press('Meta+Enter');
      } else if (action === 'loadLatest') {
        await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
        assert.equal(await page.locator('.st-guide-line').textContent(), 'You can’t save this guide. Copy your draft to keep it.');
        await page.getByRole('button', { name: 'Load latest' }).click();
        assert.deepEqual({ draft: await field(page).inputValue(), focused: await field(page).evaluate((field) => field === document.activeElement) }, { draft: ELSEWHERE, focused: true });
      } else if (action === 'leave') {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.st-guide-field'));
        await page.evaluate(() => window.setRoom({ owner: true }));
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await field(page).fill('Next edit.  ');
        await page.evaluate(() => window.setRoom({ owner: false }));
        await page.waitForFunction(() => document.querySelector('.st-guide-entry, .st-guide-row')?.getAttribute('aria-label').startsWith('Author’s note'));
        await page.keyboard.press('Meta+Enter');
      } else if (action === 'unmount') {
        await page.evaluate(() => window.setRoom({ shared: true }));
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement === document.querySelector('.st-roadmap-title'));
      } else {
        await page.getByRole('button', { name: 'Copy draft' }).click();
        await page.evaluate(() => window.copies[1].reject(new DOMException('Denied', 'NotAllowedError')));
        await page.waitForFunction(() => document.querySelector('.st-guide-line')?.textContent === 'Couldn’t copy your draft. Try Copy draft again.');
      }
      const before = { footer: await page.locator('.st-guide-footer').allTextContents(), draft: await field(page).count() ? await field(page).inputValue() : null,
        focus: await page.evaluate(() => document.activeElement.className) };
      await page.evaluate((outcome) => {
        if (outcome === 'copied') window.copies[0].resolve();
        else window.copies[0].reject(new DOMException('Denied', 'NotAllowedError'));
      }, outcome);
      await page.waitForFunction((count) => window.events.filter(({ props }) => props.step === 'copy').length === count, action === 'newerAttempt' ? 2 : 1);
      await settled(page);
      assert.deepEqual({ footer: await page.locator('.st-guide-footer').allTextContents(), draft: await field(page).count() ? await field(page).inputValue() : null,
        focus: await page.evaluate(() => document.activeElement.className) }, before);
      assert.deepEqual((await events(page)).filter(event => event.step === 'copy'), action === 'newerAttempt'
        ? [{ step: 'copy', outcome: 'failed' }, { step: 'copy', outcome }] : [{ step: 'copy', outcome }]);
      assert.deepEqual({ writes: await page.evaluate(() => window.writes), issues: await issues(page), complaints }, { writes: [], issues: [], complaints: [] });
    } finally { await page.close(); }
  });
}

test('a copy that settles while Discard draft is open keeps focus and inertness in the confirmation', async () => {
  const page = await open({ guide: GUIDE }, { reducedMotion: 'reduce' });
  try {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => new Promise(resolve => { window.finishCopy = resolve; }),
    } }));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await field(page).fill('A private draft.  ');
    await page.evaluate(() => window.setRoom({ owner: false }));
    await page.waitForFunction(() => document.querySelector('.st-guide-entry, .st-guide-row')?.getAttribute('aria-label').startsWith('Author’s note'));
    await page.keyboard.press('Meta+Enter');
    await page.getByRole('button', { name: 'Copy draft' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
    const focus = await page.evaluate(() => document.activeElement.textContent);
    await page.evaluate(() => window.finishCopy());
    await page.waitForFunction(() => window.events.some(({ props }) => props.step === 'copy'));
    assert.deepEqual(await page.locator('.st-guide-paper').evaluate(paper => ({ inert: paper.inert, hidden: paper.getAttribute('aria-hidden'), focus: document.activeElement.textContent })),
      { inert: true, hidden: null, focus });
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('alertdialog').evaluate(dialog => dialog.contains(document.activeElement)), true);
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), draft: await field(page).inputValue() },
      { footer: 'Draft copied. The guide still has your last saved version.CancelDone', draft: 'A private draft.  ' });
  } finally { await page.close(); }
});
