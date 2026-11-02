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
