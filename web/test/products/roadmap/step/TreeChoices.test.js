import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TreeChoices, pastedTreeId } from '../../../../src/products/roadmap/step/TreeChoices.js';

const SAIL = 't_5a11000000000001';
const READ = 't_7ead000000000002';
const COAST = 't_c0a5000000000003';
const REEF = 't_7eef000000000004';
const rows = () => [
  { id: SAIL, title: 'Learn to sail', done: 3, total: 8 },
  { id: READ, title: 'Reading list', done: 12, total: 12 },
  { id: COAST, title: 'Coast trip', done: 0, total: 5 },
];
const facts = (choices) => ({
  shown: choices.shown.map((row) => row.id), chosen: choices.chosen, attachable: choices.attachable, count: choices.count,
  searched: choices.searched, address: choices.address, unresolved: choices.unresolved, failed: choices.failed,
  blocked: choices.blocked?.id ?? null, outcome: choices.outcome,
});
const quiet = { searched: false, address: null, unresolved: false, failed: false, blocked: null, outcome: null };

const ORIGIN = 'https://windmill.works';

test('pastedTreeId — this app’s share and app addresses name their roadmap, with or without the scheme, a step or the space around them, and so does a bare tree id', () => {
  assert.deepEqual([
    'https://windmill.works/t/t_0123456789abcdef',
    'https://windmill.works/#/app/t_0123456789abcdef',
    'https://windmill.works/#/app/t_0123456789abcdef?step=rig',
    'https://windmill.works/t/t_0123456789abcdef#?step=rig',
    'windmill.works/t/t_0123456789abcdef',
    '  https://windmill.works/t/t_0123456789abcdef\n',
    't_0123456789abcdef',
    ' t_fedcba9876543210 ',
  ].map((text) => pastedTreeId(text, ORIGIN)), Array.from({ length: 8 }, (_, index) => (index === 7 ? 't_fedcba9876543210' : 't_0123456789abcdef')));
  assert.equal(pastedTreeId('http://localhost:5198/t/t_0123456789abcdef', 'http://localhost:5198'), 't_0123456789abcdef');
});

test('pastedTreeId names the roadmap of every address the backend builds for a roadmap or a step (packages/api-contract/roadmap-addresses.json)', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/roadmap-addresses.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    cases.map((one) => `${one.address} ${pastedTreeId(`${ORIGIN}${one.address}`, ORIGIN)}`),
    cases.map((one) => `${one.address} ${one.treeId}`),
  );
});

test('pastedTreeId — another site’s address, a path that only looks like one, an id of another form and an address still being typed name none', () => {
  assert.deepEqual([
    'https://example.com/t/my-secret-plan',
    'https://example.com/t/t_0123456789abcdef',
    'notes/t/dentist',
    'http://windmill.works/t/t_0123456789abcdef',
    'https://windmill.works.example.com/t/t_0123456789abcdef',
    'https://windmill.works/t/reefing-course',
    'https://windmill.works/t/t_0123456789ABCDEF',
    'https://windmill.works/t/t_0123456789abcde',
    'https://windmill.works/t/t_0123456789abcdef0',
    'https://windmill.works/#/app/new',
    '#/app/t_0123456789abcdef',
    'https://windmill.works/#/t/t_0123456789abcdef',
    'Learn to sail',
    't_0123',
    '',
    'see https://windmill.works/t/t_0123456789abcdef',
  ].map((text) => pastedTreeId(text, ORIGIN)), Array.from({ length: 16 }, () => null));
});

test('typing an address one key at a time names a roadmap only once it is whole', () => {
  const typed = 'windmill.works/t/t_1b9df66035a7c047';
  const named = new Set();
  let choices = new TreeChoices({ rows: [], origin: ORIGIN });
  for (let i = 1; i <= typed.length; i += 1) {
    choices = choices.search(typed.slice(0, i));
    if (choices.address) named.add(choices.address);
  }
  assert.deepEqual([...named], ['t_1b9df66035a7c047']);
  assert.deepEqual(new TreeChoices({ rows: rows(), origin: ORIGIN }).search('https://example.com/t/my-secret-plan').shown, [], 'text that is no address only filters');
});

test('a step with no tree: every row, none chosen, and Attach waits for a choice', () => {
  const choices = new TreeChoices({ rows: rows(), origin: ORIGIN });

  assert.deepEqual(facts(choices), { ...quiet, shown: [SAIL, READ, COAST], chosen: '', attachable: false, count: 3 });
  assert.equal(choices.chosenRow, null);
  assert.deepEqual(facts(choices.choose(READ)), { ...quiet, shown: [SAIL, READ, COAST], chosen: READ, attachable: true, count: 3 });
  assert.deepEqual(choices.choose(READ).chosenRow, { id: READ, title: 'Reading list', done: 12, total: 12 });
  assert.equal(choices.choose('t_0000000000000000').chosen, '', 'a roadmap that is not a row is no choice');
});

test('Change tree: the tree the step opens arrives chosen, and Attach waits for a different one', () => {
  const choices = new TreeChoices({ rows: rows(), standing: SAIL, origin: ORIGIN });

  assert.deepEqual({ chosen: choices.chosen, attachable: choices.attachable }, { chosen: SAIL, attachable: false });
  assert.deepEqual({ chosen: choices.choose(COAST).chosen, attachable: choices.choose(COAST).attachable }, { chosen: COAST, attachable: true });
  assert.equal(choices.choose(COAST).choose(SAIL).attachable, false);
  const gone = new TreeChoices({ rows: rows(), standing: 't_0000000000000000', origin: ORIGIN });
  assert.deepEqual({ chosen: gone.chosen, attachable: gone.attachable }, { chosen: '', attachable: false });
});

test('Find a tree narrows by title as the prerequisites picker does, and Attach acts only while the chosen row is on screen', () => {
  const choices = new TreeChoices({ rows: rows(), origin: ORIGIN }).choose(COAST);

  assert.deepEqual(facts(choices.search('  SAIL ')), { ...quiet, searched: true, shown: [SAIL], chosen: COAST, attachable: false, count: 1 });
  assert.deepEqual(facts(choices.search('i')), { ...quiet, searched: true, shown: [SAIL, READ, COAST], chosen: COAST, attachable: true, count: 3 });
  assert.deepEqual(facts(choices.search('bike')), { ...quiet, searched: true, shown: [], chosen: COAST, attachable: false, count: 0 });
  assert.deepEqual(facts(choices.search('bike').search('')), { ...quiet, shown: [SAIL, READ, COAST], chosen: COAST, attachable: true, count: 3 });
});

test('a pasted address of one of the person’s own roadmaps selects its row, with no read', () => {
  const choices = new TreeChoices({ rows: rows(), origin: ORIGIN }).search(`https://windmill.works/#/app/${READ}`);

  assert.deepEqual(facts(choices), { shown: [READ], chosen: READ, attachable: true, count: 1, searched: true,
    address: READ, unresolved: false, failed: false, blocked: null, outcome: 'own' });
  assert.deepEqual(facts(choices.search('')), { ...quiet, shown: [SAIL, READ, COAST], chosen: READ, attachable: true, count: 3 });
});

test('a pasted address of a roadmap the person can only read waits for its read, then is the one blocked row, with nothing to attach', () => {
  const pasted = new TreeChoices({ rows: rows(), origin: ORIGIN }).choose(SAIL).search(`windmill.works/t/${REEF}`);
  assert.deepEqual(facts(pasted), { shown: [], chosen: SAIL, attachable: false, count: 0, searched: true,
    address: REEF, unresolved: true, failed: false, blocked: null, outcome: null });

  const card = { id: REEF, title: 'Reefing course', author: null, steps: 4, mine: false };
  const read = pasted.resolved({ id: REEF, card });
  assert.deepEqual(facts(read), { shown: [], chosen: SAIL, attachable: false, count: 1, searched: true,
    address: REEF, unresolved: false, failed: false, blocked: REEF, outcome: 'readable' });
  assert.equal(read.blocked, card);
});

test('a pasted address that names no roadmap the person can read says so; one whose read failed keeps the reason, and neither arms Attach', () => {
  const pasted = new TreeChoices({ rows: rows(), origin: ORIGIN }).choose(SAIL).search('t_0000000000000009');

  assert.deepEqual(facts(pasted.resolved({ id: 't_0000000000000009', card: null })), { shown: [], chosen: SAIL, attachable: false, count: 0, searched: true,
    address: 't_0000000000000009', unresolved: false, failed: false, blocked: null, outcome: 'unreadable' });
  const failed = pasted.resolved({ id: 't_0000000000000009', failed: true, reason: 'server' });
  assert.deepEqual(facts(failed), { shown: [], chosen: SAIL, attachable: false, count: 0, searched: true,
    address: 't_0000000000000009', unresolved: false, failed: true, blocked: null, outcome: null });
  assert.equal(failed.pasted.reason, 'server');
  assert.deepEqual(facts(failed.search('')), { ...quiet, shown: [SAIL, READ, COAST], chosen: SAIL, attachable: true, count: 3 }, 'the list is as it was');
});

test('a pasted address of the person’s own roadmap that is not a row, as the one they are in, is theirs and lists nothing', () => {
  const year = 't_9ea7000000000005';
  const read = new TreeChoices({ rows: rows(), origin: ORIGIN }).search(year).resolved({ id: year, card: { id: year, title: 'My year', author: null, steps: 6, mine: true } });

  assert.deepEqual(facts(read), { shown: [], chosen: '', attachable: false, count: 0, searched: true,
    address: year, unresolved: false, failed: false, blocked: null, outcome: 'own' });
});

test('a read that answers for an address since replaced is dropped, and an address typed again keeps the one that still fits', () => {
  const card = { id: REEF, title: 'Reefing course', author: null, steps: 4, mine: false };
  const first = new TreeChoices({ rows: rows(), origin: ORIGIN }).search(`windmill.works/t/${REEF}`);
  const moved = first.search('windmill.works/t/t_0000000000000008').resolved({ id: REEF, card });

  assert.deepEqual({ blocked: moved.blocked, unresolved: moved.unresolved }, { blocked: null, unresolved: true });
  const kept = first.resolved({ id: REEF, card }).search(`https://windmill.works/t/${REEF}`);
  assert.deepEqual({ blocked: kept.blocked?.id, unresolved: kept.unresolved }, { blocked: REEF, unresolved: false });
  assert.equal(first.resolved({ id: REEF, card }).search('reef').blocked, null);
});

test('after a fork the list is read again: the copy is a row to choose, the search is over and nothing was chosen for the person', () => {
  const copy = 't_c09e000000000006';
  const card = { id: REEF, title: 'Reefing course', author: null, steps: 4, mine: false };
  const blocked = new TreeChoices({ rows: rows(), standing: SAIL, origin: ORIGIN }).search(`windmill.works/t/${REEF}`).resolved({ id: REEF, card });
  const listed = blocked.listed([{ id: copy, title: 'Reefing course', done: 0, total: 4 }, ...rows()]);

  assert.deepEqual(facts(listed), { ...quiet, shown: [copy, SAIL, READ, COAST], chosen: SAIL, attachable: false, count: 4 });
  assert.equal(new TreeChoices({ rows: rows(), origin: ORIGIN }).choose(COAST).listed(rows().slice(0, 2)).chosen, '', 'a chosen row the new list lacks is no choice');
});
