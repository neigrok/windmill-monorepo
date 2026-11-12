import test from 'node:test';
import assert from 'node:assert/strict';
import { guidesAbove, namedAbove } from '../../../../src/products/roadmap/guide/GuidesAbove.js';

test('the guides above are the reply’s in its order, farthest first, without the tree’s own', () => {
  const reply = { guides: [
    { treeId: 't_life', title: 'My life', text: 'Health first.', yours: true },
    { treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true },
    { treeId: 't_sail', title: 'Learn to sail', text: 'Sundays on the water.', yours: true },
  ] };

  assert.deepEqual(guidesAbove(reply, { treeId: 't_sail', untitled: 'Untitled roadmap' }), [
    { treeId: 't_life', title: 'My life', text: 'Health first.' },
    { treeId: 't_year', title: 'My year', text: 'Three things this year.' },
  ]);
});

test('a tree with no guide of its own still has those above it, and a tree with nothing above has none', () => {
  const above = { guides: [{ treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true }] };
  const alone = { guides: [{ treeId: 't_reading', title: 'Reading list', text: 'One book a month.', yours: true }] };

  assert.deepEqual(guidesAbove(above, { treeId: 't_coast', untitled: 'Untitled roadmap' }), [{ treeId: 't_year', title: 'My year', text: 'Three things this year.' }]);
  assert.deepEqual(guidesAbove(alone, { treeId: 't_reading', untitled: 'Untitled roadmap' }), []);
  assert.deepEqual(guidesAbove({ guides: [] }, { treeId: 't_reading', untitled: 'Untitled roadmap' }), []);
});

test('a guide a fork brought with it is shown like the others, an untitled tree takes the roadmap’s word, and line endings are the field’s', () => {
  const reply = { guides: [
    { treeId: 't_forked', title: '  ', text: 'Its author’s note.\r\nKept on the fork.', yours: false },
    { treeId: 't_named', title: ' My year ', text: 'Three things.', yours: true },
    { treeId: 't_nameless', text: 'No title was sent.', yours: true },
  ] };

  assert.deepEqual(guidesAbove(reply, { treeId: 't_sail', untitled: 'Untitled roadmap' }), [
    { treeId: 't_forked', title: 'Untitled roadmap', text: 'Its author’s note.\nKept on the fork.' },
    { treeId: 't_named', title: 'My year', text: 'Three things.' },
    { treeId: 't_nameless', title: 'Untitled roadmap', text: 'No title was sent.' },
  ]);
});

test('a reply that is not the route’s shape holds nothing above, and an entry that is not a guide with words is left out', () => {
  const options = { treeId: 't_sail', untitled: 'Untitled roadmap' };
  for (const reply of [null, undefined, {}, { guides: null }, { guides: 'My life' }, { guides: { treeId: 't_life' } }]) {
    assert.deepEqual(guidesAbove(reply, options), []);
  }
  const reply = { guides: [
    null,
    'Health first.',
    { title: 'No id', text: 'Health first.' },
    { treeId: 7, title: 'A number', text: 'Health first.' },
    { treeId: 't_blank', title: 'Blank', text: ' \n ' },
    { treeId: 't_textless', title: 'No text' },
    { treeId: 't_life', title: 'My life', text: 'Health first.' },
  ] };
  assert.deepEqual(guidesAbove(reply, options), [{ treeId: 't_life', title: 'My life', text: 'Health first.' }]);
});

test('the line names the two farthest trees and counts the rest', () => {
  const above = (...titles) => titles.map((title) => ({ treeId: `t_${title}`, title, text: 'A guide.' }));

  assert.deepEqual(namedAbove(above('My life')), { first: 'My life', second: null, more: 0 });
  assert.deepEqual(namedAbove(above('My life', 'My year')), { first: 'My life', second: 'My year', more: 0 });
  assert.deepEqual(namedAbove(above('My life', 'My year', 'Learn to sail')), { first: 'My life', second: 'My year', more: 1 });
  assert.deepEqual(namedAbove(above('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H')), { first: 'A', second: 'B', more: 6 });
  assert.deepEqual(namedAbove([]), { first: null, second: null, more: 0 });
});
