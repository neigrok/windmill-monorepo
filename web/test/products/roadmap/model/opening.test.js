import test from 'node:test';
import assert from 'node:assert/strict';

import { Opening, Openings } from '../../../../src/products/roadmap/model/Opening.js';

const facts = (opening) => ({ ...opening, dangling: opening.dangling, leads: opening.leads, face: opening.face, gauge: opening.gauge });

test('an opening is built from each shape the server answers', () => {
  const read = {
    open: Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false }),
    complete: Opening.fromWire({ treeId: 't_read', title: 'Reading list', state: 'complete', done: 12, total: 12, loop: false }),
    loop: Opening.fromWire({ treeId: 't_loop', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true }),
    empty: Opening.fromWire({ treeId: 't_book', title: 'Book draft', state: 'open', done: 0, total: 0, loop: false }),
    missing: Opening.fromWire({ treeId: 't_bike', missing: true }),
  };

  assert.deepEqual(Object.fromEntries(Object.entries(read).map(([name, opening]) => [name, facts(opening)])), {
    open: { treeId: 't_sail', read: true, valid: true, complete: false, title: 'Learn to sail', done: 3, total: 8, loop: false, own: false, provisional: false, dangling: false, leads: true, face: 'open', gauge: 3 / 8 },
    complete: { treeId: 't_read', read: true, valid: true, complete: true, title: 'Reading list', done: 12, total: 12, loop: false, own: false, provisional: false, dangling: false, leads: true, face: 'complete', gauge: 1 },
    loop: { treeId: 't_loop', read: true, valid: true, complete: false, title: 'Learn to sail', done: 3, total: 8, loop: true, own: false, provisional: false, dangling: false, leads: true, face: 'loop', gauge: 3 / 8 },
    empty: { treeId: 't_book', read: true, valid: true, complete: false, title: 'Book draft', done: 0, total: 0, loop: false, own: false, provisional: false, dangling: false, leads: true, face: 'empty', gauge: 0 },
    missing: { treeId: 't_bike', read: true, valid: false, complete: false, title: '', done: 0, total: 0, loop: false, own: false, provisional: false, dangling: true, leads: false, face: 'missing', gauge: null },
  });
});

test('a pointer with no facts read is unread: it names its tree and claims nothing else', () => {
  assert.deepEqual(facts(Opening.unread('t_sail')), {
    treeId: 't_sail', read: false, valid: false, complete: false, title: '', done: 0, total: 0, loop: false, own: false, provisional: false, dangling: false, leads: true, face: 'unread', gauge: null,
  });
});

test('the tree is named beside the step only where its title says more', () => {
  const opening = Opening.fromWire({ treeId: 't_coast', title: 'Coast trip', state: 'open', done: 0, total: 5, loop: false });

  assert.equal(opening.titleBeside({ label: 'Sail the coast' }), 'Coast trip');
  assert.equal(opening.titleBeside({ label: 'Coast trip' }), null);
  assert.equal(Opening.unread('t_coast').titleBeside({ label: 'Sail the coast' }), null);
});

test('once the projection holds what the server holds, it takes its openings by the pointer each step holds now', () => {
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

  assert.deepEqual(openings.onto(projection, { joined: true }), { id: 't_year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail', opening: openings.byStep.get('sail') },
    { id: 'read', label: 'Read more', prerequisites: ['plan'], opens: 't_new', opening: Opening.unread('t_new') },
    { id: 'gone', label: 'Fix the bike', prerequisites: ['plan'] },
    { id: 'late', label: 'Write the book', prerequisites: ['plan'], opens: 't_book', opening: Opening.unread('t_book') },
  ] });
});

test('an answer with no openings leaves a reader’s projection as it came', () => {
  const projection = { id: 't_year', title: 'My year', nodes: [{ id: 'sail', label: 'Learn to sail', prerequisites: [] }] };

  assert.deepEqual(Openings.fromWire(undefined).onto(projection, { joined: true }), projection);
  assert.deepEqual(Openings.fromWire(undefined).onto(projection, { joined: false }), projection);
});

test('until the session joins the server, the load’s word stands over the device’s older copy: a step it named opens that tree, one it did not opens none', () => {
  const openings = Openings.fromWire({
    sail: { treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false },
    read: { treeId: 't_new', title: 'Reading list', state: 'complete', done: 2, total: 2, loop: false },
  });
  const stored = { id: 't_year', title: 'My year', nodes: [
    { id: 'sail', label: 'Learn to sail', prerequisites: [] },
    { id: 'read', label: 'Read more', prerequisites: [], opens: 't_old' },
    { id: 'bike', label: 'Fix the bike', prerequisites: [], opens: 't_detached' },
  ] };

  assert.deepEqual(openings.onto(stored, { joined: false }).nodes, [
    { id: 'sail', label: 'Learn to sail', prerequisites: [], opening: openings.byStep.get('sail') },
    { id: 'read', label: 'Read more', prerequisites: [], opens: 't_old', opening: openings.byStep.get('read') },
    { id: 'bike', label: 'Fix the bike', prerequisites: [], opens: 't_detached' },
  ]);
  assert.deepEqual(openings.onto(stored, { joined: true }).nodes, [
    { id: 'sail', label: 'Learn to sail', prerequisites: [] },
    { id: 'read', label: 'Read more', prerequisites: [], opens: 't_old', opening: Opening.unread('t_old') },
    { id: 'bike', label: 'Fix the bike', prerequisites: [], opens: 't_detached', opening: Opening.unread('t_detached') },
  ]);
});

test('a load that read nothing of the trees leaves every pointer the device holds unread, joined or not', () => {
  const stored = { id: 't_year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail' },
  ] };
  const stood = [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail', opening: Opening.unread('t_sail') },
  ];

  assert.deepEqual(new Openings().onto(stored, { joined: false }).nodes, stood);
  assert.deepEqual(new Openings().onto(stored, { joined: true }).nodes, stood);
});

test('a roadmap says what it knows of the trees its steps open in one word', () => {
  const read = Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false });
  const missing = Opening.fromWire({ treeId: 't_gone', missing: true });

  assert.equal(Openings.known([{ id: 'plan' }]), 'none');
  assert.equal(Openings.known([{ id: 'plan' }, { id: 'sail', opening: read }, { id: 'bike', opening: missing }]), 'read');
  assert.equal(Openings.known([{ id: 'sail', opening: read }, { id: 'late', opening: Opening.unread('t_book') }]), 'unread');
});

test('a step that opens the tree it stands in keeps its opening and has no door: found trees lead, a tree not found does not', () => {
  const openings = Openings.fromWire({
    again: { treeId: 't_year', title: 'My year', state: 'open', done: 1, total: 3, loop: true },
    sail: { treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false },
    bike: { treeId: 't_gone', missing: true },
  });
  const projection = { id: 't_year', title: 'My year', nodes: [
    { id: 'again', label: 'Do it all again', prerequisites: [], opens: 't_year' },
    { id: 'sail', label: 'Learn to sail', prerequisites: [], opens: 't_sail' },
    { id: 'bike', label: 'Fix the bike', prerequisites: [], opens: 't_gone' },
  ] };

  const stood = (joined) => openings.onto(projection, { joined }).nodes.map(({ id, opening }) => ({ id, face: opening.face, own: opening.own, leads: opening.leads }));
  const expected = [
    { id: 'again', face: 'loop', own: true, leads: false },
    { id: 'sail', face: 'open', own: false, leads: true },
    { id: 'bike', face: 'missing', own: false, leads: false },
  ];
  assert.deepEqual(stood(false), expected);
  assert.deepEqual(stood(true), expected);
  assert.deepEqual(new Openings().onto(projection, { joined: true }).nodes.map(({ opening }) => [opening.face, opening.leads]), [['unread', false], ['unread', true], ['unread', true]]);
});

test('before the session joins, a pointer this device wrote and the server has not confirmed stands over the load, attached or detached', () => {
  const load = Openings.fromWire({ read: { treeId: 't_reading', title: 'Reading list', state: 'complete', done: 12, total: 12 } });
  const lattice = { id: 't_year', title: 'My year', nodes: [
    { id: 'run', label: 'Run a 10K', prerequisites: [], opens: 't_coast' },
    { id: 'read', label: 'Read more', prerequisites: [] },
    { id: 'bike', label: 'Fix the bike', prerequisites: [], opens: 't_older' },
  ] };
  const shown = (own) => load.onto(lattice, { joined: false, own: new Set(own) }).nodes
    .map((step) => ({ id: step.id, opens: step.opens ?? '', opening: step.opening?.treeId ?? null }));

  assert.deepEqual(shown(['run', 'read']), [
    { id: 'run', opens: 't_coast', opening: 't_coast' },
    { id: 'read', opens: '', opening: null },
    { id: 'bike', opens: 't_older', opening: null },
  ]);
  assert.deepEqual(shown([]), [
    { id: 'run', opens: 't_coast', opening: null },
    { id: 'read', opens: '', opening: 't_reading' },
    { id: 'bike', opens: 't_older', opening: null },
  ], 'with nothing of its own unconfirmed, the load’s word stands as before');
});

test('a tree chosen here stands at once with what the picker knew of it, until the server’s facts for that pointer are read', () => {
  const lattice = { id: 't_year', title: 'My year', nodes: [
    { id: 'run', label: 'Run a 10K', prerequisites: [], opens: 't_coast' },
    { id: 'read', label: 'Read more', prerequisites: [], opens: 't_reading' },
  ] };
  const known = new Map([
    ['run>t_coast', Opening.chosen({ id: 't_coast', title: 'Coast trip', done: 0, total: 5 })],
    ['read>t_reading', Opening.chosen({ id: 't_reading', title: 'Reading list', done: 12, total: 12 })],
  ]);
  const read = Openings.fromWire({ read: { treeId: 't_reading', title: 'Reading list', state: 'complete', done: 12, total: 13, loop: false } });

  const stood = read.onto(lattice, { joined: true, known }).nodes.map(({ id, opening }) => ({ id, face: opening.face, provisional: opening.provisional, done: opening.done, total: opening.total }));
  assert.deepEqual(stood, [
    { id: 'run', face: 'open', provisional: true, done: 0, total: 5 },
    { id: 'read', face: 'complete', provisional: false, done: 12, total: 13 },
  ]);
  assert.deepEqual(new Openings().onto(lattice, { joined: true, known: new Map() }).nodes.map(({ opening }) => opening.face), ['unread', 'unread']);
});

test('what the picker knew of a tree: complete once every one of its steps is, and a tree with no steps is not', () => {
  assert.deepEqual([{ done: 12, total: 12 }, { done: 3, total: 8 }, { done: 0, total: 0 }]
    .map(({ done, total }) => Opening.chosen({ id: 't_x', title: 'X', done, total }))
    .map((opening) => ({ face: opening.face, read: opening.read, valid: opening.valid, provisional: opening.provisional, leads: opening.leads })), [
    { face: 'complete', read: true, valid: true, provisional: true, leads: true },
    { face: 'open', read: true, valid: true, provisional: true, leads: true },
    { face: 'empty', read: true, valid: true, provisional: true, leads: true },
  ]);
  assert.equal(Opening.fromWire({ treeId: 't_x', title: 'X', state: 'open', done: 1, total: 2 }).provisional, false);
});
