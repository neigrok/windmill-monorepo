import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { withBrowserErrors } from '../browserFixture.js';
import {
  GUIDE, WORDS, browserOnline, caretState, complaintsOf, events, field, focusedName, hostGuideSurfaces, issues, open,
  origin, prose, settled, start, stepInert,
} from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-above-test' });

// The room of the tree's holder under the guides the server answers for it: `guides` is the route's reply, a status it
// fails with, 'lost' for a request that never arrives, or { body } for a 200 that says that and nothing else. `asked`
// counts the reads. It returns once the read is over: a 200 once the room has taken it, which can come after the
// request has finished; a failure once the request has.
async function openHeld(guides, options = {}, browser = {}) {
  await start();
  const asked = [];
  const page = await open({ ...options, mount: false }, browser);
  await page.route('**/v1/trees/sail/guides', async (route) => {
    asked.push(route.request().method());
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
    if (guides === 'lost') await route.abort('internetdisconnected');
    else if (typeof guides === 'number') await route.fulfill({ status: guides, contentType: 'application/json', headers, body: JSON.stringify({ code: 'guides-unavailable', error: 'the trees above My life could not be read' }) });
    else if (!Array.isArray(guides)) await route.fulfill({ status: 200, contentType: 'application/json', headers, body: guides.body });
    else await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ guides }) });
  });
  if (browser.online === false) await browserOnline(page, false);
  const held = { holder: 'u_olya', ...options };
  const read = held.holder ? page.waitForEvent(guides === 'lost' ? 'requestfailed' : 'requestfinished', (request) => request.url().endsWith('/guides')) : null;
  await page.evaluate((mounted) => window.mount(mounted), held);
  await read;
  if (read && guides !== 'lost' && typeof guides !== 'number') await page.waitForFunction(() => window.aboveTaken);
  return { page, asked };
}

// What the server answers for Learn to sail under My life and My year: farthest first, the tree's own last when it has one.
const repliedGuides = (own) => [
  { treeId: 't_life', title: 'My life', text: 'Health first, then craft.', yours: true },
  { treeId: 't_year', title: 'My year', text: 'Three things this year.\nSail, run, read.', yours: true },
  ...(own ? [{ treeId: 'sail', title: 'Learn to sail', text: own, yours: true }] : []),
];
// The note's stack as it reads, top to bottom: each child by its part and its words.
const stackOf = (page) => page.locator('.st-guide-stack').evaluate((stack) => [...stack.children].map((child) => `${child.classList[0].replace('st-guide-', '')}: ${child.textContent}`));
const inkOf = (page, selector) => page.locator(selector).first().evaluate((element) => {
  const probe = document.createElement('span');
  element.append(probe);
  const inks = Object.fromEntries(['primary', 'secondary', 'tertiary'].map((name) => {
    probe.style.color = `var(--text-${name})`;
    return [getComputedStyle(probe).color, name];
  }));
  probe.remove();
  const style = getComputedStyle(element);
  return { ink: inks[style.color], size: `${style.fontSize}/${style.lineHeight}`, cursor: style.cursor };
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: the holder’s card says whose guides apply from above, and the note reads them farthest first over this tree’s own, which alone a click writes`, async () => {
    const { page, asked } = await openHeld(repliedGuides('An older copy of this tree’s guide.'), { guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        const card = page.getByRole('button', { name: 'Guide: One step a week.' });
        assert.equal(await card.textContent(), 'GuideOne step a week.With guides from My life and My yearRead guide→');
        assert.equal(await card.evaluate((button) => document.getElementById(button.getAttribute('aria-describedby')).textContent), 'With guides from My life and My year');
        assert.deepEqual(await inkOf(page, '.st-guide-card-above'), { ink: 'secondary', size: '13px/19px', cursor: 'pointer' });
        await card.click();
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        await settled(page);
        assert.deepEqual(await stackOf(page), [
          'from: My lifeHealth first, then craft.', 'divide: ',
          'from: My yearThree things this year.\nSail, run, read.', 'divide: ',
          'own: Learn to sail · this treeClick to edit', `prose: ${GUIDE}`,
        ]);
        assert.deepEqual({
          focus: await focusedName(page),
          above: await inkOf(page, '.st-guide-from-text'),
          name: await inkOf(page, '.st-guide-from-name'),
          own: await inkOf(page, '.st-guide-own'),
          atTop: await page.locator('.st-guide-stack').evaluate((stack) => stack.scrollTop),
        }, {
          focus: 'st-guide-prose st-guide-prose--owner',
          above: { ink: 'secondary', size: '22px/32px', cursor: 'auto' },
          name: { ink: 'secondary', size: '13px/19px', cursor: 'pointer' },
          own: { ink: 'primary', size: '13px/19px', cursor: 'auto' },
          atTop: 0,
        });

        const above = page.locator('.st-guide-from-text').first();
        const resting = await above.evaluate((text) => getComputedStyle(text).backgroundColor);
        await above.hover();
        assert.equal(await above.evaluate((text) => getComputedStyle(text).backgroundColor), resting);
        await above.click();
        assert.equal(await field(page).count(), 0, 'a guide from above takes no caret');

        await prose(page).click({ position: { x: 1, y: 16 } });
        const writing = page.getByRole('dialog', { name: 'Edit guide' });
        await writing.waitFor();
        assert.deepEqual({
          caret: await caretState(page),
          context: await page.locator('.st-guide-context').evaluate((context) => [...context.children].map((child) => child.classList[0])),
          above: await page.locator('.st-guide-context .st-guide-from').evaluateAll((blocks) => blocks.map((block) => `${block.textContent} @${getComputedStyle(block).opacity}`)),
          text: await inkOf(page, '.st-guide-context .st-guide-from-text'),
          own: await page.locator('.st-guide-context .st-guide-own').textContent(),
          doors: await page.locator('.st-guide-context button').count(),
          stops: await page.locator('.st-guide-paper').evaluate((paper) => [...paper.querySelectorAll('button, textarea, [tabindex="0"]')].map((stop) => stop.textContent || stop.tagName)),
        }, {
          caret: { start: 0, end: 0, focused: true },
          context: ['st-guide-stack', 'st-guide-own'],
          above: ['My lifeHealth first, then craft. @0.6', 'My yearThree things this year.\nSail, run, read. @0.6'],
          text: { ink: 'secondary', size: '18px/26px', cursor: 'auto' },
          own: 'Learn to sail · this tree',
          doors: 0,
          stops: [GUIDE, 'Cancel', 'Save'],
        });
        assert.equal(await field(page).inputValue(), GUIDE);
        await page.keyboard.type('Then ');
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.writes), [`Then ${GUIDE}`]);
        assert.equal((await stackOf(page)).at(-1), `prose: Then ${GUIDE}`);
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'some' },
          { step: 'edit', via: 'click' },
          { step: 'save', outcome: 'saved', length: '1-500' },
        ]);
        const sent = JSON.stringify(await page.evaluate(() => window.events));
        for (const word of [...WORDS, 'life', 'year', 'Health', 'craft', 'Three', 'Sail']) assert.equal(sent.includes(word), false, word);
        assert.deepEqual(asked, ['GET']);
      });
    } finally { await page.close(); }
  });
}

test('Chromium: the name over a guide from above goes into its tree by the guide’s door, the hint beside this tree’s name writes from the end, and the pencil does the same', async () => {
  const { page } = await openHeld(repliedGuides(GUIDE), { guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual(await note.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)), ['Edit guide', 'Close', 'My life', 'My year']);
      await note.getByRole('button', { name: 'My year' }).click();
      await note.getByRole('button', { name: 'My life' }).press('Enter');
      assert.deepEqual(await page.evaluate(() => window.entered), [['t_year', 'guide'], ['t_life', 'guide']]);

      await page.getByText('Click to edit').click();
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      assert.deepEqual(await caretState(page), { start: GUIDE.length, end: GUIDE.length, focused: true });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await note.waitFor();
      await note.getByRole('button', { name: 'Edit guide' }).click();
      assert.deepEqual(await caretState(page), { start: GUIDE.length, end: GUIDE.length, focused: true });
      assert.deepEqual((await events(page)).slice(1), [{ step: 'edit', via: 'click' }, { step: 'edit', via: 'pencil' }]);
    });
  } finally { await page.close(); }
});

test('Chromium: a tree with no guide of its own under guides from above reads them, offers Add guide as its own block, and the first save is read in its place', async () => {
  const { page } = await openHeld(repliedGuides(null));
  try {
    await withBrowserErrors(page, async () => {
      const card = page.getByRole('button', { name: 'Guide', exact: true });
      assert.equal(await card.textContent(), 'GuideWith guides from My life and My yearRead guide→');
      assert.equal(await page.locator('.st-guide-card .lucide-book-open').count(), 1);
      await card.click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      await settled(page);
      assert.deepEqual(await stackOf(page), [
        'from: My lifeHealth first, then craft.', 'divide: ',
        'from: My yearThree things this year.\nSail, run, read.', 'divide: ',
        'own: Learn to sail · this tree', 'add: Add guide',
      ]);
      assert.deepEqual({ pencil: await note.getByRole('button', { name: 'Edit guide' }).count(), focus: await focusedName(page), tree: await stepInert(page) },
        { pencil: 0, focus: 'st-guide-add', tree: false });

      await note.getByRole('button', { name: 'Add guide' }).click();
      const adding = page.getByRole('dialog', { name: 'Add guide' });
      await adding.waitFor();
      assert.deepEqual(await caretState(page), { start: 0, end: 0, focused: true });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await note.waitFor();
      assert.equal((await stackOf(page)).at(-1), 'add: Add guide');

      await note.getByRole('button', { name: 'Add guide' }).click();
      await page.keyboard.type('One step a week.');
      await page.getByRole('button', { name: 'Save' }).click();
      await note.waitFor();
      assert.deepEqual((await stackOf(page)).slice(-2), ['own: Learn to sail · this treeClick to edit', 'prose: One step a week.']);
      assert.deepEqual(await page.evaluate(() => window.writes), ['One step a week.']);

      await note.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
      await page.getByRole('button', { name: 'Save' }).click();
      await note.waitFor();
      assert.equal((await stackOf(page)).at(-1), 'add: Add guide');
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'some' },
        { step: 'edit', via: 'add' }, { step: 'edit', via: 'add' },
        { step: 'save', outcome: 'saved', length: '1-500' },
        { step: 'edit', via: 'pencil' },
        { step: 'save', outcome: 'cleared', length: '0' },
      ]);

      await page.evaluate(() => window.setRoom({ holder: null }));
      await note.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: 'Add guide', exact: true }).textContent(), 'Add guide→');
    });
  } finally { await page.close(); }
});

test('Chromium: on a phone the row counts the guides from above, the sheet reads them over this tree’s own, and the editor holds this tree’s guide alone', async () => {
  const { page } = await openHeld(repliedGuides(GUIDE), { guide: GUIDE, band: 'phone' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      const row = page.getByRole('button', { name: 'Guide: One step a week.' });
      assert.equal(await row.textContent(), `Guide+2 from above${GUIDE}`);
      assert.equal(await row.evaluate((button) => document.getElementById(button.getAttribute('aria-describedby')).textContent), '+2 from above');
      assert.deepEqual(await inkOf(page, '.st-guide-row-above'), { ink: 'secondary', size: '12px/16px', cursor: 'pointer' });
      await row.click();
      const sheet = page.getByRole('dialog', { name: 'Guide', exact: true });
      await sheet.waitFor();
      await settled(page);
      assert.deepEqual(await stackOf(page), [
        'from: My lifeHealth first, then craft.', 'divide: ',
        'from: My yearThree things this year.\nSail, run, read.', 'divide: ',
        'own: Learn to sail · this treeTap to edit', `prose: ${GUIDE}`,
      ]);
      assert.deepEqual({
        above: await inkOf(page, '.st-guide-from-text'),
        own: await inkOf(page, '.st-guide-prose'),
        inset: await page.locator('.st-guide-from-text').first().evaluate((text) => text.getBoundingClientRect().left),
        foot: await sheet.evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom),
      }, { above: { ink: 'secondary', size: '15px/22px', cursor: 'auto' }, own: { ink: 'primary', size: '17px/25px', cursor: 'text' }, inset: 22, foot: 0 });

      await sheet.getByRole('button', { name: 'My life' }).click();
      assert.deepEqual(await page.evaluate(() => window.entered), [['t_life', 'guide']]);

      await page.getByText('Tap to edit').click();
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      assert.deepEqual({ above: await page.locator('.st-guide-from, .st-guide-own, .st-guide-context').count(), draft: await field(page).inputValue() }, { above: 0, draft: GUIDE });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await sheet.waitFor();
      assert.equal(await page.locator('.st-guide-from').count(), 2);
      assert.deepEqual(await events(page), [{ step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'some' }, { step: 'edit', via: 'tap' }]);
    });
  } finally { await page.close(); }
});

test('Chromium: the card’s line names one tree, two, or the two farthest and how many more; a phone row with no guide of its own still counts them', async () => {
  const above = (...titles) => titles.map((title, index) => ({ treeId: `t_${index}`, title, text: 'A guide.', yours: index > 0 }));
  for (const [guides, line] of [
    [above('My life'), 'With a guide from My life'],
    [above('My life', '', 'Learn to sail'), 'With guides from My life, Untitled roadmap and 1 more tree'],
    [above('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'), 'With guides from A, B and 6 more trees'],
  ]) {
    const { page } = await openHeld(guides, { guide: GUIDE });
    try {
      assert.equal(await page.locator('.st-guide-card-above').textContent(), line);
    } finally { await page.close(); }
  }
  const { page } = await openHeld(above('My life'), { band: 'phone' }, { width: 390, height: 844 });
  try {
    assert.equal(await page.getByRole('button', { name: 'Guide', exact: true }).textContent(), 'Guide+1 from above');
  } finally { await page.close(); }
});

test('Chromium: a read of the guides above that fails leaves the tree’s own guide alone and says nothing; it reports once with the kind of failure, except with no connection or a refusal', async () => {
  for (const [guides, online, reason] of [[503, true, 'unavailable'], [500, true, 'server'], ['lost', true, 'network'], ['lost', false, null], [404, true, null]]) {
    const { page, asked } = await openHeld(guides, { guide: GUIDE }, { online });
    try {
      const said = complaintsOf(page);
      const card = page.getByRole('button', { name: 'Guide: One step a week.' });
      await page.waitForFunction((count) => (window.issues ?? []).length === count, reason ? 1 : 0);
      assert.equal(await card.textContent(), 'GuideOne step a week.Read guide→');
      await card.click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual({
        above: await page.locator('.st-guide-from').count(),
        prose: await prose(page).textContent(),
        said: await page.locator('[role="alert"], [role="status"]').count(),
        issues: await issues(page),
        asked,
        events: await events(page),
        complaints: said,
      }, {
        above: 0,
        prose: GUIDE,
        said: 0,
        issues: reason ? [{ operation: 'roadmap-guides-load', stack: true, tags: { reason } }] : [],
        asked: ['GET'],
        events: [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'unread' }],
        complaints: [],
      }, `${guides} ${online ? 'online' : 'offline'}`);
    } finally { await page.close(); }
  }
});

test('Chromium: a 200 that is not the contract’s shape reports once as such and says nothing on screen; the well-formed guides in it are still shown, and the press says the guides above went unread', async () => {
  const life = { treeId: 't_life', title: 'My life', text: 'Health first, then craft.', yours: true };
  for (const [body, line] of [
    ['<!doctype html><title>My life</title>Health first', null],
    ['{"guides":[{"treeId":"t_life","title":"My life","text":"Health first, then craft', null],
    ['null', null], ['{}', null], ['{"guides":{"treeId":"t_life"}}', null],
    [JSON.stringify({ items: [life] }), null],
    [JSON.stringify({ guides: [{ tree_id: 't_life', name: 'My life', guide: 'Health first' }, null, 7] }), null],
    [JSON.stringify({ guides: [life, { treeId: '', title: 'An empty id', text: 'Words.' }] }), 'With a guide from My life'],
  ]) {
    const { page, asked } = await openHeld({ body }, { guide: GUIDE });
    try {
      const said = complaintsOf(page);
      await page.waitForFunction(() => (window.issues ?? []).length === 1);
      const card = page.getByRole('button', { name: 'Guide: One step a week.' });
      assert.equal(await card.textContent(), `GuideOne step a week.${line ?? ''}Read guide→`, body);
      await card.click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      const sent = JSON.stringify([await issues(page), await page.evaluate(() => window.events)]);
      assert.deepEqual({
        above: await page.locator('.st-guide-from').count(),
        said: await page.locator('[role="alert"], [role="status"]').count(),
        issues: await issues(page),
        asked,
        events: await events(page),
        words: ['life', 'Health', 'craft'].filter((word) => sent.includes(word)),
        complaints: said,
      }, {
        above: line ? 1 : 0,
        said: 0,
        issues: [{ operation: 'roadmap-guides-load', stack: true, tags: { reason: 'shape' } }],
        asked: ['GET'],
        events: [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'unread' }],
        words: [],
        complaints: [],
      }, body);
    } finally { await page.close(); }
  }
});

test('Chromium: a reader and a room with no holder ask for nothing and are shown nothing from above; a holder with nothing above keeps the card and the note as they were', async () => {
  for (const options of [{ guide: GUIDE, role: 'reader', holder: null }, { guide: GUIDE, holder: null }]) {
    const { page, asked } = await openHeld(repliedGuides(GUIDE), options);
    try {
      const label = options.role === 'reader' ? 'Author’s note' : 'Guide';
      const card = page.getByRole('button', { name: `${label}: One step a week.` });
      assert.equal(await card.textContent(), `${label}One step a week.Read ${options.role === 'reader' ? 'note' : 'guide'}→`);
      await card.click();
      await page.getByRole('dialog', { name: label, exact: true }).waitFor();
      assert.deepEqual({ stack: await page.locator('.st-guide-stack').count(), asked }, { stack: 0, asked: [] });
    } finally { await page.close(); }
  }
  const { page, asked } = await openHeld([{ treeId: 'sail', title: 'Learn to sail', text: GUIDE, yours: true }], { guide: GUIDE });
  try {
    const card = page.getByRole('button', { name: 'Guide: One step a week.' });
    assert.equal(await card.textContent(), 'GuideOne step a week.Read guide→');
    assert.equal(await card.getAttribute('aria-describedby'), null);
    await card.click();
    const note = page.getByRole('dialog', { name: 'Guide', exact: true });
    await note.waitFor();
    assert.deepEqual({
      body: await note.locator(':scope > *').evaluateAll((parts) => parts.map((part) => `${part.classList[0]} ${getComputedStyle(part).display}`)),
      text: await prose(page).evaluate((own) => own.parentElement.classList[0]),
      stops: await note.locator('[tabindex="0"]').evaluateAll((stops) => stops.map((stop) => stop.classList[0])),
      asked,
      events: await events(page),
    }, {
      body: ['st-guide-heading flex', 'st-guide-rule block', 'st-guide-alone contents'],
      text: 'st-guide-alone',
      stops: ['st-guide-prose'],
      asked: ['GET'],
      events: [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }],
    });
  } finally { await page.close(); }
});

test('Chromium: a long stack scrolls inside the note, which stays in the window, and while writing the guides above scroll by themselves over a field that keeps its room', async () => {
  const long = Array.from({ length: 30 }, (_, line) => `Line ${line + 1} of a guide from above.`).join('\n');
  const guides = [{ treeId: 't_life', title: 'My life', text: long, yours: true }, { treeId: 't_year', title: 'My year', text: long, yours: true }];
  const { page } = await openHeld(guides, { guide: GUIDE }, { width: 1024, height: 700 });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      await settled(page);
      assert.deepEqual(await page.locator('.st-guide-stack').evaluate((stack) => ({
        scrolls: stack.scrollHeight > stack.clientHeight,
        ownScrolls: stack.querySelector('.st-guide-prose').scrollHeight > stack.querySelector('.st-guide-prose').clientHeight,
        inWindow: stack.closest('.st-guide-paper').getBoundingClientRect().bottom <= window.innerHeight - 24,
      })), { scrolls: true, ownScrolls: false, inWindow: true });
      await page.keyboard.press('End');
      await page.waitForFunction(() => {
        const stack = document.querySelector('.st-guide-stack');
        return stack.scrollTop + stack.clientHeight >= stack.scrollHeight - 1;
      });

      await prose(page).press('Enter');
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      assert.deepEqual(await page.locator('.st-guide-paper').evaluate((paper) => {
        const stack = paper.querySelector('.st-guide-context > .st-guide-stack');
        const field = paper.querySelector('.st-guide-field');
        const own = paper.querySelector('.st-guide-context > .st-guide-own').getBoundingClientRect();
        return {
          aboveScrolls: stack.scrollHeight > stack.clientHeight,
          fieldHoldsDraft: field.clientHeight >= field.scrollHeight,
          nameOverField: own.bottom <= field.getBoundingClientRect().top && own.top >= stack.getBoundingClientRect().bottom,
          inWindow: paper.getBoundingClientRect().bottom <= window.innerHeight - 24,
        };
      }), { aboveScrolls: true, fieldHoldsDraft: true, nameOverField: true, inWindow: true });
    });
  } finally { await page.close(); }
});

test('Chromium: guides from above that answer while the note already reads stand over the prose, which keeps its focus, and Escape still closes', async () => {
  await start();
  const page = await open({ mount: false });
  try {
    await withBrowserErrors(page, async () => {
      const answered = {};
      await page.route('**/v1/trees/sail/guides', async (route) => {
        await new Promise((resolve) => { answered.now = resolve; });
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ guides: repliedGuides(GUIDE) }) });
      });
      await page.evaluate((mounted) => window.mount(mounted), { guide: GUIDE, holder: 'u_olya' });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).press('Enter');
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual({ stack: await page.locator('.st-guide-stack').count(), focus: await focusedName(page) }, { stack: 0, focus: 'st-guide-prose st-guide-prose--owner is-ringed' });

      answered.now();
      await page.locator('.st-guide-stack').waitFor();
      assert.deepEqual({ above: await page.locator('.st-guide-from').count(), focus: await focusedName(page) }, { above: 2, focus: 'st-guide-prose st-guide-prose--owner is-ringed' });
      await page.keyboard.press('Escape');
      await note.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.st-guide-card-above').textContent(), 'With guides from My life and My year');
    });
  } finally { await page.close(); }
});

// A tree's own guide long enough to scroll, under two guides from above that are as long.
const longOwn = () => Array.from({ length: 50 }, (_, line) => `Line ${String(line + 1).padStart(3, '0')} of this tree's own guide, long enough to wrap now and then.`).join('\n');
const longAbove = () => [
  { treeId: 't_life', title: 'My life', text: Array.from({ length: 40 }, (_, line) => `Life line ${line + 1}: health first, then craft, then money.`).join('\n'), yours: true },
  { treeId: 't_year', title: 'My year', text: Array.from({ length: 40 }, (_, line) => `Year line ${line + 1}: sail, run, read.`).join('\n'), yours: true },
];
// Whether the caret's line is inside what the field shows, measured as the note measures it: a hidden copy of the text before the caret.
const caretInView = (page) => field(page).evaluate((box) => {
  const copy = document.createElement('div');
  copy.className = box.className;
  copy.style.cssText = `position: absolute; visibility: hidden; box-sizing: border-box; width: ${box.clientWidth}px; height: auto; min-height: 0; max-height: none; border: 0; white-space: pre-wrap; animation: none;`;
  copy.textContent = `${box.value.slice(0, box.selectionEnd)}​`;
  box.after(copy);
  const foot = copy.offsetHeight;
  copy.remove();
  const line = parseFloat(getComputedStyle(box).lineHeight);
  return { caret: box.selectionStart, inView: foot - line >= box.scrollTop - 1 && foot <= box.scrollTop + box.clientHeight + 1 };
});
// Scrolls whatever scrolls while reading so `words` of this tree's text stand near its top, and answers a point on them.
const pointOn = (page, words) => page.evaluate((target) => {
  const own = document.querySelector('.st-guide-prose');
  const at = own.firstChild.data.indexOf(target);
  const range = document.createRange();
  range.setStart(own.firstChild, at);
  range.setEnd(own.firstChild, at + target.length);
  const scroller = document.querySelector('.st-guide-stack') ?? own;
  scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 60;
  const box = range.getBoundingClientRect();
  return { x: box.left + 3, y: box.top + box.height / 2 };
}, words);
// Where the stack stands and what of this tree's guide shows in it.
const standingOf = (page) => page.evaluate(() => {
  const stack = document.querySelector('.st-guide-stack');
  const shown = stack.getBoundingClientRect();
  const own = document.querySelector('.st-guide-prose').getBoundingClientRect();
  return { scrollTop: Math.round(stack.scrollTop), ownInView: own.top < shown.bottom && own.bottom > shown.top, focus: document.activeElement.classList[0] };
});

for (const [engine, band, width, height] of [[chromium, 'desktop', 1440, 960], [chromium, 'phone', 390, 844], [webkit, 'desktop', 1440, 960]]) {
  test(`${engine.name()}, ${band}: under guides from above a press on this tree's text writes where it landed with its line in view, and leaving the draft returns the note to where it was read`, async () => {
    const { page } = await openHeld([...longAbove(), { treeId: 'sail', title: 'Learn to sail', text: longOwn(), yours: true }], { guide: longOwn(), band }, { engine, width, height });
    try {
      await page.locator(band === 'phone' ? '.st-guide-row' : '.st-guide-card').click();
      await page.locator('.st-guide-stack').waitFor();
      await settled(page);
      const point = await pointOn(page, 'Line 003');
      await page.mouse.click(point.x, point.y);
      await field(page).waitFor();
      assert.deepEqual(await caretInView(page), { caret: longOwn().indexOf('Line 003'), inView: true });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.locator('.st-guide-stack').waitFor();

      await pointOn(page, 'Line 020');
      await page.locator('.st-guide-hint').scrollIntoViewIfNeeded();
      const read = await standingOf(page);
      await page.locator('.st-guide-hint').click();
      await field(page).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.locator('.st-guide-stack').waitFor();
      assert.deepEqual(await standingOf(page), { scrollTop: read.scrollTop, ownInView: true, focus: 'st-guide-prose' });
    } finally { await page.close(); }
  });
}

test('Chromium: a draft begun from the pencil while a guide from above is read, then saved or cancelled, returns the note with this tree’s guide in view under its name', async () => {
  for (const leave of ['Cancel', 'Save']) {
    const { page } = await openHeld([...longAbove(), { treeId: 'sail', title: 'Learn to sail', text: longOwn(), yours: true }], { guide: longOwn() });
    try {
      await page.locator('.st-guide-card').click();
      await page.locator('.st-guide-stack').waitFor();
      await settled(page);
      assert.deepEqual(await standingOf(page), { scrollTop: 0, ownInView: false, focus: 'st-guide-stack' });
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).waitFor();
      if (leave === 'Save') await page.keyboard.type(' Saved words.');
      await page.getByRole('button', { name: leave, exact: true }).click();
      await page.locator('.st-guide-stack').waitFor();
      assert.deepEqual(await page.evaluate(() => {
        const stack = document.querySelector('.st-guide-stack');
        const shown = stack.getBoundingClientRect();
        const name = document.querySelector('.st-guide-own').getBoundingClientRect();
        const own = document.querySelector('.st-guide-prose');
        return { nameAtTop: Math.round(name.top - shown.top), ownInView: own.getBoundingClientRect().top < shown.bottom, focus: document.activeElement.classList[0], saved: own.textContent.endsWith('Saved words.') };
      }), { nameAtTop: 4, ownInView: true, focus: 'st-guide-prose', saved: leave === 'Save' }, leave);
    } finally { await page.close(); }
  }
});

test('Chromium: a note opened by a key under guides that start this tree’s text below the fold rests its focus on the stack, ringed; it scrolls from there, Enter leaves nothing, and Tab walks the names and then the text', async () => {
  const { page } = await openHeld([...longAbove(), { treeId: 'sail', title: 'Learn to sail', text: GUIDE, yours: true }], { guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).press('Enter');
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      await settled(page);
      const stack = page.locator('.st-guide-stack');
      assert.deepEqual({
        focus: await focusedName(page),
        ring: await stack.evaluate((element) => getComputedStyle(element).outlineStyle),
        role: await stack.getAttribute('role'),
        named: await stack.evaluate((element) => document.getElementById(element.getAttribute('aria-labelledby')).textContent),
      }, { focus: 'st-guide-stack is-ringed', ring: 'solid', role: 'region', named: 'Guide' });

      await page.keyboard.press('Enter');
      await page.keyboard.press('PageDown');
      await page.waitForFunction(() => document.querySelector('.st-guide-stack').scrollTop > 0);
      assert.deepEqual({ writing: await field(page).count(), entered: await page.evaluate(() => window.entered), open: await note.count() }, { writing: 0, entered: [], open: 1 });

      const walked = [];
      for (let stop = 0; stop < 3; stop += 1) {
        await page.keyboard.press('Tab');
        walked.push(await page.evaluate(() => (document.activeElement.classList.contains('st-guide-prose') ? 'this tree’s text' : document.activeElement.textContent)));
      }
      assert.deepEqual(walked, ['My life', 'My year', 'this tree’s text']);
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
    });
  } finally { await page.close(); }
});

test('Chromium: under short guides from above a note opened by a key rests its focus on this tree’s text, ringed, and Enter writes, as with nothing above', async () => {
  const { page } = await openHeld(repliedGuides(GUIDE), { guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).press('Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      await settled(page);
      assert.equal(await focusedName(page), 'st-guide-prose st-guide-prose--owner is-ringed');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      assert.deepEqual(await caretState(page), { start: GUIDE.length, end: GUIDE.length, focused: true });
    });
  } finally { await page.close(); }
});

test('Chromium: guides from above that answer while a long note is being read move nothing: the line read stays in view with its selection, and the press before they answered said they were unread', async () => {
  await start();
  const page = await open({ mount: false });
  try {
    const answered = {};
    await page.route('**/v1/trees/sail/guides', async (route) => {
      await new Promise((resolve) => { answered.now = resolve; });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ guides: [...longAbove(), { treeId: 'sail', title: 'Learn to sail', text: longOwn(), yours: true }] }) });
    });
    await page.evaluate((mounted) => window.mount(mounted), { guide: longOwn(), holder: 'u_olya' });
    await page.locator('.st-guide-card').click();
    await prose(page).waitFor();
    await settled(page);
    await pointOn(page, 'Line 030');
    const standing = () => page.evaluate(() => {
      const own = document.querySelector('.st-guide-prose');
      const at = own.firstChild.data.indexOf('Line 030');
      const range = document.createRange();
      range.setStart(own.firstChild, at);
      range.setEnd(own.firstChild, at + 8);
      if (String(getSelection()) === '') getSelection().addRange(range);
      const shown = (document.querySelector('.st-guide-stack') ?? own).getBoundingClientRect();
      return { lineFromTop: Math.round(range.getBoundingClientRect().top - shown.top), selected: String(getSelection()), stacked: document.querySelectorAll('.st-guide-from').length };
    });
    const before = await standing();
    assert.deepEqual(before, { lineFromTop: 60, selected: 'Line 030', stacked: 0 });

    const read = page.waitForEvent('requestfinished', (request) => request.url().endsWith('/guides'));
    answered.now();
    await read;
    await page.locator('.st-guide-stack').waitFor();
    assert.deepEqual(await standing(), { lineFromTop: 64, selected: 'Line 030', stacked: 2 });
    assert.deepEqual(await events(page), [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'unread' }]);
  } finally { await page.close(); }
});

test('Chromium: the card’s line never loses its count, whatever the font: its words never shrink, and where two long titles do not fit, the titles alone give way', async () => {
  const titled = (count) => ['The year I finally learn to sail a dinghy single-handed', 'Everything I want from the next ten years of my life', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, count).map((title, index) => ({ treeId: `t_${index}`, title, text: 'A guide.', yours: true }));
  // The card's own font, once loaded, and wider and narrower ones forced on its line, as another system's fonts or a
  // fallback would measure. The card's own font and a narrower one keep the one line 28.29 draws; a font so wide that
  // the sentence's words overrun the line wraps them, and still loses nothing.
  const fonts = {
    card: null,
    wider: 'font-family: monospace; letter-spacing: 0.08em',
    widest: 'font-family: monospace; letter-spacing: 0.5em',
    narrower: 'letter-spacing: -0.06em',
  };
  const oneLine = (font) => font === 'card' || font === 'narrower';
  for (const [count, said] of [
    [8, 'With guides from The year I finally learn to sail a dinghy single-handed, Everything I want from the next ten years of my life and 6 more trees'],
    [3, 'With guides from The year I finally learn to sail a dinghy single-handed, Everything I want from the next ten years of my life and 1 more tree'],
    [2, 'With guides from The year I finally learn to sail a dinghy single-handed and Everything I want from the next ten years of my life'],
    [1, 'With a guide from The year I finally learn to sail a dinghy single-handed'],
  ]) {
    const { page } = await openHeld(titled(count), { guide: GUIDE });
    try {
      await page.evaluate(() => document.fonts.ready);
      for (const [font, forced] of Object.entries(fonts)) {
        const measured = await page.locator('.st-guide-card-above').evaluate((above, style) => {
          above.style.cssText = style ?? '';
          const line = above.querySelector(':scope > span');
          const shown = line.getBoundingClientRect();
          const card = above.closest('.st-guide-card');
          const edges = getComputedStyle(card);
          const box = card.getBoundingClientRect();
          const inner = { left: box.left + parseFloat(edges.paddingLeft), right: box.right - parseFloat(edges.paddingRight) };
          const words = [...line.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).flatMap((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()];
          });
          const rows = new Set([...line.childNodes].flatMap((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].map((rect) => Math.round(rect.top));
          }));
          return {
            text: line.textContent,
            clipped: line.scrollHeight > line.clientHeight + 1 || line.scrollWidth > line.clientWidth + 1,
            wordsShown: words.every((rect) => rect.left >= shown.left - 1 && rect.right <= shown.right + 1 && rect.top >= shown.top - 1 && rect.bottom <= shown.bottom + 1),
            insideCard: words.every((rect) => rect.left >= inner.left - 1 && rect.right <= inner.right + 1) && shown.right <= inner.right + 1,
            lines: rows.size,
            titlesGiveWay: [...line.querySelectorAll('.st-guide-card-tree')].map((title) => title.scrollWidth > title.clientWidth),
          };
        }, forced);
        const { lines, ...kept } = measured;
        assert.deepEqual(oneLine(font) ? measured : kept, {
          text: said, clipped: false, wordsShown: true, insideCard: true,
          ...(oneLine(font) ? { lines: 1 } : {}),
          titlesGiveWay: Array.from({ length: Math.min(count, 2) }, () => true),
        }, `${font}: ${said} (${lines} lines)`);
      }
    } finally { await page.close(); }
  }
});

test('Chromium: while a guide is written from 744px the guides above are readable or not drawn: a long draft in a short window takes their place, and they return when the draft leaves the room', async () => {
  for (const height of [960, 900, 860, 800, 700]) {
    const { page } = await openHeld([...longAbove(), { treeId: 'sail', title: 'Learn to sail', text: longOwn(), yours: true }], { guide: longOwn() }, { width: 1440, height });
    try {
      await withBrowserErrors(page, async () => {
        await page.locator('.st-guide-card').click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await field(page).waitFor();
        await settled(page);
        const drawn = () => page.evaluate(() => {
          const context = document.querySelector('.st-guide-context');
          const above = context.querySelector('.st-guide-stack');
          const paper = document.querySelector('.st-guide-paper').getBoundingClientRect();
          return { above: above.clientHeight, name: context.querySelector('.st-guide-own').getClientRects().length, inWindow: paper.bottom <= innerHeight - 24 };
        });
        assert.deepEqual(await drawn(), { above: 0, name: 0, inWindow: true }, `a 50-line draft at ${height}px`);

        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type('One line.');
        await page.waitForFunction(() => document.querySelector('.st-guide-context > .st-guide-stack').clientHeight > 0);
        const short = await drawn();
        assert.deepEqual({ readable: short.above >= 8 + 19 + 6 + 26, name: short.name, inWindow: short.inWindow }, { readable: true, name: 1, inWindow: true }, `a one-line draft at ${height}px: ${short.above}px`);
      });
    } finally { await page.close(); }
  }
});
