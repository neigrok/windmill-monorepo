// The paste-import grammar contract (F3 §03): every table row, the messy-input
// variants, and the invariants the rest of the system leans on — deterministic ids
// (the ceremony jitter hashes them), exhaustive dupe renames (SkillTree throws on a
// duplicate id), and a gutter entry for every line (the composer renders them 1:1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, serializePlan } from '../../../src/skilltree/paste/planGrammar.js';
import shipV1 from '../../../src/skilltree/quests/roster/shipV1.js';

const KINDS = [
  { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
  { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
  { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
];

const FLAGSHIP = [
  '# Learn WebGL',
  '## Basics',
  '- [x] Read the spec',
  '- [ ] Draw a triangle',
  '  - Understand shaders',
  '## Projects',
  '1. Particle system',
  '2. Terrain renderer',
  'Just a stray thought',
].join('\n');

test('the flagship document — every rule at once, asserted in full', () => {
  assert.deepStrictEqual(parsePlan(FLAGSHIP, KINDS), {
    title: 'Learn WebGL',
    missingRoot: false,
    nodes: [
      { id: 'learn-webgl', label: 'Learn WebGL', color: 'terracotta', prerequisites: [], icon: 'sparkles' },
      { id: 'basics', label: 'Basics', color: 'terracotta', prerequisites: ['learn-webgl'] },
      { id: 'read-the-spec', label: 'Read the spec', color: 'terracotta', prerequisites: ['basics'], status: 'complete' },
      { id: 'draw-a-triangle', label: 'Draw a triangle', color: 'terracotta', prerequisites: ['basics'] },
      { id: 'understand-shaders', label: 'Understand shaders', color: 'terracotta', prerequisites: ['draw-a-triangle'] },
      { id: 'projects', label: 'Projects', color: 'olive', prerequisites: ['learn-webgl'] },
      { id: 'particle-system', label: 'Particle system', color: 'olive', prerequisites: ['projects'] },
      { id: 'terrain-renderer', label: 'Terrain renderer', color: 'olive', prerequisites: ['particle-system'], description: 'Just a stray thought' },
    ],
    kinds: [
      { id: 'build', hue: 'terracotta', label: 'Basics', description: '', source: 'relabeled' },
      { id: 'learn', hue: 'olive', label: 'Projects', description: '', source: 'relabeled' },
      { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter', source: 'existing' },
    ],
    gutter: [
      { glyph: '◉', nodeId: 'learn-webgl', liberty: null },
      { glyph: '├', nodeId: 'basics', liberty: null },
      { glyph: '✓', nodeId: 'read-the-spec', liberty: null },
      { glyph: '·', nodeId: 'draw-a-triangle', liberty: null },
      { glyph: '·', nodeId: 'understand-shaders', liberty: null },
      { glyph: '├', nodeId: 'projects', liberty: null },
      { glyph: '·', nodeId: 'particle-system', liberty: null },
      { glyph: '·', nodeId: 'terrain-renderer', liberty: null },
      { glyph: '¶', nodeId: 'terrain-renderer', liberty: 'kept as a note' },
    ],
    readout: { steps: 8, branches: 2, done: 1 },
    imperfections: [{ line: 8, type: 'note', detail: 'kept as a note' }],
  });
});

test('a first plain line is the root and the name', () => {
  const parsed = parsePlan('Ship the beta\n- write changelog', KINDS);
  assert.equal(parsed.title, 'Ship the beta');
  assert.equal(parsed.missingRoot, false);
  assert.deepStrictEqual(parsed.nodes[0], { id: 'ship-the-beta', label: 'Ship the beta', color: 'terracotta', prerequisites: [], icon: 'sparkles' });
  assert.deepStrictEqual(parsed.nodes[1].prerequisites, ['ship-the-beta']);
});

test('no heading, straight into a list — missingRoot, still plantable', () => {
  const parsed = parsePlan('- one\n- two', KINDS);
  assert.equal(parsed.missingRoot, true);
  assert.equal(parsed.title, '');
  assert.deepStrictEqual(parsed.nodes[0], { id: 'root', label: '', color: 'terracotta', prerequisites: [], icon: 'sparkles' });
  assert.deepStrictEqual(parsed.nodes.map((n) => n.prerequisites), [[], ['root'], ['root']]);
});

test('a document opening with ## has no name either — the ## is a branch', () => {
  const parsed = parsePlan('## Section\n- a', KINDS);
  assert.equal(parsed.missingRoot, true);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites]), [
    ['root', []],
    ['section', ['root']],
    ['a', ['section']],
  ]);
  assert.equal(parsed.kinds[0].label, 'Section');
});

test('indent is dependency — 2-space, tab, and 4-space documents level identically', () => {
  for (const doc of ['Root\n- a\n  - b', 'Root\n- a\n\t- b', 'Root\n- a\n    - b']) {
    const parsed = parsePlan(doc, KINDS);
    assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites]), [
      ['root', []],
      ['a', ['root']],
      ['b', ['a']],
    ], doc);
    assert.deepStrictEqual(parsed.imperfections, [], doc);
  }
});

test('marker and checkbox variants: * • - 1. 2) [X] [ ]', () => {
  const parsed = parsePlan(
    'Root\n* alpha\n• beta\n- gamma\n1. one\n2) two\n- [X] done thing\n- [ ] open thing',
    KINDS,
  );
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites, n.status ?? null]), [
    ['root', [], null],
    ['alpha', ['root'], null],
    ['beta', ['root'], null],
    ['gamma', ['root'], null],
    ['one', ['root'], null],
    ['two', ['one'], null],
    ['done-thing', ['root'], 'complete'],
    ['open-thing', ['root'], null],
  ]);
  assert.deepStrictEqual(parsed.gutter.map((g) => g.glyph), ['◉', '·', '·', '·', '·', '·', '✓', '·']);
  assert.deepStrictEqual(parsed.readout, { steps: 8, branches: 0, done: 1 });
});

test('numbered lists chain — even across nesting and blank lines', () => {
  const parsed = parsePlan('Root\n1. a\n  1. a1\n  2. a2\n\n2. b', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites]), [
    ['root', []],
    ['a', ['root']],
    ['a1', ['a']],
    ['a2', ['a1']],
    ['b', ['a']],
  ]);
});

test('a bullet breaks a numbered run — the next number starts a fresh chain', () => {
  const parsed = parsePlan('Root\n1. a\n- x\n2. b', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites]), [
    ['root', []],
    ['a', ['root']],
    ['x', ['root']],
    ['b', ['root']],
  ]);
});

test('a heading matching an existing kind binds case-insensitively — no relabel', () => {
  const parsed = parsePlan('Plan\n## build\n- thing\n## MILESTONE\n- moment', KINDS);
  assert.deepStrictEqual(parsed.kinds, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make', source: 'existing' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out', source: 'existing' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter', source: 'existing' },
  ]);
  assert.equal(parsed.nodes.find((n) => n.id === 'thing').color, 'terracotta');
  assert.equal(parsed.nodes.find((n) => n.id === 'moment').color, 'gold');
});

test('seven branches: three takeovers, three minted hues, then a deterministic cycle', () => {
  const doc = ['Root', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `## B${n}\n- s${n}`)].join('\n');
  const parsed = parsePlan(doc, KINDS);
  assert.deepStrictEqual(parsed.kinds, [
    { id: 'build', hue: 'terracotta', label: 'B1', description: '', source: 'relabeled' },
    { id: 'learn', hue: 'olive', label: 'B2', description: '', source: 'relabeled' },
    { id: 'milestone', hue: 'gold', label: 'B3', description: '', source: 'relabeled' },
    { id: 'b4', hue: 'brick', label: 'B4', description: '', source: 'added' },
    { id: 'b5', hue: 'sky', label: 'B5', description: '', source: 'added' },
    { id: 'b6', hue: 'plum', label: 'B6', description: '', source: 'added' },
  ]);
  assert.equal(parsed.nodes.find((n) => n.id === 'b7').color, 'terracotta');
  assert.equal(parsed.readout.branches, 7);
});

test('prose becomes notes on the nearest step, bare URLs become links', () => {
  const parsed = parsePlan('Root\n- step\nhalf a sentence\nhttps://example.com/docs\nanother aside', KINDS);
  const step = parsed.nodes[1];
  assert.equal(step.description, 'half a sentence\nanother aside');
  assert.deepStrictEqual(step.links, ['https://example.com/docs']);
  assert.deepStrictEqual(parsed.gutter.map((g) => g.glyph), ['◉', '·', '¶', '¶', '¶']);
  assert.deepStrictEqual(parsed.imperfections.map((i) => i.type), ['note', 'note', 'note']);
});

test('only the root wears the birth icon — steps and branches arrive bare', () => {
  for (const doc of ['# Named\n- a\n## B\n- b', '- headless\n- list']) {
    const parsed = parsePlan(doc, KINDS);
    assert.deepStrictEqual(parsed.nodes.map((n) => n.icon ?? null), ['sparkles', ...parsed.nodes.slice(1).map(() => null)], doc);
  }
});

test('mixed indent mid-document flattens visibly — a clamped liberty, never silent', () => {
  const parsed = parsePlan('Root\n- a\n    - b\n  - c', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.prerequisites]), [
    ['root', []],
    ['a', ['root']],
    ['b', ['a']],
    ['c', ['root']],
  ]);
  assert.equal(parsed.gutter[3].liberty, 'mixed indent clamped');
  assert.deepStrictEqual(parsed.imperfections, [{ line: 3, type: 'clamp', detail: 'mixed indent clamped' }]);
});

test('a weird indent jump clamps to the nearest real ancestor, visibly', () => {
  const parsed = parsePlan('Root\n- a\n  - b\n        - deep', KINDS);
  assert.deepStrictEqual(parsed.nodes.find((n) => n.id === 'deep').prerequisites, ['b']);
  assert.equal(parsed.gutter[3].liberty, 'indent clamped');
  assert.deepStrictEqual(parsed.imperfections, [{ line: 3, type: 'clamp', detail: 'indent clamped' }]);
});

test('duplicate names get " (2)" exhaustively — never a duplicate id', () => {
  const parsed = parsePlan('Plan\n- Foo\n- Foo\n- Foo (2)\n- Foo', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.label]), [
    ['plan', 'Plan'],
    ['foo', 'Foo'],
    ['foo-2', 'Foo (2)'],
    ['foo-2-2', 'Foo (2) (2)'],
    ['foo-3', 'Foo (3)'],
  ]);
  assert.equal(parsed.gutter[2].liberty, 'renamed to "Foo (2)"');
  assert.deepStrictEqual(parsed.imperfections.map((i) => i.type), ['rename', 'rename', 'rename']);
});

test('distinct labels that slug alike still get distinct ids', () => {
  const parsed = parsePlan('Plan\n- Foo!\n- Foo?', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.label]), [
    ['plan', 'Plan'],
    ['foo', 'Foo!'],
    ['foo-2', 'Foo?'],
  ]);
  assert.deepStrictEqual(parsed.imperfections, []);
});

test('the all-notes worst case: one root and a pile of ¶, still plantable', () => {
  const parsed = parsePlan('This is just prose.\nMore prose here.\nEven more prose.', KINDS);
  assert.deepStrictEqual(parsed.nodes, [{
    id: 'this-is-just-prose',
    label: 'This is just prose.',
    color: 'terracotta',
    prerequisites: [],
    icon: 'sparkles',
    description: 'More prose here.\nEven more prose.',
  }]);
  assert.deepStrictEqual(parsed.readout, { steps: 1, branches: 0, done: 0 });
  assert.deepStrictEqual(parsed.gutter.map((g) => g.glyph), ['◉', '¶', '¶']);
});

test('empty text — the full worst-case shape', () => {
  assert.deepStrictEqual(parsePlan('', KINDS), {
    title: '',
    missingRoot: true,
    nodes: [{ id: 'root', label: '', color: 'terracotta', prerequisites: [], icon: 'sparkles' }],
    kinds: [
      { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make', source: 'existing' },
      { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out', source: 'existing' },
      { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter', source: 'existing' },
    ],
    gutter: [{ glyph: null, nodeId: null, liberty: null }],
    readout: { steps: 1, branches: 0, done: 0 },
    imperfections: [],
  });
});

test('no kinds at all — every branch mints from the palette', () => {
  const parsed = parsePlan('Root\n## One\n- a\n## Two\n- b', []);
  assert.deepStrictEqual(parsed.kinds, [
    { id: 'one', hue: 'terracotta', label: 'One', description: '', source: 'added' },
    { id: 'two', hue: 'olive', label: 'Two', description: '', source: 'added' },
  ]);
});

test('the root label clips at 200 characters', () => {
  const parsed = parsePlan(`${'x'.repeat(250)}\n- a`, KINDS);
  assert.equal(parsed.title, 'x'.repeat(200));
  assert.equal(parsed.nodes[0].label, 'x'.repeat(200));
  assert.equal(parsed.nodes[0].id, 'x'.repeat(40));
});

test('CRLF and LF documents parse identically', () => {
  assert.deepStrictEqual(parsePlan(FLAGSHIP.replaceAll('\n', '\r\n'), KINDS), parsePlan(FLAGSHIP, KINDS));
});

test('determinism: parsing twice is deep-equal, and the input kinds are untouched', () => {
  const kinds = structuredClone(KINDS);
  assert.deepStrictEqual(parsePlan(FLAGSHIP, kinds), parsePlan(FLAGSHIP, kinds));
  assert.deepStrictEqual(kinds, KINDS);
});

test('gutter-line bijection: exactly one entry per input line', () => {
  for (const doc of ['', FLAGSHIP, 'a\n\n\nb', '- x\r\n- y\r\n', 'one line']) {
    const parsed = parsePlan(doc, KINDS);
    assert.equal(parsed.gutter.length, doc.split(/\r\n|\r|\n/).length, JSON.stringify(doc));
  }
});

test('serializePlan round-trips a parsePlan document — nodes and kinds land identically', () => {
  const parsed = parsePlan(FLAGSHIP, KINDS);
  const markdown = serializePlan({ title: parsed.title, nodes: parsed.nodes }, parsed.kinds, null);

  assert.equal(markdown, [
    '# Learn WebGL',
    '## Basics',
    '- [x] Read the spec',
    '- Draw a triangle',
    '  - Understand shaders',
    '## Projects',
    '- Particle system',
    '  - Terrain renderer',
    '    Just a stray thought',
  ].join('\n'));

  const reparsed = parsePlan(markdown, KINDS);
  assert.deepStrictEqual(reparsed.nodes, parsed.nodes);
  assert.deepStrictEqual(reparsed.kinds, parsed.kinds);
});

test('serializePlan completion source: a live progress overlay wins over the document seed', () => {
  const parsed = parsePlan(FLAGSHIP, KINDS); // seed marks "Read the spec" complete
  const treeData = { title: parsed.title, nodes: parsed.nodes };

  const seeded = serializePlan(treeData, parsed.kinds, null);
  assert.match(seeded, /- \[x\] Read the spec/);
  assert.match(seeded, /^- Draw a triangle$/m);

  const overlaid = serializePlan(treeData, parsed.kinds, new Set(['draw-a-triangle']));
  assert.match(overlaid, /^- Read the spec$/m);
  assert.match(overlaid, /- \[x\] Draw a triangle/);

  // The Progress `{ completed }` shape resolves the same as a bare Set.
  const asProgress = serializePlan(treeData, parsed.kinds, { completed: new Set(['draw-a-triangle']) });
  assert.equal(asProgress, overlaid);
});

test('serializePlan is best-effort on a multi-parent DAG — primary parent indents, the rest become notes', () => {
  const markdown = serializePlan(shipV1, shipV1.kinds, null);
  const back = parsePlan(markdown, shipV1.kinds);
  const find = (label) => back.nodes.find((node) => node.label === label);

  // Colours are grouped under `## <kind label>` headings.
  assert.ok(markdown.includes('## Polish'), markdown);
  assert.ok(markdown.includes('## Launch'), markdown);
  assert.equal(find('Dogfood it for a week').color, 'sky');
  assert.equal(find('Run a friendly beta').color, 'gold');

  // prerequisites[0] survives as the indent parent, even across a two-parent node.
  assert.deepStrictEqual(find('Build the walking skeleton').prerequisites, [find('Pick a boring stack and deploy it').id]);
  assert.deepStrictEqual(find('Launch it where your people are').prerequisites, [find('Run a friendly beta').id]);
  assert.deepStrictEqual(find('Ship the first fix release').prerequisites, [find('Launch it where your people are').id]);

  // Extra prerequisites are preserved as a `needs also` note reparsed into the description.
  assert.match(find('Build the walking skeleton').description, /needs also: Sketch the core flow on paper/);
  assert.match(find('Launch it where your people are').description, /needs also: Make the landing page, Wire up analytics and feedback/);
  assert.match(find('Run a friendly beta').description, /needs also: Smooth the first-run experience, Handle failure gracefully/);

  // A cross-kind primary parent can't be indented under (wrong section), so it too rides as a note.
  assert.match(find('Dogfood it for a week').description, /needs also: Make the core feature real/);
  assert.match(find('Wire up analytics and feedback').description, /needs also: Make the core feature real/);
});

test('serializePlan emits the url string from { url, label } link objects, never [object Object]', () => {
  // The live app carries node.links as { url, label } objects (lattice + TreeJson), not the
  // bare strings parsePlan produces. Export must emit the url, or every link in the archive
  // becomes the literal "[object Object]".
  const tree = {
    title: 'Reading list',
    nodes: [
      { id: 'root', label: 'Learn rendering', color: 'terracotta', prerequisites: [],
        links: [{ url: 'https://webgl.org/spec', label: 'the spec' }] },
      { id: 'child', label: 'Draw a triangle', color: 'terracotta', prerequisites: ['root'],
        links: [{ url: 'https://example.com/tri', label: 'tutorial' }, 'https://bare.example/x'] },
    ],
  };
  const kinds = [{ id: 'build', hue: 'terracotta', label: 'Build', description: '' }];
  const markdown = serializePlan(tree, kinds, null);

  assert.ok(!markdown.includes('[object Object]'), markdown);
  assert.ok(markdown.includes('https://webgl.org/spec'), markdown);
  assert.ok(markdown.includes('https://example.com/tri'), markdown);
  assert.ok(markdown.includes('https://bare.example/x'), markdown);

  // and the bare urls round-trip back into link entries
  const back = parsePlan(markdown, kinds);
  const child = back.nodes.find((node) => node.label === 'Draw a triangle');
  assert.deepStrictEqual(child.links, ['https://example.com/tri', 'https://bare.example/x']);
});

test('every prerequisite references an emitted id, single-parented', () => {
  const gnarly = [
    '# Big Plan',
    'intro prose',
    '## Alpha',
    '- [x] a',
    '   - a1',
    '1. c1',
    '2. c2',
    '## Beta',
    '\t- b1',
    '\t\t\t\t- b2',
    'https://example.com',
    '- [X] b3',
  ].join('\n');
  const parsed = parsePlan(gnarly, KINDS);
  const ids = new Set(parsed.nodes.map((n) => n.id));
  assert.equal(ids.size, parsed.nodes.length);
  parsed.nodes.forEach((node, index) => {
    if (index === 0) {
      assert.deepStrictEqual(node.prerequisites, []);
      return;
    }
    assert.equal(node.prerequisites.length, 1, node.id);
    assert.ok(ids.has(node.prerequisites[0]), `${node.id} → ${node.prerequisites[0]}`);
  });
});
