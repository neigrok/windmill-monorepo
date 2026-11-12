import test from 'node:test';
import assert from 'node:assert/strict';
import { guidesAbove, namedAbove, readFailureReason } from '../../../../src/products/roadmap/guide/GuidesAbove.js';

test('the guides above are the reply’s in its order, farthest first, without the tree’s own', () => {
  const reply = { guides: [
    { treeId: 't_life', title: 'My life', text: 'Health first.', yours: true },
    { treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true },
    { treeId: 't_sail', title: 'Learn to sail', text: 'Sundays on the water.', yours: true },
  ] };

  assert.deepEqual(guidesAbove(reply, { treeId: 't_sail', untitled: 'Untitled roadmap' }), { shaped: true, above: [
    { treeId: 't_life', title: 'My life', text: 'Health first.' },
    { treeId: 't_year', title: 'My year', text: 'Three things this year.' },
  ] });
});

test('a tree with no guide of its own still has those above it, and a tree with nothing above has none', () => {
  const above = { guides: [{ treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true }] };
  const alone = { guides: [{ treeId: 't_reading', title: 'Reading list', text: 'One book a month.', yours: true }] };

  assert.deepEqual(guidesAbove(above, { treeId: 't_coast', untitled: 'Untitled roadmap' }), { shaped: true, above: [{ treeId: 't_year', title: 'My year', text: 'Three things this year.' }] });
  assert.deepEqual(guidesAbove(alone, { treeId: 't_reading', untitled: 'Untitled roadmap' }), { shaped: true, above: [] });
  assert.deepEqual(guidesAbove({ guides: [] }, { treeId: 't_reading', untitled: 'Untitled roadmap' }), { shaped: true, above: [] });
});

test('a guide a fork brought with it is shown like the others, an untitled tree takes the roadmap’s word, and line endings are the field’s', () => {
  const reply = { guides: [
    { treeId: 't_forked', title: '  ', text: 'Its author’s note.\r\nKept on the fork.', yours: false },
    { treeId: 't_named', title: ' My year ', text: 'Three things.', yours: true },
    { treeId: 't_nameless', text: 'No title was sent.', yours: true },
    { treeId: 't_numbered', title: 7, text: 'A title that is no string.', yours: true },
  ] };

  assert.deepEqual(guidesAbove(reply, { treeId: 't_sail', untitled: 'Untitled roadmap' }), { shaped: true, above: [
    { treeId: 't_forked', title: 'Untitled roadmap', text: 'Its author’s note.\nKept on the fork.' },
    { treeId: 't_named', title: 'My year', text: 'Three things.' },
    { treeId: 't_nameless', title: 'Untitled roadmap', text: 'No title was sent.' },
    { treeId: 't_numbered', title: 'Untitled roadmap', text: 'A title that is no string.' },
  ] });
});

test('a tree answered twice stands once, where it stood farthest, the tree’s own is left out wherever it stands, and a guide with no words is none', () => {
  const own = { treeId: 't_sail', title: 'Learn to sail', text: 'Own.', yours: true };
  const life = { treeId: 't_life', title: 'My life', text: 'Health first.', yours: true };
  const year = { treeId: 't_year', title: 'My year', text: 'Three things.', yours: true };
  const options = { treeId: 't_sail', untitled: 'Untitled roadmap' };

  assert.deepEqual(guidesAbove({ guides: [life, year, { ...life, text: 'Said again, nearer.' }, own] }, options), { shaped: true, above: [
    { treeId: 't_life', title: 'My life', text: 'Health first.' },
    { treeId: 't_year', title: 'My year', text: 'Three things.' },
  ] });
  assert.deepEqual(guidesAbove({ guides: [own, life, own] }, options), { shaped: true, above: [{ treeId: 't_life', title: 'My life', text: 'Health first.' }] });
  assert.deepEqual(guidesAbove({ guides: [{ treeId: 't_twin', title: 'Learn to sail', text: 'Another tree of that name.' }, own] }, options),
    { shaped: true, above: [{ treeId: 't_twin', title: 'Learn to sail', text: 'Another tree of that name.' }] });
  assert.deepEqual(guidesAbove({ guides: [{ treeId: 't_blank', title: 'Blank', text: ' \n ' }, life] }, options), { shaped: true, above: [{ treeId: 't_life', title: 'My life', text: 'Health first.' }] });
});

test('a body that holds no array of guides is not the contract’s shape and holds nothing above', () => {
  const options = { treeId: 't_sail', untitled: 'Untitled roadmap' };
  const renamed = { items: [{ treeId: 't_life', title: 'My life', text: 'Health first.', yours: true }] };
  for (const reply of [null, undefined, {}, 7, 'My life', [], { guides: null }, { guides: 'My life' }, { guides: { treeId: 't_life' } }, renamed]) {
    assert.deepEqual(guidesAbove(reply, options), { shaped: false, above: [] }, JSON.stringify(reply));
  }
});

test('an entry without a tree id or a text is not the contract’s shape, and the well-formed guides beside it are still read', () => {
  const options = { treeId: 't_sail', untitled: 'Untitled roadmap' };
  const life = { treeId: 't_life', title: 'My life', text: 'Health first.' };
  for (const odd of [null, 7, 'Health first.', { title: 'No id', text: 'Health first.' }, { treeId: 7, title: 'A number', text: 'Health first.' },
    { treeId: '', title: 'An empty id', text: 'Health first.' }, { treeId: 't_textless', title: 'No text' }, { treeId: 't_listed', title: 'A list', text: ['Health first.'] },
    { tree_id: 't_life', name: 'My life', guide: 'Health first.' }]) {
    assert.deepEqual(guidesAbove({ guides: [odd, life] }, options), { shaped: false, above: [life] }, JSON.stringify(odd));
  }
  assert.deepEqual(guidesAbove({ guides: [null, 7] }, options), { shaped: false, above: [] });
});

test('a failed read says in one word which kind it was', () => {
  assert.equal(readFailureReason({ status: 503, code: 'guides-unavailable' }), 'unavailable');
  assert.equal(readFailureReason({ status: 503 }), 'server');
  assert.equal(readFailureReason({ status: 503, code: 'opens-unavailable' }), 'server');
  assert.equal(readFailureReason({ status: 500, code: 'guides-unavailable' }), 'server');
  assert.equal(readFailureReason({ status: 502 }), 'server');
  assert.equal(readFailureReason({ status: 0, code: 'unreachable' }), 'network');
});

test('the line names the two farthest trees and counts the rest', () => {
  const above = (...titles) => titles.map((title) => ({ treeId: `t_${title}`, title, text: 'A guide.' }));

  assert.deepEqual(namedAbove(above('My life')), { first: 'My life', second: null, more: 0 });
  assert.deepEqual(namedAbove(above('My life', 'My year')), { first: 'My life', second: 'My year', more: 0 });
  assert.deepEqual(namedAbove(above('My life', 'My year', 'Learn to sail')), { first: 'My life', second: 'My year', more: 1 });
  assert.deepEqual(namedAbove(above('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H')), { first: 'A', second: 'B', more: 6 });
  assert.deepEqual(namedAbove([]), { first: null, second: null, more: 0 });
});
