import test from 'node:test';
import assert from 'node:assert/strict';

import { deleteCost, withoutTree } from '../../../../src/products/roadmap/identity/deleteCost.js';

test('a row from a server that sends no openers, and one whose openers are empty, have nothing more to say', () => {
  const rows = [{ id: 't_sail', title: 'Learn to sail' }, { id: 't_year', title: 'My year' }];
  assert.equal(deleteCost({ id: 't_sail', title: 'Learn to sail' }, rows, { untitled: 'Untitled roadmap' }), null);
  assert.equal(deleteCost({ id: 't_sail', title: 'Learn to sail', openers: [] }, rows, { untitled: 'Untitled roadmap' }), null);
  assert.equal(deleteCost({ id: 't_sail', title: 'Learn to sail', openers: null }, rows, { untitled: 'Untitled roadmap' }), null);
});

test('each form of the line: one tree, with one step or several, two trees, and more than two', () => {
  const rows = [
    { id: 't_life', title: 'My life' }, { id: 't_year', title: 'My year' }, { id: 't_summer', title: 'Summer plans' },
    { id: 't_coast', title: 'Coast trip' }, { id: 't_read', title: 'Reading list' },
  ];
  const cost = (openers) => deleteCost({ id: 't_sail', openers }, rows, { untitled: 'Untitled roadmap' });

  assert.deepEqual(cost([{ treeId: 't_year', steps: 1 }]), { form: 'one', steps: 1, tree: 'My year' });
  assert.deepEqual(cost([{ treeId: 't_summer', steps: 2 }]), { form: 'one', steps: 2, tree: 'Summer plans' });
  assert.deepEqual(cost([{ treeId: 't_year', steps: 1 }, { treeId: 't_summer', steps: 1 }]),
    { form: 'two', steps: 2, first: 'My year', second: 'Summer plans' });
  assert.deepEqual(cost([{ treeId: 't_life', steps: 1 }, { treeId: 't_summer', steps: 1 }, { treeId: 't_coast', steps: 1 }, { treeId: 't_read', steps: 1 }]),
    { form: 'more', steps: 4, first: 'My life', second: 'Summer plans', more: 2 });
  assert.deepEqual(cost([{ treeId: 't_life', steps: 3 }, { treeId: 't_summer', steps: 1 }, { treeId: 't_coast', steps: 2 }]),
    { form: 'more', steps: 6, first: 'My life', second: 'Summer plans', more: 1 });
});

test('the trees named are the first two openers in the menu’s order, whatever order the server sent them in', () => {
  const rows = [{ id: 't_sail', title: 'Learn to sail' }, { id: 't_coast', title: 'Coast trip' }, { id: 't_year', title: 'My year' }, { id: 't_life', title: 'My life' }];
  const openers = [{ treeId: 't_life', steps: 1 }, { treeId: 't_year', steps: 2 }, { treeId: 't_coast', steps: 1 }];
  assert.deepEqual(deleteCost({ id: 't_sail', openers }, rows, { untitled: 'Untitled roadmap' }),
    { form: 'more', steps: 4, first: 'Coast trip', second: 'My year', more: 1 });
});

test('an opener titled with nothing reads as the switcher names it, trimmed', () => {
  const rows = [{ id: 't_blank', title: '   ' }, { id: 't_none' }, { id: 't_year', title: '  My year ' }];
  assert.deepEqual(deleteCost({ id: 't_sail', openers: [{ treeId: 't_none', steps: 1 }] }, rows, { untitled: 'Untitled roadmap' }),
    { form: 'one', steps: 1, tree: 'Untitled roadmap' });
  assert.deepEqual(deleteCost({ id: 't_sail', openers: [{ treeId: 't_year', steps: 1 }, { treeId: 't_blank', steps: 1 }] }, rows, { untitled: 'Untitled roadmap' }),
    { form: 'two', steps: 2, first: 'Untitled roadmap', second: 'My year' });
});

test('an opener the list does not hold is counted among the trees and never named', () => {
  const rows = [{ id: 't_year', title: 'My year' }, { id: 't_summer', title: 'Summer plans' }];
  const cost = (openers) => deleteCost({ id: 't_sail', openers }, rows, { untitled: 'Untitled roadmap' });

  assert.deepEqual(cost([{ treeId: 't_gone', steps: 2 }, { treeId: 't_summer', steps: 1 }, { treeId: 't_year', steps: 1 }]),
    { form: 'more', steps: 4, first: 'My year', second: 'Summer plans', more: 1 }, 'beyond the first two it is one of the more');
  assert.deepEqual(cost([{ treeId: 't_gone', steps: 1 }]), { form: 'unnamed', steps: 1, trees: 1 });
  assert.deepEqual(cost([{ treeId: 't_year', steps: 1 }, { treeId: 't_gone', steps: 2 }]), { form: 'unnamed', steps: 3, trees: 2 });
  assert.deepEqual(cost([{ treeId: 't_gone', steps: 1 }, { treeId: 't_lost', steps: 1 }, { treeId: 't_year', steps: 1 }]),
    { form: 'unnamed', steps: 3, trees: 3 });
});

test('once a tree is deleted the list holds neither its row nor its place among the openers of the rows left', () => {
  const rows = [
    { id: 't_year', title: 'My year', openers: [] },
    { id: 't_sail', title: 'Learn to sail', openers: [{ treeId: 't_year', steps: 1 }, { treeId: 't_summer', steps: 2 }] },
    { id: 't_summer', title: 'Summer plans', openers: [{ treeId: 't_sail', steps: 1 }] },
    { id: 't_local', title: 'On this device', origin: 'device' },
  ];
  assert.deepEqual(withoutTree(rows, 't_summer'), [
    { id: 't_year', title: 'My year', openers: [] },
    { id: 't_sail', title: 'Learn to sail', openers: [{ treeId: 't_year', steps: 1 }] },
    { id: 't_local', title: 'On this device', origin: 'device' },
  ]);
  const left = withoutTree(rows, 't_year');
  assert.deepEqual(deleteCost(left.find((row) => row.id === 't_sail'), left, { untitled: 'Untitled roadmap' }),
    { form: 'one', steps: 2, tree: 'Summer plans' }, 'the steps that went with My year are not counted again');
});
