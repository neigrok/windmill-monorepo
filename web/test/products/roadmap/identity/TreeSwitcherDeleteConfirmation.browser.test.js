import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTreeSwitcherHost, openMenu } from './treeSwitcherHost.js';

const { withSwitcher, close } = createTreeSwitcherHost('delete-confirmation');
after(close);

async function confirmDeleting(page, title) {
  await page.getByRole('menuitem').filter({ hasText: title }).hover();
  await page.getByRole('button', { name: `Delete ${title}` }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
}

// The confirming row as a person meets it: the question, the line, what Delete is described by, the titles in bold, where
// the ring sits against the question's first line, whether any of its text is cut, and how wide the menu stands.
const confirmingRow = (page) => page.getByRole('button', { name: 'Delete', exact: true }).evaluate((del) => {
  const row = del.closest('[role="menuitem"]');
  const question = row.querySelector('span > span');
  const line = row.querySelector('[id]');
  const ring = row.firstElementChild.getBoundingClientRect();
  const first = question.getBoundingClientRect();
  const cut = [...row.querySelectorAll('span')].some((span) => getComputedStyle(span).textOverflow === 'ellipsis'
    || (getComputedStyle(span).display !== 'inline' && span.scrollWidth > span.clientWidth));
  return {
    question: question.textContent,
    line: line?.textContent ?? null,
    bold: [...(line?.querySelectorAll('strong') ?? [])].map((strong) => strong.textContent),
    describedBy: del.getAttribute('aria-describedby') && document.getElementById(del.getAttribute('aria-describedby')).textContent,
    ring: Math.round(ring.top - first.top) === 2 ? 'first line' : Math.round(ring.top + ring.height / 2 - (row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2)) === 0 ? 'centred' : 'elsewhere',
    cut,
    menu: Math.round(row.closest('[role="menu"]').getBoundingClientRect().width),
  };
});

const server28 = (row) => ({ done: 1, total: 4, dominantKind: 'sky', updatedAt: '2026-11-01T00:00:00Z', origin: 'server', ...row });

test('Chromium: the confirmation names the steps in the person’s other trees that go with the tree, in each of its four forms, and counts the trees it cannot name', async () => {
  const rows = [
    server28({ id: 'sail', title: 'Learn to sail', openers: [{ treeId: 't_summer', steps: 1 }, { treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_life', title: 'My life', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
    server28({ id: 't_read', title: 'Reading list', openers: [{ treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_spanish', title: 'Spanish basics', openers: [{ treeId: 't_summer', steps: 2 }] }),
    server28({ id: 't_health', title: 'Stay healthy', openers: [{ treeId: 't_spanish', steps: 1 }, { treeId: 't_summer', steps: 1 }, { treeId: 't_life', steps: 1 }, { treeId: 't_read', steps: 1 }] }),
    server28({ id: 't_coast', title: 'Coast trip', openers: [{ treeId: 't_gone', steps: 3 }, { treeId: 't_year', steps: 1 }] }),
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const seen = [];
    for (const title of ['Reading list', 'Spanish basics', 'Learn to sail', 'Stay healthy', 'Coast trip']) {
      await confirmDeleting(page, title);
      seen.push(await confirmingRow(page));
      await page.getByRole('button', { name: 'Keep' }).click();
    }
    const formed = (title, line, bold) => ({ question: `Delete ${title}? This can’t be undone`, line, bold, describedBy: line, ring: 'first line', cut: false, menu: 300 });
    assert.deepEqual(seen, [
      formed('Reading list', 'Also removes the step that opens it in My year', ['My year']),
      formed('Spanish basics', 'Also removes 2 steps that open it in Summer plans', ['Summer plans']),
      formed('Learn to sail', 'Also removes 2 steps that open it, in My year and Summer plans', ['My year', 'Summer plans']),
      formed('Stay healthy', 'Also removes 4 steps that open it, in My life, Summer plans and 2 more trees', ['My life', 'Summer plans']),
      formed('Coast trip', 'Also removes 4 steps that open it in 2 of your other trees', []),
    ]);
    assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }]);
  });
});

test('Chromium: a tree nothing opens, and any tree from a server that sends no openers, asks the question alone, wrapped and centred', async () => {
  const rows = [
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
    server28({ id: 't_old', title: 'A tree the server says nothing about' }),
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const seen = [];
    for (const title of ['Summer plans', 'A tree the server says nothing about']) {
      await confirmDeleting(page, title);
      seen.push(await confirmingRow(page));
      await page.getByRole('button', { name: 'Keep' }).click();
    }
    assert.deepEqual(seen, [
      { question: 'Delete Summer plans? This can’t be undone', line: null, bold: [], describedBy: null, ring: 'centred', cut: false, menu: 300 },
      { question: 'Delete A tree the server says nothing about? This can’t be undone', line: null, bold: [], describedBy: null, ring: 'centred', cut: false, menu: 300 },
    ]);
  });
});

test('Chromium: a delete says whether steps opened the tree and where the tree lived, and a tree deleted first is no longer counted for the trees it opened', async () => {
  const rows = [
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [{ treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_coast', title: 'Coast trip', openers: [{ treeId: 't_summer', steps: 2 }] }),
    server28({ id: 't_old', title: 'Old server row' }),
    { id: 't_draft', title: 'Draft on the device', updatedAt: 0, origin: 'device', claimed: false, openers: [{ treeId: 't_year', steps: 2 }] },
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const lines = [];
    for (const title of ['Summer plans', 'Coast trip', 'Old server row', 'Draft on the device']) {
      await confirmDeleting(page, title);
      lines.push((await confirmingRow(page)).line);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('menuitem').filter({ hasText: title }).waitFor({ state: 'detached' });
    }
    assert.deepEqual(lines, ['Also removes the step that opens it in My year', null, null, 'Also removes 2 steps that open it in My year']);
    assert.deepEqual(await page.evaluate(() => window.events), [
      { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'some', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'some', place: 'device' } },
    ]);
  });
});

// The row's Delete as the accessibility tree hands it to a screen reader once a key has put focus on it.
async function focusedButton(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const focused = nodes.find((node) => node.role?.value === 'button' && node.properties?.some((property) => property.name === 'focused' && property.value.value));
  return { name: focused?.name?.value, description: focused?.description?.value };
}

test('Chromium: from the keyboard, Delete is reached and a screen reader hears the line as its description', async () => {
  const rows = [
    server28({ id: 'sail', title: 'Learn to sail', openers: [{ treeId: 't_summer', steps: 1 }, { treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
  ];
  await withSwitcher(rows, async (page) => {
    await page.locator('#fixture [aria-haspopup="menu"]').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    for (const key of ['Tab', 'Tab', 'Tab']) await page.keyboard.press(key);
    assert.deepEqual(await focusedButton(page), { name: 'Delete Learn to sail', description: undefined });
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
    assert.deepEqual(await focusedButton(page), { name: 'Delete', description: 'Also removes 2 steps that open it, in My year and Summer plans' });
  });
});
