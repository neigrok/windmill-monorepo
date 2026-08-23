import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KINDS,
  GENESIS_STAMP,
  deriveLegend,
  withCounts,
  inUseCount,
  freeHue,
  renameKind,
  describeKind,
  addKind,
  removeKind,
  recolorKind,
} from '../../../../src/products/roadmap/model/Legend.js';
import { NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../../../../src/products/roadmap/theme.js';

function savedLegend() {
  return [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ];
}

function pure(before, input, output) {
  assert.deepEqual(input, before, 'the op mutated the legend it was given');
  assert.notEqual(output, input, 'the op returned the same array instead of a new one');
}

test('an empty tree with no saved legend is born as the genesis seed itself', () => {
  const derived = deriveLegend([], null);

  assert.deepEqual(derived, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ]);
  // Returned BY REFERENCE: the genesis seed is shared byte-for-byte with the backend, never mutate it.
  assert.equal(derived, DEFAULT_KINDS);
  assert.equal(GENESIS_STAMP, '1:0:genesis');
});

test('with no saved legend the legend is exactly the hues in use, in palette order', () => {
  const nodes = [
    { id: 'a', color: 'plum' },
    { id: 'b', color: 'olive' },
    { id: 'c' }, // no colour at all — wears the default hue
    { id: 'd', color: 'plum' },
  ];

  const derived = deriveLegend(nodes, null);

  assert.deepEqual(
    derived.map(({ hue, label, description }) => ({ hue, label, description })),
    [
      { hue: 'terracotta', label: '', description: '' },
      { hue: 'olive', label: '', description: '' },
      { hue: 'plum', label: '', description: '' },
    ],
  );
  assert.equal(new Set(derived.map((kind) => kind.id)).size, 3);
  assert.ok(derived.every((kind) => typeof kind.id === 'string' && kind.id.length > 0));
});

test('a saved legend keeps every kind it has, in its own order, even when no step wears it', () => {
  const saved = savedLegend();
  const before = structuredClone(saved);

  const derived = deriveLegend([{ id: 'a', color: 'terracotta' }], saved);

  assert.deepEqual(derived, before);
  pure(before, saved, derived);
});

test('a saved legend gains an unlabeled kind for every hue in use it is missing', () => {
  const saved = savedLegend();
  const nodes = [{ id: 'a', color: 'plum' }, { id: 'b', color: 'sky' }, { id: 'c', color: 'olive' }];

  const derived = deriveLegend(nodes, saved);

  assert.deepEqual(
    derived.map(({ hue, label, description }) => ({ hue, label, description })),
    [
      { hue: 'terracotta', label: 'Build', description: 'Things you make' },
      { hue: 'olive', label: 'Learn', description: 'Things you figure out' },
      { hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
      { hue: 'sky', label: '', description: '' },
      { hue: 'plum', label: '', description: '' },
    ],
  );
  assert.deepEqual(derived.slice(0, 3), savedLegend());
});

test('a saved kind with a missing label or description reads as empty strings', () => {
  const derived = deriveLegend([], [{ id: 'k', hue: 'sky' }]);

  assert.deepEqual(derived, [{ id: 'k', hue: 'sky', label: '', description: '' }]);
});

test('an empty saved legend is still the saved branch — the seed does not come back', () => {
  assert.deepEqual(deriveLegend([], []), []);

  const derived = deriveLegend([{ id: 'a', color: 'gold' }], []);
  assert.deepEqual(
    derived.map(({ hue, label, description }) => ({ hue, label, description })),
    [{ hue: 'gold', label: '', description: '' }],
  );
});

test('withCounts tallies a colourless node as the default hue and marks unworn kinds zero', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);
  const nodes = [
    { id: 'a', color: 'gold' },
    { id: 'b' },
    { id: 'c', color: 'gold' },
    { id: 'd', color: DEFAULT_NODE_COLOR },
    { id: 'e', color: 'plum' },
  ];

  const counted = withCounts(legend, nodes);

  assert.deepEqual(counted, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make', count: 2 },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out', count: 0 },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter', count: 2 },
  ]);
  pure(before, legend, counted);
});

test('withCounts over no nodes leaves every kind at zero', () => {
  assert.deepEqual(withCounts(savedLegend(), []).map((kind) => kind.count), [0, 0, 0]);
});

test('inUseCount counts only the kinds a step actually wears', () => {
  const legend = savedLegend();

  assert.equal(inUseCount(legend, []), 0);
  assert.equal(inUseCount(legend, [{ id: 'a', color: 'gold' }, { id: 'b', color: 'gold' }]), 1);
  assert.equal(inUseCount(legend, [{ id: 'a', color: 'gold' }, { id: 'b' }]), 2);
  assert.equal(inUseCount(legend, [{ id: 'a', color: 'plum' }]), 0);
});

test('freeHue hands out the palette in order and dries up at six', () => {
  assert.deepEqual(NODE_COLOR_NAMES, ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum']);

  assert.equal(freeHue([]), 'terracotta');
  assert.equal(freeHue(savedLegend()), 'brick');
  assert.equal(freeHue([{ id: 'x', hue: 'plum' }, { id: 'y', hue: 'terracotta' }]), 'olive');
  assert.equal(freeHue(NODE_COLOR_NAMES.map((hue) => ({ id: hue, hue }))), null);
});

test('renameKind truncates at 24 characters and touches only the named kind', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);

  const renamed = renameKind(legend, 'learn', 'A label far past the twenty-four character bound');

  assert.deepEqual(renamed, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'A label far past the twe', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ]);
  assert.equal(renamed[1].label.length, 24);
  pure(before, legend, renamed);
});

test('renameKind keeps a label that fits, and accepts the empty label', () => {
  assert.deepEqual(renameKind(savedLegend(), 'build', 'Ship it')[0].label, 'Ship it');
  assert.deepEqual(renameKind(savedLegend(), 'build', '')[0].label, '');
});

test('renameKind for an id that is not there changes nothing but the array identity', () => {
  const legend = savedLegend();
  const renamed = renameKind(legend, 'ghost', 'Nope');

  assert.deepEqual(renamed, savedLegend());
  pure(structuredClone(legend), legend, renamed);
});

test('describeKind truncates at 80 characters and touches only the named kind', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);
  const long = 'x'.repeat(120);

  const described = describeKind(legend, 'milestone', long);

  assert.deepEqual(described, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'x'.repeat(80) },
  ]);
  pure(before, legend, described);
});

test('addKind appends an unlabeled kind for a free hue', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);

  const added = addKind(legend, 'sky');

  assert.deepEqual(added.slice(0, 3), savedLegend());
  assert.deepEqual(
    { hue: added[3].hue, label: added[3].label, description: added[3].description },
    { hue: 'sky', label: '', description: '' },
  );
  assert.equal(added.length, 4);
  assert.ok(typeof added[3].id === 'string' && added[3].id.length > 0);
  pure(before, legend, added);
});

test('addKind uses the id it is given, so an authoritative AddKind op keeps the server id', () => {
  const added = addKind(savedLegend(), 'brick', 'kind-from-the-server');

  assert.deepEqual(added[3], { id: 'kind-from-the-server', hue: 'brick', label: '', description: '' });
});

test('addKind is a no-op for a hue that is already taken or missing entirely', () => {
  const legend = savedLegend();

  assert.equal(addKind(legend, null), legend);
  assert.equal(addKind(legend, undefined), legend);
  assert.equal(addKind(legend, ''), legend);
  assert.equal(addKind(legend, 'olive'), legend);
  assert.deepEqual(legend, savedLegend());
});

test('removeKind drops exactly the named kind and leaves the input alone', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);

  const removed = removeKind(legend, 'learn');

  assert.deepEqual(removed, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ]);
  pure(before, legend, removed);
});

test('removeKind for an id that is not there yields the same kinds in a new array', () => {
  const legend = savedLegend();
  const removed = removeKind(legend, 'ghost');

  assert.deepEqual(removed, savedLegend());
  pure(structuredClone(legend), legend, removed);
});

test('recolorKind reports the old and new hue so the caller can repaint the steps', () => {
  const legend = savedLegend();
  const before = structuredClone(legend);

  const result = recolorKind(legend, 'learn', 'plum');

  assert.deepEqual(result, {
    legend: [
      { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
      { id: 'learn', hue: 'plum', label: 'Learn', description: 'Things you figure out' },
      { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
    ],
    oldHue: 'olive',
    newHue: 'plum',
  });
  pure(before, legend, result.legend);
});

test('recolorKind refuses a hue another kind already wears, including the kind\'s own', () => {
  const legend = savedLegend();

  assert.deepEqual(recolorKind(legend, 'learn', 'gold'), { legend, oldHue: null, newHue: null });
  assert.equal(recolorKind(legend, 'learn', 'gold').legend, legend);
  assert.deepEqual(recolorKind(legend, 'learn', 'olive'), { legend, oldHue: null, newHue: null });
  assert.deepEqual(legend, savedLegend());
});

test('recolorKind refuses an unknown kind and a missing hue', () => {
  const legend = savedLegend();

  assert.deepEqual(recolorKind(legend, 'ghost', 'plum'), { legend, oldHue: null, newHue: null });
  assert.deepEqual(recolorKind(legend, 'learn', null), { legend, oldHue: null, newHue: null });
  assert.deepEqual(recolorKind(legend, 'learn', ''), { legend, oldHue: null, newHue: null });
  assert.deepEqual(legend, savedLegend());
});
