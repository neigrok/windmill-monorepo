import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { buildOutline } from '../../../../src/products/roadmap/list/outline.js';
import { filterOutline } from '../../../../src/products/roadmap/list/explore.js';

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
