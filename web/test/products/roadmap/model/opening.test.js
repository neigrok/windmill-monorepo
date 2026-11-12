import test from 'node:test';
import assert from 'node:assert/strict';

import { Opening, Openings } from '../../../../src/products/roadmap/model/Opening.js';

const facts = (opening) => ({ ...opening, dangling: opening.dangling, face: opening.face, gauge: opening.gauge });

test('an opening is built from each shape the server answers', () => {
  const read = {
    open: Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false }),
    complete: Opening.fromWire({ treeId: 't_read', title: 'Reading list', state: 'complete', done: 12, total: 12, loop: false }),
    loop: Opening.fromWire({ treeId: 't_loop', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true }),
    empty: Opening.fromWire({ treeId: 't_book', title: 'Book draft', state: 'open', done: 0, total: 0, loop: false }),
    missing: Opening.fromWire({ treeId: 't_bike', missing: true }),
  };

  assert.deepEqual(Object.fromEntries(Object.entries(read).map(([name, opening]) => [name, facts(opening)])), {
    open: { treeId: 't_sail', read: true, valid: true, complete: false, title: 'Learn to sail', done: 3, total: 8, loop: false, dangling: false, face: 'open', gauge: 3 / 8 },
    complete: { treeId: 't_read', read: true, valid: true, complete: true, title: 'Reading list', done: 12, total: 12, loop: false, dangling: false, face: 'complete', gauge: 1 },
    loop: { treeId: 't_loop', read: true, valid: true, complete: false, title: 'Learn to sail', done: 3, total: 8, loop: true, dangling: false, face: 'loop', gauge: 3 / 8 },
    empty: { treeId: 't_book', read: true, valid: true, complete: false, title: 'Book draft', done: 0, total: 0, loop: false, dangling: false, face: 'empty', gauge: 0 },
    missing: { treeId: 't_bike', read: true, valid: false, complete: false, title: '', done: 0, total: 0, loop: false, dangling: true, face: 'missing', gauge: null },
  });
});

test('a pointer with no facts read is unread: it names its tree and claims nothing else', () => {
  assert.deepEqual(facts(Opening.unread('t_sail')), {
    treeId: 't_sail', read: false, valid: false, complete: false, title: '', done: 0, total: 0, loop: false, dangling: false, face: 'unread', gauge: null,
  });
});

test('the tree is named beside the step only where its title says more', () => {
  const opening = Opening.fromWire({ treeId: 't_coast', title: 'Coast trip', state: 'open', done: 0, total: 5, loop: false });

  assert.equal(opening.titleBeside({ label: 'Sail the coast' }), 'Coast trip');
  assert.equal(opening.titleBeside({ label: 'Coast trip' }), null);
  assert.equal(Opening.unread('t_coast').titleBeside({ label: 'Sail the coast' }), null);
});

test('a projection takes its openings by the pointer each step holds now', () => {
  const openings = Openings.fromWire({
    sail: { treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false },
    read: { treeId: 't_old', title: 'Old list', state: 'complete', done: 2, total: 2, loop: false },
    gone: { treeId: 't_gone', missing: true },
  });
  const projection = { id: 't_year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail' },
    { id: 'read', label: 'Read more', prerequisites: ['plan'], opens: 't_new' },
    { id: 'gone', label: 'Fix the bike', prerequisites: ['plan'] },
    { id: 'late', label: 'Write the book', prerequisites: ['plan'], opens: 't_book' },
  ] };

  assert.deepEqual(openings.onto(projection), { id: 't_year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail', opening: openings.byStep.get('sail') },
    { id: 'read', label: 'Read more', prerequisites: ['plan'], opens: 't_new', opening: Opening.unread('t_new') },
    { id: 'gone', label: 'Fix the bike', prerequisites: ['plan'] },
    { id: 'late', label: 'Write the book', prerequisites: ['plan'], opens: 't_book', opening: Opening.unread('t_book') },
  ] });
});

test('an answer with no openings leaves a reader’s projection as it came', () => {
  const projection = { id: 't_year', title: 'My year', nodes: [{ id: 'sail', label: 'Learn to sail', prerequisites: [] }] };

  assert.deepEqual(Openings.fromWire(undefined).onto(projection), projection);
});
