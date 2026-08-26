import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { elementsOf, loadScreen } from '../products/gym/harness.mjs';

const RAIL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/design-system/navigation/TabRail.jsx');

const ROOMS = [
  { label: 'Routines', href: '#/gym', active: true },
  { label: 'The log', href: '#/gym/log', active: false },
  { label: 'Coach', href: '#/gym/coach', active: false },
];

test('the rail draws one column per item, and the active one is the current page', async () => {
  const { TabRail } = await loadScreen('design-system/navigation/TabRail.jsx');
  const links = elementsOf(TabRail({ items: ROOMS })).filter((each) => each.type === 'a');
  assert.deepEqual(links.map((each) => each.props.href), ['#/gym', '#/gym/log', '#/gym/coach']);
  assert.deepEqual(links.map((each) => each.props.children), ['Routines', 'The log', 'Coach']);
  assert.deepEqual(links.map((each) => each.props['aria-current']), ['page', undefined, undefined]);

  const nav = elementsOf(TabRail({ items: ROOMS })).find((each) => each.type === 'nav');
  assert.equal(nav.props.style.gridTemplateColumns, 'repeat(3, 1fr)');
  assert.equal(nav.props.style.position, 'fixed');

  // Two items are two columns: the count is the items', never a number written twice.
  const two = elementsOf(TabRail({ items: ROOMS.slice(0, 2) })).find((each) => each.type === 'nav');
  assert.equal(two.props.style.gridTemplateColumns, 'repeat(2, 1fr)');

  // Two rooms may share a destination — a gallery demo does — and each is still its own slot.
  const shared = [
    { label: 'Routines', href: '#showcase', active: true },
    { label: 'The log', href: '#showcase', active: false },
  ];
  const keys = elementsOf(TabRail({ items: shared })).filter((each) => each.type === 'a').map((each) => each.key);
  assert.deepEqual(keys, ['Routines', 'The log']);
  assert.equal(new Set(keys).size, keys.length);
});

test('the rail reserves its own height, so a page that mounts it never has to know how tall it is', async () => {
  const { TabRail, RAIL_HEIGHT } = await loadScreen('design-system/navigation/TabRail.jsx');
  const reserve = elementsOf(TabRail({ items: ROOMS }))
    .find((each) => each.type === 'div' && each.props['aria-hidden'] === 'true');
  assert.equal(reserve.props.style.height, RAIL_HEIGHT);
  assert.equal(RAIL_HEIGHT, 72);
});

test('the rail has no fourth slot, and paints in roles rather than in one product’s colours', () => {
  const source = fs.readFileSync(RAIL, 'utf8');
  const drawn = source.replace(/^\/\/.*$/gm, '');
  assert.equal(/avatar|AccountSeat/i.test(drawn), false, 'a rail has as many slots as it has rooms');
  assert.equal(drawn.includes('items.map'), true, 'and it draws exactly the items it was given');
  for (const role of ['var(--color-brand)', 'var(--text-tertiary)', 'var(--surface-canvas)', 'var(--font-body)']) {
    assert.equal(source.includes(role), true, role);
  }
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(source), false, 'no hard-coded colour');
  assert.equal(/gym|journal|roadmap/i.test(source), false, 'the design system knows no product');
});
