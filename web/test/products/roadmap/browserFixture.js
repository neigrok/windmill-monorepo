import assert from 'node:assert/strict';

export function fixtureNodes(total) {
  return [
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
    ...Array.from({ length: total - 1 }, (_, index) => ({
      id: `step-${index}`,
      label: `Chart ${index}`,
      prerequisites: ['wind'],
      color: 'olive',
    })),
  ];
}

export const beacon = `
export function track(name, props) { (window.events ??= []).push({ name, props }); }
export function reportError(error) { (window.reportedErrors ??= []).push(String(error)); }
export function routeFamily(route) { return route; }
`;

export async function formReturned(page, title = 'New step') {
  await page.locator('.st-board-picker').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement.matches('.st-board-draft-needs'));
  assert.equal(await page.getByRole('dialog', { name: title, exact: true }).count(), 1);
}

const pageFailures = new WeakMap();

export async function withBrowserErrors(page, run) {
  if (!pageFailures.has(page)) {
    const failure = new Promise((resolve, reject) => {
      page.on('pageerror', reject);
      const consoleError = (message) => {
        if (message.type() === 'error') reject(new Error(message.text()));
      };
      page.on('console', consoleError);
      page.once('close', () => {
        page.off('pageerror', reject);
        page.off('console', consoleError);
        pageFailures.delete(page);
      });
    });
    failure.catch(() => {});
    pageFailures.set(page, failure);
  }
  return Promise.race([pageFailures.get(page), Promise.resolve().then(run)]);
}

const imported = Date.parse('2026-10-20T09:00:00Z');
export const learnToSailNodes = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', createdMs: imported },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', createdMs: imported },
  { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', createdMs: imported },
  { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', createdMs: Date.parse('2026-10-22T10:00:00Z') },
  { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', createdMs: Date.parse('2026-10-21T10:00:00Z') },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', createdMs: imported },
  { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', createdMs: imported },
  { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', createdMs: imported },
];

export const boardEvents = (page) => page.evaluate(() => (window.events ?? []).map(({ name, props }) => `${name} ${JSON.stringify(props)}`));
export const focusedBoardStep = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element.querySelector('.st-board-card-title')?.textContent ?? element.textContent;
});

// Each column as one line: its name, then its cards' titles, or what an emptied column says and its way out.
export const boardColumns = (page) => page.evaluate(() => [...document.querySelectorAll('[data-column]')].map((column) => {
  const cards = [...column.querySelectorAll('.st-board-card-title')].map((title) => title.textContent);
  const empty = column.querySelector('.st-board-column-empty, .st-board-pane-empty');
  const said = empty ? [`“${empty.querySelector('p').textContent}” · ${empty.querySelector('button').textContent}`] : [];
  return `${column.dataset.column}: ${[...cards, ...said].join(', ')}`;
}));
