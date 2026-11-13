// The cases of the server's OpenedTreesTest (backend/test/products/roadmap/domain/OpenedTreesTest.cpp), run on the rule
// the device judges its own trees by.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Opening, Openings } from '../../../../src/products/roadmap/model/Opening.js';
import { OpenedTrees } from '../../../../src/products/roadmap/model/OpenedTrees.js';

const step = (id, opens = '') => ({ id, label: id, ...(opens ? { opens } : {}) });
const tree = (nodes, completed = []) => ({ nodes, completed: new Set(completed) });
const judged = (trees) => new OpenedTrees(new Map(Object.entries(trees).map(([id, held]) => [id, { title: `Tree ${id}`, ...held }])));
const open = (treeId, { complete = false, done, total, loop = false }) =>
  new Opening({ treeId, read: true, valid: true, complete, title: `Tree ${treeId}`, done, total, loop });
const missing = (treeId) => new Opening({ treeId, read: true });
const openings = (byStep) => new Openings(new Map(Object.entries(byStep)), true);

test('a step is complete when the tree it opens is complete, and open until then', () => {
  const halfway = judged({ root: tree([step('idea', 'sub')]), sub: tree([step('s1'), step('s2')], ['s1']) });
  assert.deepEqual(halfway.openings('root'), openings({ idea: open('sub', { done: 1, total: 2 }) }));
  assert.deepEqual(halfway.progressOf('root'), { done: 0, total: 1 });

  const finished = judged({ root: tree([step('idea', 'sub')]), sub: tree([step('s1'), step('s2')], ['s1', 's2']) });
  assert.deepEqual(finished.openings('root'), openings({ idea: open('sub', { complete: true, done: 2, total: 2 }) }));
  assert.deepEqual(finished.progressOf('root'), { done: 1, total: 1 });
});

test('two trees that open each other are never complete, whatever their marks, and each is a loop to the other', () => {
  const both = judged({ a: tree([step('to-b', 'b')], ['to-b']), b: tree([step('to-a', 'a'), step('done')], ['to-a', 'done']) });

  assert.deepEqual(both.openings('a'), openings({ 'to-b': open('b', { done: 1, total: 2, loop: true }) }));
  assert.deepEqual(both.openings('b'), openings({ 'to-a': open('a', { done: 0, total: 1, loop: true }) }));
  assert.deepEqual([...both.complete], []);
  assert.deepEqual(both.leadingBackTo('a'), new Set(['a', 'b']));
});

test('a tree that opens itself is never complete, and its step reads a loop', () => {
  const alone = judged({ self: tree([step('again', 'self'), step('done')], ['again', 'done']) });

  assert.deepEqual(alone.openings('self'), openings({ again: open('self', { done: 1, total: 2, loop: true }) }));
  assert.deepEqual(alone.progressOf('self'), { done: 1, total: 2 });
  assert.deepEqual(alone.leadingBackTo('self'), new Set(['self']));
});

test('an empty tree is not complete, so the step that opens it is not either, its mark set aside', () => {
  const both = judged({ root: tree([step('idea', 'empty')], ['idea']), empty: tree([]) });

  assert.deepEqual(both.openings('root'), openings({ idea: open('empty', { done: 0, total: 0 }) }));
  assert.deepEqual(both.progressOf('root'), { done: 0, total: 1 });
});

test('a chain of any length completes from the mark at its end, and a ring of any length never does', () => {
  const link = (k) => `t${100 + k}`;
  const chain = (marked) => Object.fromEntries(Array.from({ length: 40 }, (_, k) =>
    [link(k), tree([step('n', k < 39 ? link(k + 1) : '')], marked && k === 39 ? ['n'] : [])]));

  assert.deepEqual(judged(chain(false)).openings(link(0)), openings({ n: open(link(1), { done: 0, total: 1 }) }));
  const marked = judged(chain(true));
  assert.deepEqual(marked.openings(link(0)), openings({ n: open(link(1), { complete: true, done: 1, total: 1 }) }));
  assert.deepEqual(marked.leadingBackTo(link(0)), new Set([link(0)]));

  const ring = Object.fromEntries(Array.from({ length: 40 }, (_, k) =>
    [link(k), tree(k < 39 ? [step('n', link(k + 1))] : [step('n', link(0)), step('plain')], ['n', 'plain'])]));
  const looped = judged(ring);
  assert.deepEqual(looped.openings(link(0)), openings({ n: open(link(1), { done: 0, total: 1, loop: true }) }));
  assert.deepEqual(looped.progressOf(link(39)), { done: 1, total: 2 });
  assert.equal(looped.leadingBackTo(link(0)).size, 40);
});

test('a tree opened from two steps and along two ways is judged once and is no loop', () => {
  const all = judged({
    root: tree([step('left', 'a'), step('right', 'b'), step('direct', 'shared'), step('twice', 'shared')]),
    a: tree([step('down', 'shared')]),
    b: tree([step('down', 'shared'), step('own')], ['own']),
    shared: tree([step('s')], ['s']),
  });

  assert.deepEqual(all.openings('root'), openings({
    left: open('a', { complete: true, done: 1, total: 1 }),
    right: open('b', { complete: true, done: 2, total: 2 }),
    direct: open('shared', { complete: true, done: 1, total: 1 }),
    twice: open('shared', { complete: true, done: 1, total: 1 }),
  }));
  assert.deepEqual(all.leadingBackTo('root'), new Set(['root']));
});

test('a mark on a step that opens one of the trees is set aside, and one on a step whose tree was removed counts', () => {
  const both = judged({
    root: tree([step('valid', 'sub'), step('gone', 't_removed'), step('gone-unmarked', 't_removed'), step('plain')], ['valid', 'gone', 'plain', 'ghost']),
    sub: tree([step('s')]),
  });

  assert.deepEqual(both.openings('root'), openings({ valid: open('sub', { done: 0, total: 1 }), gone: missing('t_removed'), 'gone-unmarked': missing('t_removed') }));
  assert.deepEqual(both.progressOf('root'), { done: 2, total: 4 });
});

test('done counts a nested step by the tree it opens', () => {
  const all = judged({
    root: tree([step('idea', 'mid')]),
    mid: tree([step('marked'), step('unmarked'), step('to-complete', 'leaf-done'), step('to-open', 'leaf-open'), step('to-removed', 't_removed'),
      step('to-removed-unmarked', 't_removed')], ['marked', 'to-open', 'to-removed']),
    'leaf-done': tree([step('l')], ['l']),
    'leaf-open': tree([step('l')]),
  });

  assert.deepEqual(all.openings('root'), openings({ idea: open('mid', { done: 3, total: 6 }) }));
});

test('the trees that lead back are found at any distance, and a loop elsewhere is not among them', () => {
  const trees = { root: tree([step('far', 'back1'), step('near', 'leaf'), step('elsewhere', 'x')]), leaf: tree([step('l')]),
    x: tree([step('to-y', 'y')]), y: tree([step('to-x', 'x')]) };
  for (let k = 1; k <= 12; k += 1) trees[`back${k}`] = tree([step('on', k < 12 ? `back${k + 1}` : 'root')]);
  const all = judged(trees);
  const backs = Array.from({ length: 12 }, (_, k) => `back${k + 1}`);

  assert.deepEqual(all.leadingBackTo('root'), new Set(['root', ...backs]));
  assert.deepEqual(all.leadingBackTo('leaf'), new Set(['leaf', 'root', ...backs]));
  assert.deepEqual(all.leadingBackTo('t_removed'), new Set());
  assert.deepEqual(all.openings('root'), openings({
    far: open('back1', { done: 0, total: 1, loop: true }), near: open('leaf', { done: 0, total: 1 }), elsewhere: open('x', { done: 0, total: 1 }),
  }));
});

test('what goes with a removed tree is each other tree whose steps open it, in id order, and never its own', () => {
  const all = judged({
    sail: tree([step('again', 'sail'), step('rig')]),
    year: tree([step('learn', 'sail'), step('coast', 'sail'), step('run')]),
    summer: tree([step('plan', 'sail')]),
    reading: tree([step('book')]),
  });

  assert.deepEqual(all.openersOf('sail'), [{ treeId: 'summer', steps: 1 }, { treeId: 'year', steps: 2 }]);
  assert.deepEqual(all.openersOf('reading'), []);
  assert.deepEqual(all.openersOf('t_removed'), []);
});

// The rule enumerated, as the server's random accounts check it: the complete trees are those in every set closed under
// "holds a step, and each step is complete".
test('random accounts agree with the rule enumerated over every set of their trees', () => {
  let seed = 20261112;
  const below = (bound) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % bound;
  };
  let disagreements = 0;
  for (let account = 0; account < 300; account += 1) {
    const count = 1 + below(7);
    const ids = Array.from({ length: count }, (_, t) => `${String.fromCharCode(97 + below(26))}${t}`);
    const pointerPercent = [20, 45, 75][below(3)];
    const markPercent = [100, 90, 60][below(3)];
    const trees = Object.fromEntries(ids.map((id) => {
      const nodes = Array.from({ length: below(5) }, (_, n) => step(`n${n}`, below(100) < pointerPercent ? (below(100) < 85 ? ids[below(count)] : 't_removed') : ''));
      return [id, tree(nodes, nodes.filter(() => below(100) < markPercent).map((node) => node.id))];
    }));
    const index = new Map(ids.map((id, t) => [id, t]));
    const stepDone = (among, id, node) => (index.has(node.opens) ? ((among >> index.get(node.opens)) & 1) === 1 : trees[id].completed.has(node.id));
    let least = (1 << count) - 1;
    for (let among = 0; among < 1 << count; among += 1) {
      const closed = ids.every((id, t) => {
        const complete = trees[id].nodes.length > 0 && trees[id].nodes.every((node) => stepDone(among, id, node));
        return !complete || ((among >> t) & 1) === 1;
      });
      if (closed) least &= among;
    }
    const all = judged(trees);
    for (const [t, id] of ids.entries()) {
      if (all.complete.has(id) !== (((least >> t) & 1) === 1)) disagreements += 1;
      const done = trees[id].nodes.filter((node) => stepDone(least, id, node)).length;
      if (all.progressOf(id).done !== done) disagreements += 1;
    }
  }
  assert.equal(disagreements, 0);
});
