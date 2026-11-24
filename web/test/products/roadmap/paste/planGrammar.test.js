import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, serializePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';
import { dogfoodTreeData } from '../fixtures/dogfoodTree.js';
import { largeRoadmap, ROADMAP_SHAPES } from '../fixtures/largeRoadmap.js';
import { ROSTER } from '../../../../src/products/roadmap/quests/roster.js';

const shipV1 = ROSTER.find((quest) => quest.id === 'ship-v1');

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
      { mark: 'root', nodeId: 'learn-webgl', liberties: [] },
      { mark: 'branch', nodeId: 'basics', liberties: [] },
      { mark: 'done', nodeId: 'read-the-spec', liberties: [] },
      { mark: 'step', nodeId: 'draw-a-triangle', liberties: [] },
      { mark: 'step', nodeId: 'understand-shaders', liberties: [] },
      { mark: 'branch', nodeId: 'projects', liberties: [] },
      { mark: 'step', nodeId: 'particle-system', liberties: [] },
      { mark: 'step', nodeId: 'terrain-renderer', liberties: [] },
      { mark: 'note', nodeId: 'terrain-renderer', liberties: [{ type: 'note' }] },
    ],
    readout: { steps: 8, branches: 2, done: 1 },
    imperfections: { notes: 1, clamps: 0, renames: 0, clips: 0 },
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
    assert.deepStrictEqual(parsed.imperfections, { notes: 0, clamps: 0, renames: 0, clips: 0 }, doc);
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
  assert.deepStrictEqual(parsed.gutter.map((g) => g.mark), ['root', 'step', 'step', 'step', 'step', 'step', 'done', 'step']);
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

test('bindOnly (append): an unmatched heading mints a fresh hue, never relabeling an existing kind', () => {
  const birth = parsePlan('Plan\n## Deploy\n- ship', KINDS);
  assert.equal(birth.kinds[0].label, 'Deploy');
  assert.equal(birth.kinds[0].source, 'relabeled');

  const append = parsePlan('Plan\n## Deploy\n- ship', KINDS, { bindOnly: true });
  assert.deepStrictEqual(append.kinds, [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make', source: 'existing' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out', source: 'existing' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter', source: 'existing' },
    { id: 'deploy', hue: 'brick', label: 'Deploy', description: '', source: 'added' },
  ]);
  assert.equal(append.nodes.find((n) => n.id === 'ship').color, 'brick');
});

test('bindOnly still binds a heading that matches an existing kind, case-insensitively', () => {
  const append = parsePlan('Plan\n## build\n- thing\n## MILESTONE\n- moment', KINDS, { bindOnly: true });
  assert.equal(append.nodes.find((n) => n.id === 'thing').color, 'terracotta');
  assert.equal(append.nodes.find((n) => n.id === 'moment').color, 'gold');
  assert.deepStrictEqual(append.kinds.map((k) => k.source), ['existing', 'existing', 'existing']);
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
  assert.deepStrictEqual(parsed.gutter.map((g) => [g.mark, g.liberties]), [['root', []], ['step', []], ['note', [{ type: 'note' }]], ['note', [{ type: 'note' }]], ['note', [{ type: 'note' }]]]);
  assert.deepStrictEqual(parsed.imperfections, { notes: 3, clamps: 0, renames: 0, clips: 0 });
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
  assert.deepStrictEqual(parsed.gutter.map((g) => g.liberties), [[], [], [], [{ type: 'clamp', indent: 'ragged' }]]);
  assert.deepStrictEqual(parsed.imperfections, { notes: 0, clamps: 1, renames: 0, clips: 0 });
});

test('a weird indent jump clamps to the nearest real ancestor, visibly', () => {
  const parsed = parsePlan('Root\n- a\n  - b\n        - deep', KINDS);
  assert.deepStrictEqual(parsed.nodes.find((n) => n.id === 'deep').prerequisites, ['b']);
  assert.deepStrictEqual(parsed.gutter.map((g) => g.liberties), [[], [], [], [{ type: 'clamp', indent: 'jump' }]]);
  assert.deepStrictEqual(parsed.imperfections, { notes: 0, clamps: 1, renames: 0, clips: 0 });
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
  assert.deepStrictEqual(parsed.gutter.map((g) => g.liberties), [[], [], [{ type: 'rename', label: 'Foo (2)' }], [{ type: 'rename', label: 'Foo (2) (2)' }], [{ type: 'rename', label: 'Foo (3)' }]]);
  assert.deepStrictEqual(parsed.imperfections, { notes: 0, clamps: 0, renames: 3, clips: 0 });
});

test('distinct labels that slug alike still get distinct ids', () => {
  const parsed = parsePlan('Plan\n- Foo!\n- Foo?', KINDS);
  assert.deepStrictEqual(parsed.nodes.map((n) => [n.id, n.label]), [
    ['plan', 'Plan'],
    ['foo', 'Foo!'],
    ['foo-2', 'Foo?'],
  ]);
  assert.deepStrictEqual(parsed.imperfections, { notes: 0, clamps: 0, renames: 0, clips: 0 });
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
  assert.deepStrictEqual(parsed.gutter.map((g) => g.mark), ['root', 'note', 'note']);
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
    gutter: [{ mark: null, nodeId: null, liberties: [] }],
    readout: { steps: 1, branches: 0, done: 0 },
    imperfections: { notes: 0, clamps: 0, renames: 0, clips: 0 },
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
    '<!-- windmill:roadmap 2 -->',
    '- Learn WebGL <!-- windmill:kind terracotta Basics -->',
    '  - Basics',
    '    - [x] Read the spec',
    '    - Draw a triangle',
    '      - Understand shaders',
    '  - Projects <!-- windmill:kind olive Projects -->',
    '    - Particle system',
    '      - Terrain renderer',
    '        > Just a stray thought',
  ].join('\n'));

  const reparsed = parsePlan(markdown, KINDS);
  assert.deepStrictEqual(reparsed.nodes, parsed.nodes);
  assert.deepStrictEqual(reparsed.kinds, parsed.kinds);
});

test('serializePlan completion source: a live progress overlay wins over the document seed', () => {
  const parsed = parsePlan(FLAGSHIP, KINDS); // seed marks "Read the spec" complete
  const treeData = { title: parsed.title, nodes: parsed.nodes };

  const seeded = serializePlan(treeData, parsed.kinds, null);
  assert.deepEqual(parsePlan(seeded, KINDS).nodes, parsed.nodes);

  const overlaid = serializePlan(treeData, parsed.kinds, new Set(['draw-a-triangle']));
  assert.deepEqual(parsePlan(overlaid, KINDS).nodes, parsed.nodes.map(({ status, ...node }) => (node.id === 'draw-a-triangle' ? { ...node, status: 'complete' } : node)));

  // The Progress `{ completed }` shape resolves the same as a bare Set.
  const asProgress = serializePlan(treeData, parsed.kinds, { completed: new Set(['draw-a-triangle']) });
  assert.equal(asProgress, overlaid);
});

test('serializePlan is best-effort on a multi-parent DAG — primary parent indents, the rest become notes', () => {
  const markdown = serializePlan(shipV1, shipV1.kinds, null);
  const back = parsePlan(markdown, shipV1.kinds);
  const find = (label) => back.nodes.find((node) => node.label === label);

  assert.ok(markdown.includes('<!-- windmill:kind sky Polish -->'), markdown);
  assert.ok(markdown.includes('<!-- windmill:kind gold Launch -->'), markdown);
  assert.equal(find('Dogfood it for a week').color, 'sky');
  assert.equal(find('Run a friendly beta').color, 'gold');

  assert.deepStrictEqual(find('Build the walking skeleton').prerequisites, [find('Pick a boring stack and deploy it').id]);
  assert.deepStrictEqual(find('Launch it where your people are').prerequisites, [find('Run a friendly beta').id]);
  assert.deepStrictEqual(find('Ship the first fix release').prerequisites, [find('Launch it where your people are').id]);

  assert.match(find('Build the walking skeleton').description, /needs also: Sketch the core flow on paper/);
  assert.match(find('Launch it where your people are').description, /needs also: Make the landing page, Wire up analytics and feedback/);
  assert.deepEqual(find('Run a friendly beta').prerequisites, [find('Smooth the first-run experience').id]);
  assert.match(find('Run a friendly beta').description, /needs also: Handle failure gracefully/);

  for (const label of ['Dogfood it for a week', 'Wire up analytics and feedback']) {
    assert.deepEqual(find(label).prerequisites, [find('Make the core feature real').id]);
    assert.equal(find(label).description, shipV1.nodes.find((node) => node.label === label).description);
  }
});

test('serializePlan emits the url string from { url, label } link objects, never [object Object]', () => {
  // The live app carries node.links as { url, label } objects; export must emit the url.
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

  const back = parsePlan(markdown, kinds);
  const child = back.nodes.find((node) => node.label === 'Draw a triangle');
  assert.deepStrictEqual(child.links, ['https://example.com/tri', 'https://bare.example/x']);
});

test('exports round-trip every root, completion, note, link and cross-kind primary dependency without a synthetic title step', () => {
  const tree = {
    title: 'Learn to sail',
    nodes: [
      { id: 'choose-a-course', label: 'Choose a course', color: 'sky', prerequisites: [], icon: 'sparkles', status: 'complete', description: 'Start nearby.\nCheck the dates.', links: ['https://example.com/course'] },
      { id: 'read-the-wind', label: 'Read the wind', color: 'olive', prerequisites: ['choose-a-course'], status: 'complete' },
      { id: 'leave-the-dock', label: 'Leave the dock', color: 'sky', prerequisites: ['read-the-wind'] },
      { id: 'pack-a-bag', label: 'Pack a bag', color: 'gold', prerequisites: [], status: 'complete' },
    ],
  };
  const kinds = [{ id: 'sky', hue: 'sky', label: '', description: '' }];
  const markdown = serializePlan(tree, kinds);
  assert.equal(markdown, [
    '# Learn to sail', '<!-- windmill:roadmap 2 -->',
    '- [x] Choose a course <!-- windmill:kind sky -->', '  > Start nearby.', '  > Check the dates.', '  <https://example.com/course>',
    '  - [x] Read the wind <!-- windmill:kind olive -->',
    '    - Leave the dock <!-- windmill:kind sky -->',
    '- [x] Pack a bag <!-- windmill:kind gold -->',
  ].join('\n'));
  const parsed = parsePlan(markdown);
  assert.equal(parsed.title, tree.title);
  assert.deepEqual(parsed.nodes, tree.nodes);
  assert.deepEqual(parsed.readout, { steps: 4, branches: 0, done: 3 });
  assert.equal(serializePlan(parsed, parsed.kinds), markdown);
});

test('empty exports and empty roadmap titles do not synthesize or rename steps', () => {
  for (const title of ['', 'A roadmap', '#']) {
    const markdown = serializePlan({ title, nodes: [] }, []);
    const parsed = parsePlan(markdown);
    assert.equal(parsed.title, title);
    assert.deepEqual(parsed.nodes, []);
    assert.deepEqual(parsed.readout, { steps: 0, branches: 0, done: 0 });
    assert.equal(serializePlan(parsed, parsed.kinds), markdown);
  }
});

test('exported named kinds preserve hues on a fresh import and respect bind-only existing kinds on append', () => {
  const kinds = [{ id: 'sailing', hue: 'sky', label: 'Sailing', description: '' }];
  const markdown = serializePlan({ title: 'Sail', nodes: [
    { id: 'wind', label: 'Wind', color: 'sky', prerequisites: [], status: 'complete' },
  ] }, kinds);
  const parsed = parsePlan(markdown);
  assert.deepEqual(parsed.nodes, [{ id: 'wind', label: 'Wind', color: 'sky', prerequisites: [], icon: 'sparkles', status: 'complete' }]);
  assert.deepEqual(parsed.kinds, [{ id: 'sailing', hue: 'sky', label: 'Sailing', description: '', source: 'added' }]);
  assert.equal(serializePlan(parsed, parsed.kinds), markdown);
  const existing = [{ id: 'weather', hue: 'sky', label: 'Weather', description: 'Keep this label.' }];
  const appended = parsePlan(markdown, existing, { bindOnly: true });
  assert.deepEqual(appended.kinds, [
    { ...existing[0], source: 'existing' },
    { id: 'sailing', hue: 'terracotta', label: 'Sailing', description: '', source: 'added' },
  ]);
  assert.deepEqual(appended.nodes, [{ id: 'wind', label: 'Wind', color: 'terracotta', prerequisites: [], icon: 'sparkles', status: 'complete' }]);
  assert.deepEqual(existing, [{ id: 'weather', hue: 'sky', label: 'Weather', description: 'Keep this label.' }]);
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

const EXPORT_FIXTURES = [shipV1, dogfoodTreeData(), ...ROADMAP_SHAPES.map((shape) => largeRoadmap(5000, shape))];

test('existing roadmap fixtures round-trip as Markdown with their primary shape and done marks', () => {
  for (const tree of EXPORT_FIXTURES) {
    const markdown = serializePlan(tree, tree.kinds);
    const parsed = parsePlan(markdown, tree.kinds);
    assert.equal(parsed.title, tree.title);
    assert.equal(parsed.nodes.length, tree.nodes.length, tree.title);
    assert.deepEqual(parsed.nodes.map((node) => [node.label, node.color, node.status === 'complete']).sort(),
      tree.nodes.map((node) => [node.label, node.color, node.status === 'complete']).sort(), tree.title);
    const originalById = new Map(tree.nodes.map((node) => [node.id, node]));
    const parsedById = new Map(parsed.nodes.map((node) => [node.id, node]));
    assert.deepEqual(parsed.nodes.map((node) => [node.label, node.prerequisites.map((id) => parsedById.get(id).label)]).sort(),
      tree.nodes.map((node) => [node.label, node.prerequisites.slice(0, 1).filter((id) => originalById.has(id)).map((id) => originalById.get(id).label)]).sort(), tree.title);
    assert.equal(serializePlan(parsed, parsed.kinds), markdown, tree.title);
  }
});

test('exported fixture lines never form CommonMark indented code blocks inside or outside lists', () => {
  for (const tree of EXPORT_FIXTURES) {
    const listIndents = [];
    for (const line of serializePlan(tree, tree.kinds).split('\n')) {
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      const body = line.trimStart();
      if (body.startsWith('- ')) {
        while (listIndents.length && listIndents.at(-1) >= indent) listIndents.pop();
        const containerIndent = listIndents.length ? listIndents.at(-1) + 2 : 0;
        assert.ok(indent - containerIndent < 4, `${tree.title}: ${line}`);
        listIndents.push(indent);
        continue;
      }
      while (listIndents.length && indent < listIndents.at(-1) + 2) listIndents.pop();
      const containerIndent = listIndents.length ? listIndents.at(-1) + 2 : 0;
      assert.ok(indent - containerIndent < 4, `${tree.title}: ${line}`);
    }
  }
});

test('kind-heading exports remain readable by the parser', () => {
  const parsed = parsePlan('# Sail\n<!-- windmill:roadmap -->\n## Sailing <!-- windmill:kind sky -->\n- [x] Choose a course\n## Practice <!-- windmill:kind olive -->\n  - Read the wind');
  assert.deepEqual(parsed.nodes, [
    { id: 'choose-a-course', label: 'Choose a course', color: 'sky', prerequisites: [], icon: 'sparkles', status: 'complete' },
    { id: 'read-the-wind', label: 'Read the wind', color: 'olive', prerequisites: ['choose-a-course'] },
  ]);
});

test('marked exports preserve duplicate and comment-shaped labels without changing ordinary duplicate pastes', () => {
  const tree = { title: 'Plan', nodes: [
    { id: 'a', label: 'Same', color: 'sky', prerequisites: [] },
    { id: 'b', label: 'Same', color: 'sky', prerequisites: ['a'] },
    { id: 'c', label: 'Second <!-- windmill:kind gold -->', color: 'sky', prerequisites: ['b'] },
  ] };
  const kinds = [{ id: 'odd', hue: 'sky', label: 'A --> B & C\nD', description: '' }];
  const markdown = serializePlan(tree, kinds);
  assert.equal(markdown, [
    '# Plan', '<!-- windmill:roadmap 2 -->',
    '- Same <!-- windmill:kind sky A &#45;&#45;&#62; B &#38; C&#10;D -->',
    '  - Same',
    '    - Second &#60;!-- windmill:kind gold --&#62;',
  ].join('\n'));
  const parsed = parsePlan(markdown);
  assert.deepEqual(parsed.nodes, [
    { id: 'same', label: 'Same', color: 'sky', prerequisites: [], icon: 'sparkles' },
    { id: 'same-2', label: 'Same', color: 'sky', prerequisites: ['same'] },
    { id: 'second-windmill-kind-gold', label: 'Second <!-- windmill:kind gold -->', color: 'sky', prerequisites: ['same-2'] },
  ]);
  assert.deepEqual(parsed.kinds, [{ id: 'a-b-c-d', hue: 'sky', label: kinds[0].label, description: '', source: 'added' }]);
  assert.equal(serializePlan(parsed, parsed.kinds), markdown);
  assert.deepEqual(parsePlan('# Plan\n- Same\n- Same').nodes, [
    { id: 'plan', label: 'Plan', color: 'terracotta', prerequisites: [], icon: 'sparkles' },
    { id: 'same', label: 'Same', color: 'terracotta', prerequisites: ['plan'] },
    { id: 'same-2', label: 'Same (2)', color: 'terracotta', prerequisites: ['plan'] },
  ]);
});

test('an export declares its first hue even when the import target starts with another kind', () => {
  const markdown = serializePlan({ title: 'Plan', nodes: [
    { id: 'root', label: 'Start', color: 'terracotta', prerequisites: [] },
  ] }, []);
  assert.equal(markdown, '# Plan\n<!-- windmill:roadmap 2 -->\n- Start <!-- windmill:kind terracotta -->');
  assert.deepEqual(parsePlan(markdown, [{ id: 'learn', hue: 'sky', label: 'Learning' }]).nodes, [
    { id: 'start', label: 'Start', color: 'terracotta', prerequisites: [], icon: 'sparkles' },
  ]);
});

// Roadmaps the domain accepts, drawn from text that looks like every line the grammar reads: each is written and read
// back to the same steps, in the order the file writes them, with the same kinds, marks, descriptions and addresses.
test('every roadmap the domain accepts reads back from its file as it was written', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const pieces = ['a', 'Sail', ' ', '  ', '\t', ' ', '　', '﻿', ' ', ' ', '\r', '\n', '\r\n', '&', '&#38;', '&#10;', '<', '>',
    '-->', '<!-- windmill:kind sky -->', ' <!-- windmill:kind gold Sea -->', '[x] ', '[ ]', '[', '- ', '* ', '1. ', '## ', '# ', '> ', '<a>',
    'https://example.com/x', 'needs also: A', '😀', 'é', '\u0000'.replace('\u0000', 'z'), '#', '•'];
  const text = (most) => Array.from({ length: Math.floor(random() * most) }, () => pick(pieces)).join('');
  const hues = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
  for (let round = 0; round < 300; round += 1) {
    const kinds = hues.filter(() => random() < 0.5).map((hue, index) => ({ id: `k${index}`, hue, label: [...text(6)].slice(0, 24).join(''), description: '' }));
    const nodes = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) => ({
      id: `s${index}`, label: [...text(8)].slice(0, 200).join(''), color: pick(hues), prerequisites: [],
      description: random() < 0.5 ? text(10) : '', links: Array.from({ length: Math.floor(random() * 3) }, () => ({ url: `${pick(['https://', 'mailto:', 'www.', ''])}${text(4).trim() || 'x'}`, label: '' })),
    }));
    for (const [index, node] of nodes.entries()) if (index > 0 && random() < 0.7) node.prerequisites = [`s${Math.floor(random() * index)}`];
    const done = nodes.filter(() => random() < 0.3).map((node) => node.id);
    const title = [...text(6)].slice(0, 200).join('');
    const file = serializePlan({ title, nodes }, kinds, done);
    const read = parsePlan(file, []);

    const written = [];
    const childrenOf = (id) => nodes.filter((node) => node.prerequisites[0] === id);
    const walk = (node) => { written.push(node); childrenOf(node.id).forEach(walk); };
    nodes.filter((node) => node.prerequisites.length === 0).forEach(walk);
    const named = (hue) => kinds.filter((kind) => kind.hue === hue).at(-1)?.label ?? '';
    const shown = (node) => ({ label: node.label, color: node.color, done: done.includes(node.id), description: node.description || undefined,
      links: node.links.map((link) => link.url.trim()).filter((url) => url !== '') });
    assert.deepEqual({
      title: read.title,
      nodes: read.nodes.map((node) => ({ ...shown({ ...node, links: (node.links ?? []).map((url) => ({ url })) }), done: node.status === 'complete',
        under: read.nodes.findIndex((other) => other.id === node.prerequisites[0]) })),
      kinds: read.kinds.map((kind) => [kind.hue, kind.label]),
    }, {
      title,
      nodes: written.map((node) => ({ ...shown(node), under: written.findIndex((other) => other.id === node.prerequisites[0]) })),
      kinds: [...new Set(written.map((node) => node.color))].filter((hue) => named(hue) !== '').map((hue) => [hue, named(hue)]),
    }, file);
  }
});
