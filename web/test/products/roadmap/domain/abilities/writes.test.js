// @ts-check
// The direct writes' rules beyond the corpus's cases: every refusal of §6 and §6.1 a direct write meets, in §6's order, and
// what a write sends where a call leaves a field out.

import assert from 'node:assert/strict';
import test from 'node:test';
import { WriteAbilities } from '../../../../../src/products/roadmap/domain/abilities/writes.js';

/** @typedef {import('../../../../../src/products/roadmap/domain/records.js').TreeInput} TreeInput */

// A roadmap of the person's own as the standing roadmap holds it: `a` done, `b` available, `c` waiting on both, and `x`
// a step another device deleted, removed from it.
/** @param {Partial<TreeInput>} [changes] @returns {any} */
function sailing(changes = {}) {
  return { id: 't_0000000000000001', own: true, meta: { title: 'Learn to sail' },
    nodes: [{ id: 'a', ord: 'a0', label: 'Leave the dock' }, { id: 'b', ord: 'a1', label: 'Tie a bowline', description: 'Round the post.',
      links: [{ url: 'https://example.org/bowline', label: 'Knots' }] }, { id: 'c', ord: 'a2', label: 'Sail with an instructor' },
      { id: 'x', ord: 'a3', label: 'Read the wind', present: false }],
    edges: [{ from: 'a', to: 'c', present: true }, { from: 'b', to: 'c', present: true }],
    kinds: [{ id: 'build', hue: 'terracotta', label: 'Build', ord: 'a0' }, { id: 'learn', hue: 'olive', label: 'Learn', ord: 'a1' }],
    marks: [{ node: 'a', status: 'complete', recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 }], ...changes };
}

// One call of each direct write on `step`, the roadmap's step `b` unless named.
/** @param {string} treeId @param {string} [step] */
function everyWrite(treeId, step = 'b') {
  return /** @type {const} */ ([
    ['set_progress', { treeId, nodeId: step, status: 'complete' }],
    ['rename_node', { treeId, nodeId: step, label: 'Tie a cleat hitch' }],
    ['annotate_node', { treeId, nodeId: step, description: 'Through the loop.' }],
    ['create_node', { treeId, label: 'Hoist the sail', prerequisites: [step] }],
    ['connect', { treeId, nodeId: step, prerequisiteId: 'a' }],
  ]);
}

/** @param {any} standing @param {readonly (readonly [string, any])[]} calls @param {string | null} about */
function answers(standing, calls, about) {
  return calls.map(([name, input]) => /** @type {any} */ (WriteAbilities)[name](standing, input, about, () => 'k1x9q2m7p4z8w3r5'));
}

test('a write names a roadmap the device holds whole: one it is still bringing, or bringing again, waits until it has, and one that is none of the person\'s is unknown', () => {
  const rebuilt = { trees: [sailing({ read: 'unread' })] };
  assert.deepEqual(answers(rebuilt, everyWrite('t_0000000000000001'), 't_0000000000000001'),
    everyWrite('t_0000000000000001').map(() => ({ refused: { code: 'roadmap-unavailable', id: 't_0000000000000001' } })));
  assert.deepEqual(answers({ trees: [sailing()] }, everyWrite('t_0000000000000009'), 't_0000000000000001'),
    everyWrite('t_0000000000000009').map(() => ({ refused: { code: 'unknown-roadmap', id: 't_0000000000000009' } })));
});

test('a conversation about all of the person\'s roadmaps takes no direct write', () => {
  assert.deepEqual(answers({ trees: [sailing()] }, everyWrite('t_0000000000000001'), null),
    everyWrite('t_0000000000000001').map(() => ({ refused: { code: 'out-of-scope', id: 't_0000000000000001' } })));
});

test('every write that names a step under a delete the person can still undo is not ready, before whose roadmap it is', () => {
  const standing = { trees: [sailing({ own: false, nodes: [...sailing().nodes, { id: 'h', ord: 'a4', label: 'Reef the sail', present: false }] })],
    held: [{ tree: 't_0000000000000001', step: 'h' }] };
  assert.deepEqual(answers(standing, everyWrite('t_0000000000000001', 'h'), 't_0000000000000001'),
    everyWrite('t_0000000000000001').map(() => ({ refused: { code: 'roadmap-not-ready', id: 'h' } })));
  assert.deepEqual(answers(standing, [['connect', { treeId: 't_0000000000000001', nodeId: 'b', prerequisiteId: 'h' }],
    ['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', prerequisites: ['a', 'h'] }]], 't_0000000000000001'),
  [{ refused: { code: 'roadmap-not-ready', id: 'h' } }, { refused: { code: 'roadmap-not-ready', id: 'h' } }]);
});

test('a step the roadmap does not show is unknown to every write, a step another device deleted among them', () => {
  for (const step of ['zz', 'x']) {
    assert.deepEqual(answers({ trees: [sailing()] }, everyWrite('t_0000000000000001', step), 't_0000000000000001'),
      everyWrite('t_0000000000000001').map(() => ({ refused: { code: 'unknown-step', id: step } })), step);
  }
  assert.deepEqual(answers({ trees: [sailing()] }, [['connect', { treeId: 't_0000000000000001', nodeId: 'b', prerequisiteId: 'zz' }]], 't_0000000000000001'),
    [{ refused: { code: 'unknown-step', id: 'zz' } }], 'the step waited on, where the step that waits is shown');
});

test('a value past a cap of limits.json is refused on the device, naming the step it writes, none for a new one, and the roadmap where its count is full', () => {
  const standing = { trees: [sailing()] };
  const write = (/** @type {string} */ name, /** @type {any} */ input) => answers(standing, [[name, { treeId: 't_0000000000000001', ...input }]], 't_0000000000000001')[0];
  const link = { url: 'https://example.org/knots', label: 'Knots' };
  assert.deepEqual([
    write('annotate_node', { nodeId: 'b', description: 'é'.repeat(16_001) }),
    write('annotate_node', { nodeId: 'b', links: Array.from({ length: 33 }, () => link) }),
    write('annotate_node', { nodeId: 'b', links: [{ url: `https://example.org/${'k'.repeat(2_029)}` }] }),
    write('annotate_node', { nodeId: 'b', links: [{ ...link, label: 'k'.repeat(201) }] }),
    write('create_node', { label: 'é'.repeat(201), prerequisites: [] }),
    write('create_node', { label: 'Hoist the sail', description: 'é'.repeat(16_001), prerequisites: [] }),
  ], [
    { refused: { code: 'over-limit', id: 'b' } }, { refused: { code: 'over-limit', id: 'b' } }, { refused: { code: 'over-limit', id: 'b' } },
    { refused: { code: 'over-limit', id: 'b' } }, { refused: { code: 'over-limit' } }, { refused: { code: 'over-limit' } },
  ]);
  assert.deepEqual(write('annotate_node', { nodeId: 'b', description: 'é'.repeat(16_000), links: Array.from({ length: 32 }, () => link) }), { writes: [{ action: 'ChangeStep',
    input: { tree: 't_0000000000000001', step: 'b', changes: { description: 'é'.repeat(16_000), links: Array.from({ length: 32 }, () => link) } } }], result: {} }, 'a value at its cap');

  const full = { trees: [sailing({ nodes: Array.from({ length: 10_000 }, (_, index) => ({ id: `s${index}` })), edges: [], marks: [] })] };
  assert.deepEqual(answers(full, [['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', prerequisites: [] }]], 't_0000000000000001'),
    [{ refused: { code: 'over-limit', id: 't_0000000000000001' } }]);
  const nearly = { trees: [sailing({ nodes: Array.from({ length: 9_999 }, (_, index) => ({ id: `s${index}` })), edges: [], marks: [] })] };
  assert.deepEqual(answers(nearly, [['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', prerequisites: [] }]], 't_0000000000000001'),
    [{ writes: [{ action: 'CreateStep', input: { tree: 't_0000000000000001', step: { label: 'Hoist the sail', color: 'terracotta' }, prerequisites: [],
      id: 'k1x9q2m7p4z8w3r5' } }], result: { nodeId: 'k1x9q2m7p4z8w3r5' } }], 'the ten thousandth step');

  const ids = Array.from({ length: 202 }, (_, index) => `s${index}`);
  const linked = ids.flatMap((from, index) => ids.slice(index + 1).map((to) => ({ from, to, present: true }))).slice(0, 20_000);
  const woven = { trees: [sailing({ nodes: ids.map((id) => ({ id })), edges: linked, marks: [] })] };
  assert.deepEqual(answers(woven, [['connect', { treeId: 't_0000000000000001', nodeId: 's201', prerequisiteId: 's200' }],
    ['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', prerequisites: ['s0'] }]], 't_0000000000000001'),
  [{ refused: { code: 'over-limit', id: 't_0000000000000001' } }, { refused: { code: 'over-limit', id: 't_0000000000000001' } }]);
});

test('a link that would close a loop among what steps follow is refused, through a removed step and from a step to itself', () => {
  const standing = { trees: [sailing({ edges: [{ from: 'a', to: 'x', present: true }, { from: 'x', to: 'b', present: true }] })] };
  assert.deepEqual(answers(standing, [['connect', { treeId: 't_0000000000000001', nodeId: 'a', prerequisiteId: 'b' }],
    ['connect', { treeId: 't_0000000000000001', nodeId: 'c', prerequisiteId: 'c' }]], 't_0000000000000001'),
  [{ refused: { code: 'closes-cycle', id: 'a' } }, { refused: { code: 'closes-cycle', id: 'c' } }]);
});

test('a write that sends what the step already holds changes nothing: its title, its words and web links as the domain stores them, a link it follows, a mark that stands', () => {
  const standing = { trees: [sailing({ edges: [{ from: 'a', to: 'x', present: true }, { from: 'x', to: 'b', present: true }, { from: 'b', to: 'c', present: true }] })] };
  assert.deepEqual(answers(standing, [
    ['rename_node', { treeId: 't_0000000000000001', nodeId: 'b', label: 'Tie a bowline' }],
    ['annotate_node', { treeId: 't_0000000000000001', nodeId: 'b', description: 'Round the post.', links: [{ url: '  https://example.org/bowline ', label: 'Knots' }] }],
    ['connect', { treeId: 't_0000000000000001', nodeId: 'b', prerequisiteId: 'a' }],
    ['connect', { treeId: 't_0000000000000001', nodeId: 'c', prerequisiteId: 'b' }],
    ['set_progress', { treeId: 't_0000000000000001', nodeId: 'c', status: 'none' }],
  ], 't_0000000000000001'), ['b', 'b', 'b', 'c', 'c'].map((id) => ({ refused: { code: 'no-change', id } })));
});

test('web links are written as the domain stores them, each address trimmed and a label left out empty, and what a call leaves out stays', () => {
  assert.deepEqual(answers({ trees: [sailing()] }, [['annotate_node', { treeId: 't_0000000000000001', nodeId: 'b',
    links: [{ url: ' mailto:skipper@example.org ' }] }]], 't_0000000000000001'), [{ writes: [{ action: 'ChangeStep', input: { tree: 't_0000000000000001',
    step: 'b', changes: { links: [{ url: 'mailto:skipper@example.org', label: '' }] } } }], result: {} }]);
  assert.deepEqual(answers({ trees: [sailing()] }, [['annotate_node', { treeId: 't_0000000000000001', nodeId: 'b',
    links: [{ url: 'https://example.org/knots' }, { url: 'ftp://example.org/knots' }] }]], 't_0000000000000001'),
  [{ refused: { code: 'address-not-allowed', id: 'b' } }]);
});

test('a new step wears its kind\'s hue, terracotta where it names none, after each prerequisite once, with the words it is given', () => {
  assert.deepEqual(answers({ trees: [sailing()] }, [
    ['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', description: 'Main first.', prerequisites: ['a', 'b', 'a'] }],
    ['create_node', { treeId: 't_0000000000000001', label: 'Hoist the sail', kind: 'learn', description: '', prerequisites: [] }],
  ], 't_0000000000000001'), [
    { writes: [{ action: 'CreateStep', input: { tree: 't_0000000000000001', step: { label: 'Hoist the sail', color: 'terracotta', description: 'Main first.' },
      prerequisites: ['a', 'b'], id: 'k1x9q2m7p4z8w3r5' } }], result: { nodeId: 'k1x9q2m7p4z8w3r5' } },
    { writes: [{ action: 'CreateStep', input: { tree: 't_0000000000000001', step: { label: 'Hoist the sail', color: 'olive' },
      prerequisites: [], id: 'k1x9q2m7p4z8w3r5' } }], result: { nodeId: 'k1x9q2m7p4z8w3r5' } },
  ]);
});

test('a step that opens a roadmap the device holds nothing of takes neither mark, and a locked step may still be marked not done', () => {
  const standing = { trees: [sailing({ pointers: [{ node: 'b', present: true, opens: 't_0000000000000009', setAt: null }],
    marks: [{ node: 'a', status: 'complete', recordedAt: null, deviceAt: null }, { node: 'c', status: 'complete', outOfOrder: true, recordedAt: null, deviceAt: null }] })] };
  assert.deepEqual(answers(standing, [
    ['set_progress', { treeId: 't_0000000000000001', nodeId: 'b', status: 'complete' }],
    ['set_progress', { treeId: 't_0000000000000001', nodeId: 'b', status: 'none' }],
    ['set_progress', { treeId: 't_0000000000000001', nodeId: 'c', status: 'none' }],
  ], 't_0000000000000001'), [{ refused: { code: 'opens-roadmap', id: 'b' } }, { refused: { code: 'opens-roadmap', id: 'b' } },
    { writes: [{ action: 'Reset', input: { tree: 't_0000000000000001', step: 'c' } }], result: {} }]);
});

test('a text the domain cannot store is malformed before any cap, naming the step the write names, and a blank address is the address rule\'s', () => {
  const standing = { trees: [sailing()] };
  const write = (/** @type {string} */ name, /** @type {any} */ input) => answers(standing, [[name, { treeId: 't_0000000000000001', ...input }]], 't_0000000000000001')[0];
  assert.deepEqual([
    write('annotate_node', { nodeId: 'b', description: `${'é'.repeat(16_001)}\u0000` }),
    write('annotate_node', { nodeId: 'b', description: 'Round the post.', links: [{ url: 'https://example.org/\udfff' }] }),
    write('annotate_node', { nodeId: 'b', links: Array.from({ length: 33 }, () => ({ url: 'https://example.org/knots', label: '\u0000' })) }),
    write('create_node', { label: 'Hoist \ud83d', prerequisites: [] }),
    write('create_node', { label: 'Hoist the sail', description: 'Main\u0000first.', prerequisites: [] }),
    write('rename_node', { nodeId: 'b', label: 'Tie a \ud83d\ude00 bowline' }),
    write('annotate_node', { nodeId: 'b', links: [{ url: '   ' }] }),
  ], [
    { refused: { code: 'invalid-input', id: 'b' } }, { refused: { code: 'invalid-input', id: 'b' } }, { refused: { code: 'invalid-input', id: 'b' } },
    { refused: { code: 'invalid-input' } }, { refused: { code: 'invalid-input' } },
    { writes: [{ action: 'ChangeStep', input: { tree: 't_0000000000000001', step: 'b', changes: { label: 'Tie a \ud83d\ude00 bowline' } } }], result: {} },
    { refused: { code: 'address-not-allowed', id: 'b' } },
  ]);
});
