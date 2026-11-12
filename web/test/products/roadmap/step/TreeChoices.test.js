import test from 'node:test';
import assert from 'node:assert/strict';

import { TreeChoices, pastedTreeId } from '../../../../src/products/roadmap/step/TreeChoices.js';

const rows = () => [
  { id: 't_sail', title: 'Learn to sail', done: 3, total: 8 },
  { id: 't_read', title: 'Reading list', done: 12, total: 12 },
  { id: 't_coast', title: 'Coast trip', done: 0, total: 5 },
];
const facts = (choices) => ({
  shown: choices.shown.map((row) => row.id), chosen: choices.chosen, attachable: choices.attachable, count: choices.count,
  searched: choices.searched, address: choices.address, unresolved: choices.unresolved, failed: choices.failed,
  blocked: choices.blocked?.id ?? null, outcome: choices.outcome,
});
const quiet = { searched: false, address: null, unresolved: false, failed: false, blocked: null, outcome: null };

test('pastedTreeId — an app address and a share address name their roadmap, with or without a host, a scheme or a step', () => {
  assert.deepEqual([
    'https://windmill.works/#/app/t_0123456789abcdef',
    'windmill.works/#/app/t_0123456789abcdef?step=rig',
    '#/app/t_0123456789abcdef',
    'https://windmill.works/t/t_0123456789abcdef',
    'windmill.works/t/reefing-course',
    '  http://localhost:5173/t/t_0123456789abcdef  ',
    'https://windmill.works/#/t/t_0123456789abcdef',
    'https://windmill.works/t/caf%C3%A9',
  ].map(pastedTreeId), [
    't_0123456789abcdef', 't_0123456789abcdef', 't_0123456789abcdef', 't_0123456789abcdef', 'reefing-course',
    't_0123456789abcdef', 't_0123456789abcdef', 'café',
  ]);
});

test('pastedTreeId — a title, a bare id, the planting doors and a broken escape name none', () => {
  assert.deepEqual([
    'Learn to sail', 't_0123456789abcdef', '', 'a / t / b', 'https://windmill.works/#/app/new', '#/app/start',
    'https://windmill.works/#/app/', 'https://windmill.works/t/%', 'windmill.works/t/a b', 'see windmill.works/t/abc',
  ].map(pastedTreeId), [null, null, null, null, null, null, null, null, null, null]);
});

test('a step with no tree: every row, none chosen, and Attach waits for a choice', () => {
  const choices = new TreeChoices({ rows: rows() });

  assert.deepEqual(facts(choices), { ...quiet, shown: ['t_sail', 't_read', 't_coast'], chosen: '', attachable: false, count: 3 });
  assert.equal(choices.chosenRow, null);
  assert.deepEqual(facts(choices.choose('t_read')), { ...quiet, shown: ['t_sail', 't_read', 't_coast'], chosen: 't_read', attachable: true, count: 3 });
  assert.deepEqual(choices.choose('t_read').chosenRow, { id: 't_read', title: 'Reading list', done: 12, total: 12 });
  assert.equal(choices.choose('t_gone').chosen, '', 'a roadmap that is not a row is no choice');
});

test('Change tree: the tree the step opens arrives chosen, and Attach waits for a different one', () => {
  const choices = new TreeChoices({ rows: rows(), standing: 't_sail' });

  assert.deepEqual({ chosen: choices.chosen, attachable: choices.attachable }, { chosen: 't_sail', attachable: false });
  assert.deepEqual({ chosen: choices.choose('t_coast').chosen, attachable: choices.choose('t_coast').attachable }, { chosen: 't_coast', attachable: true });
  assert.equal(choices.choose('t_coast').choose('t_sail').attachable, false);
  const gone = new TreeChoices({ rows: rows(), standing: 't_deleted' });
  assert.deepEqual({ chosen: gone.chosen, attachable: gone.attachable }, { chosen: '', attachable: false });
});

test('Find a tree narrows by title as the prerequisites picker does: any case, anywhere, spaces trimmed, the choice kept', () => {
  const choices = new TreeChoices({ rows: rows() }).choose('t_coast');

  assert.deepEqual(facts(choices.search('  SAIL ')), { ...quiet, searched: true, shown: ['t_sail'], chosen: 't_coast', attachable: true, count: 1 });
  assert.deepEqual(facts(choices.search('i')), { ...quiet, searched: true, shown: ['t_sail', 't_read', 't_coast'], chosen: 't_coast', attachable: true, count: 3 });
  assert.deepEqual(facts(choices.search('bike')), { ...quiet, searched: true, shown: [], chosen: 't_coast', attachable: true, count: 0 });
  assert.deepEqual(facts(choices.search('bike').search('')), { ...quiet, shown: ['t_sail', 't_read', 't_coast'], chosen: 't_coast', attachable: true, count: 3 });
});

test('a pasted address of one of the person’s own roadmaps selects its row, with no read', () => {
  const choices = new TreeChoices({ rows: rows() }).search('https://windmill.works/#/app/t_read');

  assert.deepEqual(facts(choices), { shown: ['t_read'], chosen: 't_read', attachable: true, count: 1, searched: true,
    address: 't_read', unresolved: false, failed: false, blocked: null, outcome: 'own' });
  assert.deepEqual(facts(choices.search('')), { ...quiet, shown: ['t_sail', 't_read', 't_coast'], chosen: 't_read', attachable: true, count: 3 });
});

test('a pasted address of a roadmap the person can only read waits for its read, then is the one blocked row', () => {
  const pasted = new TreeChoices({ rows: rows() }).choose('t_sail').search('windmill.works/t/t_reef');
  assert.deepEqual(facts(pasted), { shown: [], chosen: 't_sail', attachable: true, count: 0, searched: true,
    address: 't_reef', unresolved: true, failed: false, blocked: null, outcome: null });

  const card = { id: 't_reef', title: 'Reefing course', author: null, steps: 4, mine: false };
  const read = pasted.resolved({ id: 't_reef', card });
  assert.deepEqual(facts(read), { shown: [], chosen: 't_sail', attachable: true, count: 1, searched: true,
    address: 't_reef', unresolved: false, failed: false, blocked: 't_reef', outcome: 'readable' });
  assert.equal(read.blocked, card);
});

test('a pasted address that names no roadmap the person can read says so, and one whose read failed says that instead', () => {
  const pasted = new TreeChoices({ rows: rows() }).search('windmill.works/t/t_private');

  assert.deepEqual(facts(pasted.resolved({ id: 't_private', card: null })), { shown: [], chosen: '', attachable: false, count: 0, searched: true,
    address: 't_private', unresolved: false, failed: false, blocked: null, outcome: 'unreadable' });
  assert.deepEqual(facts(pasted.resolved({ id: 't_private', failed: true })), { shown: [], chosen: '', attachable: false, count: 0, searched: true,
    address: 't_private', unresolved: false, failed: true, blocked: null, outcome: null });
});

test('a pasted address of the person’s own roadmap that is not a row, as the one they are in, is theirs and lists nothing', () => {
  const pasted = new TreeChoices({ rows: rows() }).search('#/app/t_year');
  const read = pasted.resolved({ id: 't_year', card: { id: 't_year', title: 'My year', author: null, steps: 6, mine: true } });

  assert.deepEqual(facts(read), { shown: [], chosen: '', attachable: false, count: 0, searched: true,
    address: 't_year', unresolved: false, failed: false, blocked: null, outcome: 'own' });
});

test('a read that answers for an address since replaced is dropped, and typing on keeps the one that still fits', () => {
  const card = { id: 't_reef', title: 'Reefing course', author: null, steps: 4, mine: false };
  const first = new TreeChoices({ rows: rows() }).search('windmill.works/t/t_reef');
  const moved = first.search('windmill.works/t/t_other').resolved({ id: 't_reef', card });

  assert.deepEqual({ blocked: moved.blocked, unresolved: moved.unresolved }, { blocked: null, unresolved: true });
  const kept = first.resolved({ id: 't_reef', card }).search('https://windmill.works/t/t_reef');
  assert.deepEqual({ blocked: kept.blocked?.id, unresolved: kept.unresolved }, { blocked: 't_reef', unresolved: false });
  assert.equal(first.resolved({ id: 't_reef', card }).search('reef').blocked, null);
});

test('after a fork the list is read again: the copy is a row to choose, the search is over and nothing was chosen for the person', () => {
  const card = { id: 't_reef', title: 'Reefing course', author: null, steps: 4, mine: false };
  const blocked = new TreeChoices({ rows: rows(), standing: 't_sail' }).search('windmill.works/t/t_reef').resolved({ id: 't_reef', card });
  const listed = blocked.listed([{ id: 't_copy', title: 'Reefing course', done: 0, total: 4 }, ...rows()]);

  assert.deepEqual(facts(listed), { ...quiet, shown: ['t_copy', 't_sail', 't_read', 't_coast'], chosen: 't_sail', attachable: false, count: 4 });
  assert.equal(new TreeChoices({ rows: rows() }).choose('t_coast').listed(rows().slice(0, 2)).chosen, '', 'a chosen row the new list lacks is no choice');
});
