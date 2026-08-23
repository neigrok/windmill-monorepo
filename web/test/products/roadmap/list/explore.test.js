import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { buildOutline } from '../../../../src/products/roadmap/list/outline.js';
import { filterOutline, kindOptions, gateOf } from '../../../../src/products/roadmap/list/explore.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

function byId(t) {
  return t.nodesById;
}

test('filterOutline — a query hits titles and descriptions alike; a description-only hit carries the fragment', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Safety' }),
    node('a1', ['a'], { label: 'Harness', description: 'Wear the safety line on the roof' }),
    node('a2', ['a'], { label: 'Ladder', description: 'Three points of contact' }),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), { query: 'safety' }), {
    root: null,
    sections: [
      {
        head: 'a',
        headMatches: true,
        headSnippet: null,
        rows: [{ id: 'a1', depth: 2, snippet: 'Wear the safety line on the roof' }],
        hidden: 1,
      },
    ],
    matches: 2,
  });
});

test('filterOutline — the snippet keeps ±40 characters around the hit and ellipses what it cut', () => {
  const long = `${'x'.repeat(60)}needle${'y'.repeat(60)}`;
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Head' }),
    node('a1', ['a'], { label: 'Step', description: long }),
  ]);

  const { sections } = filterOutline(buildOutline(t), byId(t), { query: 'needle' });
  assert.deepEqual(sections[0].rows, [{
    id: 'a1',
    depth: 2,
    snippet: `…${'x'.repeat(40)}needle${'y'.repeat(40)}…`,
  }]);
});

// The index must come off the ORIGINAL string: lowercasing 'İ' yields two code units.
test('filterOutline — a description whose case folding changes length still frames its own hit', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Head' }),
    node('a1', ['a'], { label: 'Step', description: `${'İ'.repeat(30)} the needle sits here` }),
  ]);

  const { sections } = filterOutline(buildOutline(t), byId(t), { query: 'needle' });
  assert.equal(sections[0].rows[0].snippet.includes('needle'), true);
});

test('filterOutline — a head that misses still renders (dimmed by the view) when a row hits', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Roofing' }),
    node('a1', ['a'], { label: 'Flashing' }),
    node('a2', ['a'], { label: 'Gutters' }),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), { query: 'gut' }), {
    root: null,
    sections: [
      { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a2', depth: 2, snippet: null }], hidden: 1 },
    ],
    matches: 1,
  });
});

test('filterOutline — a section with no hit at all drops out entirely', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Roofing' }),
    node('a1', ['a'], { label: 'Flashing' }),
    node('b', ['r'], { order: 'b', label: 'Wiring' }),
    node('b1', ['b'], { label: 'Sockets' }),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), { query: 'wir' }), {
    root: null,
    sections: [
      { head: 'b', headMatches: true, headSnippet: null, rows: [], hidden: 1 },
    ],
    matches: 1,
  });
});

test('filterOutline — the root is matched by its own name, and by its description alone', () => {
  const t = tree([
    node('r', [], { label: 'Cold baseline', description: 'Where the whole tree starts' }),
    node('a', ['r'], { order: 'a', label: 'Roofing' }),
  ]);
  const outline = buildOutline(t);

  assert.deepEqual(filterOutline(outline, byId(t), { query: 'baseline' }), {
    root: { id: 'r', snippet: null },
    sections: [],
    matches: 1,
  });
  assert.deepEqual(filterOutline(outline, byId(t), { query: 'whole tree' }), {
    root: { id: 'r', snippet: 'Where the whole tree starts' },
    sections: [],
    matches: 1,
  });
});

test('filterOutline — the lens excludes the root like any other step', () => {
  const t = tree([
    node('r', [], { label: 'Cold baseline', color: 'olive' }),
    node('a', ['r'], { order: 'a', label: 'Roofing', color: 'sky' }),
  ]);
  const outline = buildOutline(t);

  assert.deepEqual(filterOutline(outline, byId(t), { kind: 'olive' }), {
    root: { id: 'r', snippet: null },
    sections: [],
    matches: 1,
  });
  assert.deepEqual(filterOutline(outline, byId(t), { kind: 'sky' }), {
    root: null,
    sections: [{ head: 'a', headMatches: true, headSnippet: null, rows: [], hidden: 0 }],
    matches: 1,
  });
});

test('filterOutline — a revealed head shows its branch in full, hidden falls to zero, and only the hits keep snippets', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Roofing' }),
    node('a1', ['a'], { label: 'Flashing', description: 'Bend the gutter apron' }),
    node('a2', ['a'], { label: 'Tiles' }),
  ]);
  const outline = buildOutline(t);

  assert.deepEqual(filterOutline(outline, byId(t), { query: 'gutter' }), {
    root: null,
    sections: [
      { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a1', depth: 2, snippet: 'Bend the gutter apron' }], hidden: 1 },
    ],
    matches: 1,
  });
  assert.deepEqual(filterOutline(outline, byId(t), { query: 'gutter', revealed: new Set(['a']) }), {
    root: null,
    sections: [
      {
        head: 'a',
        headMatches: false,
        headSnippet: null,
        rows: [{ id: 'a1', depth: 2, snippet: 'Bend the gutter apron' }, { id: 'a2', depth: 2, snippet: null }],
        hidden: 0,
      },
    ],
    matches: 1,
  });
});

test('filterOutline — rows keep their true depth, because depth is the information', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Head' }),
    node('a1', ['a'], { label: 'Middle' }),
    node('a2', ['a1'], { label: 'Deep target' }),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), { query: 'target' }).sections, [
    { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a2', depth: 3, snippet: null }], hidden: 1 },
  ]);
});

test('filterOutline — the lens and the query compose as AND', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', label: 'Head', color: 'olive' }),
    node('a1', ['a'], { label: 'Paint the shed', color: 'olive' }),
    node('a2', ['a'], { label: 'Paint the fence', color: 'sky' }),
  ]);
  const outline = buildOutline(t);

  assert.deepEqual(filterOutline(outline, byId(t), { query: 'paint' }).sections, [
    { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a1', depth: 2, snippet: null }, { id: 'a2', depth: 2, snippet: null }], hidden: 0 },
  ]);
  assert.deepEqual(filterOutline(outline, byId(t), { query: 'paint', kind: 'sky' }).sections, [
    { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a2', depth: 2, snippet: null }], hidden: 1 },
  ]);
  assert.deepEqual(filterOutline(outline, byId(t), { query: 'paint', kind: 'gold' }), { root: null, sections: [], matches: 0 });
});

test('filterOutline — the lens alone keeps every step of its kind, and an unpainted step wears the default', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a', color: 'olive' }),
    node('a1', ['a']),
    node('a2', ['a'], { color: 'olive' }),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), { kind: 'terracotta' }), {
    root: { id: 'r', snippet: null },
    sections: [
      { head: 'a', headMatches: false, headSnippet: null, rows: [{ id: 'a1', depth: 2, snippet: null }], hidden: 1 },
    ],
    matches: 2,
  });
});

test('filterOutline — an empty ask keeps the whole outline, with nothing hidden and no snippets', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('a1', ['a']),
  ]);

  assert.deepEqual(filterOutline(buildOutline(t), byId(t), {}), {
    root: { id: 'r', snippet: null },
    sections: [
      { head: 'a', headMatches: true, headSnippet: null, rows: [{ id: 'a1', depth: 2, snippet: null }], hidden: 0 },
    ],
    matches: 3,
  });
});

test('kindOptions — legend order first, in-tree hues only, strays appended in palette order', () => {
  const t = tree([
    node('r', [], { color: 'gold' }),
    node('a', ['r'], { color: 'sky' }),
    node('b', ['r'], { color: 'plum' }),
  ]);
  const legend = [
    { id: 'k1', hue: 'sky', label: 'Sky work' },
    { id: 'k2', hue: 'olive', label: 'Unworn' },
    { id: 'k3', hue: 'gold', label: '' },
  ];

  assert.deepEqual(kindOptions(t, legend), [
    { id: 'k1', hue: 'sky', label: 'Sky work' },
    { id: 'k3', hue: 'gold', label: 'Gold' },
    { id: 'plum', hue: 'plum', label: 'Plum' },
  ]);
});

test('kindOptions — a duplicated hue in the legend is offered once, under the first kind that named it', () => {
  const t = tree([node('r', [], { color: 'sky' }), node('a', ['r'], { color: 'olive' })]);
  const legend = [
    { id: 'k1', hue: 'sky', label: 'Sky' },
    { id: 'k2', hue: 'sky', label: 'Sky again' },
    { id: 'k3', hue: 'olive', label: 'Olive' },
  ];

  assert.deepEqual(kindOptions(t, legend), [
    { id: 'k1', hue: 'sky', label: 'Sky' },
    { id: 'k3', hue: 'olive', label: 'Olive' },
  ]);
});

test('kindOptions — a tree of one kind gets no row at all (a filter that returns everything is theatre)', () => {
  const one = tree([node('r', [], { color: 'sky' }), node('a', ['r'], { color: 'sky' })]);
  assert.deepEqual(kindOptions(one, [{ id: 'k1', hue: 'sky', label: 'Sky' }, { id: 'k2', hue: 'olive', label: 'Olive' }]), []);
  assert.deepEqual(kindOptions(tree([node('r', [])]), []), []);
});

test('kindOptions — with no legend at all the worn hues stand in palette order under their own names', () => {
  const t = tree([node('r', [], { color: 'plum' }), node('a', ['r'], { color: 'olive' })]);

  assert.deepEqual(kindOptions(t), [
    { id: 'olive', hue: 'olive', label: 'Olive' },
    { id: 'plum', hue: 'plum', label: 'Plum' },
  ]);
});

test('gateOf — the frontier is what can be started today, the count is the whole owed set', () => {
  const t = tree([
    node('r', []),
    node('base', ['r']),
    node('erasure', ['r']),
    node('mid', ['base']),
    node('target', ['mid', 'erasure']),
  ]);
  const states = new Map([
    ['r', 'complete'],
    ['base', 'available'], ['erasure', 'available'],
    ['mid', 'locked'], ['target', 'locked'],
  ]);

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 3,
    frontier: [t.nodesById.get('base'), t.nodesById.get('erasure')],
    longestChain: 2,
    line: null,
    clipped: false,
  });
});

test('gateOf — the frontier ranks by what each step would unlock, ties by id', () => {
  const t = tree([
    node('r', []),
    node('quiet', ['r']),
    node('loud', ['r']),
    node('x', ['loud']),
    node('y', ['loud']),
    node('target', ['quiet', 'loud']),
  ]);
  const states = new Map([
    ['r', 'complete'], ['quiet', 'available'], ['loud', 'available'],
    ['x', 'locked'], ['y', 'locked'], ['target', 'locked'],
  ]);

  assert.deepEqual(gateOf(t, states, 'target').frontier, [t.nodesById.get('loud'), t.nodesById.get('quiet')]);
});

test('gateOf — a complete prerequisite is a wall the walk stops at', () => {
  const t = tree([
    node('r', []),
    node('done', ['r']),
    node('behind', ['done']),
    node('target', ['behind']),
  ]);
  const states = new Map([
    ['r', 'complete'], ['done', 'complete'],
    ['behind', 'available'], ['target', 'locked'],
  ]);

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 1,
    frontier: [t.nodesById.get('behind')],
    longestChain: 1,
    line: [t.nodesById.get('behind'), t.nodesById.get('target')],
    clipped: false,
  });
});

test('gateOf — a gate that really is a line renders as one, root-most first with the step last', () => {
  const t = tree([
    node('r', []),
    node('one', ['r']),
    node('two', ['one']),
    node('three', ['two']),
    node('target', ['three']),
  ]);
  const states = new Map([
    ['r', 'complete'], ['one', 'available'],
    ['two', 'locked'], ['three', 'locked'], ['target', 'locked'],
  ]);

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 3,
    frontier: [t.nodesById.get('one')],
    longestChain: 3,
    line: ['one', 'two', 'three', 'target'].map((id) => t.nodesById.get(id)),
    clipped: false,
  });
});

test('gateOf — one branching hop anywhere in the gate refuses the line', () => {
  const t = tree([
    node('r', []),
    node('one', ['r']),
    node('other', ['r']),
    node('two', ['one', 'other']),
    node('target', ['two']),
  ]);
  const states = new Map([
    ['r', 'complete'], ['one', 'available'], ['other', 'available'],
    ['two', 'locked'], ['target', 'locked'],
  ]);

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 3,
    frontier: [t.nodesById.get('one'), t.nodesById.get('other')],
    longestChain: 2,
    line: null,
    clipped: false,
  });
});

test('gateOf — one prerequisite listed twice still gates once, and the gate stays a line', () => {
  const t = tree([
    node('r', []),
    node('one', ['r']),
    node('target', ['one', 'one']),
  ]);
  const states = new Map([['r', 'complete'], ['one', 'available'], ['target', 'locked']]);

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 1,
    frontier: [t.nodesById.get('one')],
    longestChain: 1,
    line: [t.nodesById.get('one'), t.nodesById.get('target')],
    clipped: false,
  });
});

test('gateOf — the line caps at six, keeping the near hops, and says so with clipped', () => {
  const chain = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
  const t = tree([
    node('r', []),
    ...chain.map((id, index) => node(id, [index === 0 ? 'r' : chain[index - 1]])),
    node('target', ['h8']),
  ]);
  const states = new Map([['r', 'complete'], ['h1', 'available'], ['target', 'locked']]);
  for (const id of chain.slice(1)) states.set(id, 'locked');

  assert.deepEqual(gateOf(t, states, 'target'), {
    blockedBy: 8,
    frontier: [t.nodesById.get('h1')],
    longestChain: 8,
    line: ['h4', 'h5', 'h6', 'h7', 'h8', 'target'].map((id) => t.nodesById.get(id)),
    clipped: true,
  });
});

test('gateOf — a line that exactly fills the cap is not clipped', () => {
  const chain = ['h1', 'h2', 'h3', 'h4', 'h5'];
  const t = tree([
    node('r', []),
    ...chain.map((id, index) => node(id, [index === 0 ? 'r' : chain[index - 1]])),
    node('target', ['h5']),
  ]);
  const states = new Map([['r', 'complete'], ['h1', 'available'], ['target', 'locked']]);
  for (const id of chain.slice(1)) states.set(id, 'locked');

  const gate = gateOf(t, states, 'target');
  assert.deepEqual(gate.line, [...chain, 'target'].map((id) => t.nodesById.get(id)));
  assert.equal(gate.clipped, false);
});

test('gateOf — an unblocked step owes nothing, and an unknown id answers the same', () => {
  const t = tree([node('r', []), node('a', ['r'])]);
  const states = new Map([['r', 'complete'], ['a', 'available']]);

  assert.deepEqual(gateOf(t, states, 'a'), { blockedBy: 0, frontier: [], longestChain: 0, line: null, clipped: false });
  assert.deepEqual(gateOf(t, states, 'gone'), { blockedBy: 0, frontier: [], longestChain: 0, line: null, clipped: false });
});

test('gateOf — a cycle terminates instead of hanging the phone', () => {
  const nodes = [
    { id: 'a', label: 'A', prerequisites: ['b'] },
    { id: 'b', label: 'B', prerequisites: ['a'] },
    { id: 'target', label: 'Target', prerequisites: ['a'] },
  ];
  const nodesById = new Map(nodes.map((entry) => [entry.id, entry]));
  const cyclic = {
    nodesById,
    parentsOf: (id) => nodesById.get(id).prerequisites.map((prereqId) => nodesById.get(prereqId)),
    childrenOf: (id) => nodes.filter((entry) => entry.prerequisites.includes(id)),
  };
  const states = new Map([['a', 'locked'], ['b', 'locked'], ['target', 'locked']]);

  assert.deepEqual(gateOf(cyclic, states, 'target'), {
    blockedBy: 2,
    frontier: [],
    longestChain: 0,
    line: null,
    clipped: false,
  });
});
