// paste append-mode graft (F3 §01): the pure transform that shapes a parsed plan into a
// subgraph attached under one node of a LIVE tree. The graft rule (attach vs dissolve,
// keyed on parse.missingRoot), the id-collision remap, and the adds-only legend diff —
// the three invariants SkillTreeView leans on when it dispatches ONE ImportSubgraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';
import { graftPlan } from '../../../../src/products/roadmap/paste/graftPlan.js';
import { TreeLattice, HlcClock } from '../../../../src/products/roadmap/sync/lattice.js';
import { materialize } from '../../../../src/products/roadmap/sync/materialize.js';

const LIVE_KINDS = [
  { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
  { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
];

test('attach: a named root grafts as a child of the target, subtree kept, sparkles stripped', () => {
  const parse = parsePlan('# Deployment\n- write dockerfile\n- set up CI', LIVE_KINDS, { bindOnly: true });
  assert.equal(parse.missingRoot, false);

  const graft = graftPlan({
    parse,
    targetId: 'root-node',
    reservedNodeIds: ['root-node', 'other'],
    liveKinds: LIVE_KINDS,
  });

  // The parsed root becomes a plain node under the target — and wears NO icon (the birth
  // spark is stripped); its steps hang beneath it exactly as parsed.
  assert.deepStrictEqual(graft.nodes, [
    { id: 'deployment', label: 'Deployment', color: 'terracotta', position: null },
    { id: 'write-dockerfile', label: 'write dockerfile', color: 'terracotta', position: null },
    { id: 'set-up-ci', label: 'set up CI', color: 'terracotta', position: null },
  ]);
  assert.ok(!('icon' in graft.nodes[0]), 'the grafted root must not carry the sparkles icon');
  assert.deepStrictEqual(graft.edges, [
    { from: 'root-node', to: 'deployment' },
    { from: 'deployment', to: 'write-dockerfile' },
    { from: 'deployment', to: 'set-up-ci' },
  ]);
  assert.deepStrictEqual(graft.kinds, []); // a `#` root claims no kind — nothing new to add
});

test('dissolve: a headless flat list attaches directly under the target, no wrapper', () => {
  const parse = parsePlan('- one\n- two\n- three', LIVE_KINDS, { bindOnly: true });
  assert.equal(parse.missingRoot, true);

  const graft = graftPlan({
    parse,
    targetId: 'target',
    reservedNodeIds: ['target'],
    liveKinds: LIVE_KINDS,
  });

  // The synthesized empty root is dropped; each of its direct children re-roots onto the
  // target, so the list fans off the selection with no forced wrapper node.
  assert.deepStrictEqual(graft.nodes, [
    { id: 'one', label: 'one', color: 'terracotta', position: null },
    { id: 'two', label: 'two', color: 'terracotta', position: null },
    { id: 'three', label: 'three', color: 'terracotta', position: null },
  ]);
  assert.deepStrictEqual(graft.edges, [
    { from: 'target', to: 'one' },
    { from: 'target', to: 'two' },
    { from: 'target', to: 'three' },
  ]);
  assert.ok(graft.nodes.every((node) => node.id !== 'root'), 'the synthesized root must never land');
});

test('no target (empty tree): an attached root lands as a real root, subtree kept', () => {
  const parse = parsePlan('# Deployment\n- write dockerfile\n- set up CI', LIVE_KINDS, { bindOnly: true });
  const graft = graftPlan({ parse, targetId: null, reservedNodeIds: [], liveKinds: LIVE_KINDS });

  assert.deepStrictEqual(graft.nodes, [
    { id: 'deployment', label: 'Deployment', color: 'terracotta', position: null },
    { id: 'write-dockerfile', label: 'write dockerfile', color: 'terracotta', position: null },
    { id: 'set-up-ci', label: 'set up CI', color: 'terracotta', position: null },
  ]);
  // No target edge for the root — it IS the root now; its steps still hang beneath it.
  assert.deepStrictEqual(graft.edges, [
    { from: 'deployment', to: 'write-dockerfile' },
    { from: 'deployment', to: 'set-up-ci' },
  ]);
});

test('no target (empty tree): a dissolved flat list lands as roots, no wrapper', () => {
  const parse = parsePlan('- one\n- two', LIVE_KINDS, { bindOnly: true });
  const graft = graftPlan({ parse, targetId: null, reservedNodeIds: [], liveKinds: LIVE_KINDS });

  assert.deepStrictEqual(graft.nodes, [
    { id: 'one', label: 'one', color: 'terracotta', position: null },
    { id: 'two', label: 'two', color: 'terracotta', position: null },
  ]);
  assert.deepStrictEqual(graft.edges, []); // the missing target drops every root edge — each is its own root
});

test('id collision: colliding parsed ids are suffixed, every node kept and its edges rewired', () => {
  // The parse yields ids "foo" (root) and "bar" (a child of foo). The live tree already
  // owns "foo", so the graft must remap foo → foo-2 without losing bar or its edge.
  const parse = parsePlan('# Foo\n- Bar', LIVE_KINDS, { bindOnly: true });
  const graft = graftPlan({
    parse,
    targetId: 'target',
    reservedNodeIds: ['foo', 'target'],
    liveKinds: LIVE_KINDS,
  });

  assert.deepStrictEqual(graft.nodes, [
    { id: 'foo-2', label: 'Foo', color: 'terracotta', position: null },
    { id: 'bar', label: 'Bar', color: 'terracotta', position: null },
  ]);
  // bar still hangs off the (remapped) root, and the root hangs off the target — no
  // existing "foo" is overwritten.
  assert.deepStrictEqual(graft.edges, [
    { from: 'target', to: 'foo-2' },
    { from: 'foo-2', to: 'bar' },
  ]);
});

test('id collision: a suffix that would itself collide keeps climbing', () => {
  // Parsed ids: "foo" (root) and "foo-2" (a dupe-renamed child). The live tree owns "foo",
  // so foo → foo-2 collides with the parsed "foo-2", which must then climb to foo-2-2.
  const parse = parsePlan('# Foo\n- Foo', LIVE_KINDS, { bindOnly: true });
  assert.deepStrictEqual(parse.nodes.map((n) => n.id), ['foo', 'foo-2']);

  const graft = graftPlan({
    parse,
    targetId: 'target',
    reservedNodeIds: ['foo'],
    liveKinds: LIVE_KINDS,
  });
  assert.deepStrictEqual(graft.nodes.map((n) => n.id), ['foo-2', 'foo-2-2']);
  assert.deepStrictEqual(graft.edges, [
    { from: 'target', to: 'foo-2' },
    { from: 'foo-2', to: 'foo-2-2' },
  ]);
});

test('tombstone safety: a graft never resurrects a deleted node whose slug the paste reuses', () => {
  // The lattice keeps a deleted node as a tombstone forever (CRDT convergence), and a
  // `created` write re-lives it with its old fields and edges intact. So the reserved set
  // must be every KNOWN id, present or not — a paste reusing a dead slug is remapped, not revived.
  const lattice = new TreeLattice('t_0000000000000000', 'Live');
  const clock = new HlcClock('tester');
  const play = (gesture) => lattice.join(materialize(gesture, lattice, clock));

  play({ kind: 'CreateNode', id: 'deploy', label: 'Deploy' });
  play({ kind: 'DeleteNode', id: 'deploy' });

  assert.deepStrictEqual(lattice.toTreeData().nodes.map((n) => n.id), []); // the projection forgot it
  assert.deepStrictEqual(lattice.knownNodeIds(), ['deploy']);              // the lattice still holds it

  const parse = parsePlan('# Deploy\n- ship it', LIVE_KINDS, { bindOnly: true });
  const graft = graftPlan({
    parse,
    targetId: null,
    reservedNodeIds: lattice.knownNodeIds(),
    liveKinds: LIVE_KINDS,
  });
  assert.deepStrictEqual(graft.nodes.map((n) => n.id), ['deploy-2', 'ship-it']);
});

test('adds-only legend: an unmatched heading mints a fresh kind; existing kinds untouched', () => {
  const parse = parsePlan('Plan\n## Research\n- read the paper\n## Build\n- ship it', LIVE_KINDS, { bindOnly: true });
  const graft = graftPlan({
    parse,
    targetId: 'target',
    reservedNodeIds: ['target'],
    liveKinds: LIVE_KINDS,
  });

  // "Build" binds to the existing kind (case-insensitive), so it is NOT in the diff.
  // "Research" matches nothing → a fresh minted hue, the only kind the graft adds.
  assert.deepStrictEqual(graft.kinds, [
    { id: 'research', hue: 'gold', label: 'Research', description: '' },
  ]);
  // and the existing "build" kind is neither renamed nor recolored by the graft.
  assert.equal(parse.kinds.find((k) => k.id === 'build').label, 'Build');
  assert.equal(parse.kinds.find((k) => k.id === 'build').source, 'existing');
});

test('adds-only legend: a kind adopted into the draft (absent from the live legend) still lands', () => {
  // The composer can adopt a minted kind into its draft legend before grafting. Such a kind
  // reads as "existing" in the parse (it was passed as an existingKind) but is genuinely new
  // to the live tree — the id-diff against liveKinds catches it, so it isn't dropped.
  const draftKinds = [...LIVE_KINDS, { id: 'research', hue: 'gold', label: 'Research', description: 'digging' }];
  const parse = parsePlan('Plan\n## Research\n- read', draftKinds, { bindOnly: true });
  assert.equal(parse.kinds.find((k) => k.id === 'research').source, 'existing');

  const graft = graftPlan({
    parse,
    targetId: 'target',
    reservedNodeIds: ['target'],
    liveKinds: LIVE_KINDS, // the LIVE legend does not yet know "research"
  });
  assert.deepStrictEqual(graft.kinds, [
    { id: 'research', hue: 'gold', label: 'Research', description: 'digging' },
  ]);
});
