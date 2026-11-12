import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomProgress } from '../../../../src/products/roadmap/room/useRoomProgress.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

function roomFixture(t, { restoreError = null, overrides = {}, mine = true } = {}) {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'terracotta' },
  ] });
  const calls = [];
  const origin = {};
  const realDocument = globalThis.document;
  globalThis.document = { activeElement: origin };
  t.after(() => { globalThis.document = realDocument; });
  const offered = new Set();
  const acts = new RoomProgress({
    treeId: 'sail', demo: false, shared: false, demotion: null,
    treeRef: { current: tree }, seedRef: { current: { id: 'sail', mine } },
    sceneRef: { current: { announceCeremony: (message, options) => calls.push(['ceremony', message, options]) } },
    sessionRef: { current: { markProgress: (ids, status) => calls.push(['write', ids, status]) } },
    returnLedger: { save: (id, value) => calls.push(['ledger', id, value.completed]) },
    milestoneLedger: { has: (treeId, id) => offered.has(id), markOffered: (treeId, id) => offered.add(id) },
    emit: (event) => calls.push(['emit', event.verb, event.nodeId]),
    showToast: (message, options) => calls.push(['toast', message, options]),
    noteCompletion: () => {},
    openShare: () => calls.push(['share']),
    band: 'desktop',
    track: (name, props) => calls.push(['event', name, { ...props }]),
    report: (operation, error) => calls.push(['failure', operation, error]),
    onChange: () => {},
    ...overrides,
  });
  if (restoreError) acts.restore = () => { throw restoreError; };
  return { acts, calls, origin, tree };
}

test('Graph completion shows the pinned toast for six seconds and Undo restores only its captured step', (t) => {
  const { acts, calls, origin } = roomFixture(t);
  acts.adoptLoaded({ completed: [], completedAt: {} });
  acts.complete('wind', { at: 100 });
  const toast = calls.find(([kind]) => kind === 'toast');
  assert.equal(toast[1], 'Read the wind done · Leave the dock up next');
  const { action, ...options } = toast[2];
  assert.deepEqual(options, { surface: 'graph', act: 'complete', holdMs: 6000, focusTarget: origin });
  assert.equal(action.label, 'Undo');
  assert.deepEqual(acts.snapshot.completed, new Set(['wind']));
  action.run();
  assert.deepEqual(acts.snapshot.completed, new Set());
  assert.deepEqual(calls.filter(([kind]) => kind === 'event'), [
    ['event', 'roadmap_graph_toast', { act: 'complete', step: 'shown' }],
    ['event', 'roadmap_graph_toast', { act: 'complete', step: 'undo' }],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'write'), [['write', 'wind', 'complete'], ['write', 'wind', 'none']]);
  assert.equal(calls.some(([kind]) => kind === 'ceremony'), false);
});

test('a completed step and what it unlocked reach the activity log in that order, silently', (t) => {
  const { acts, calls } = roomFixture(t);
  acts.complete('wind', { at: 100 });
  assert.deepEqual(calls.filter(([kind]) => kind === 'emit'), [['emit', 'completed', 'wind'], ['emit', 'unlocked', 'dock']]);
});

test('a quiet or Board completion owns its own telling, and reads the tree it was shown', (t) => {
  for (const options of [{ quiet: true }, { door: 'board' }]) {
    const { acts, calls, tree } = roomFixture(t);
    acts.complete('wind', { at: 100, ...options, tree: tree.without(['dock']) });
    assert.deepEqual(calls.filter(([kind]) => ['toast', 'ceremony', 'event'].includes(kind)), []);
    assert.deepEqual(calls.filter(([kind]) => kind === 'emit'), [['emit', 'completed', 'wind']]);
  }
});

test('a Graph milestone keeps its canvas ceremony in place of the toast, and is offered once ever', (t) => {
  const { acts, calls } = roomFixture(t);
  acts.adoptLoaded({ completed: ['wind'], completedAt: { wind: 1 } });
  acts.complete('dock', { at: 100 });
  const ceremony = calls.find(([kind]) => kind === 'ceremony');
  assert.equal(ceremony[1], 'Tree complete — 2/2 steps.');
  assert.equal(ceremony[2].action.label, 'Share it');
  assert.equal(calls.some(([kind]) => kind === 'toast' || kind === 'event'), false);
  ceremony[2].action.run();
  assert.deepEqual(calls.filter(([kind]) => kind === 'share'), [['share']]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'event'), [['event', 'roadmap_verb', { verb: 'share', door: 'ceremony', view: 'graph', band: 'desktop' }]]);
  calls.length = 0;
  acts.reset('dock');
  acts.complete('dock', { at: 200 });
  assert.equal(calls.some(([kind]) => kind === 'ceremony'), false);
  assert.equal(calls.filter(([kind]) => kind === 'toast').length, 1);
});

test('Graph completion Undo reports a restore failure under its own operation', (t) => {
  const error = new Error('restore failed');
  const { acts, calls } = roomFixture(t, { restoreError: error });
  acts.complete('wind', { at: 100 });
  calls.find(([kind]) => kind === 'toast')[2].action.run();
  assert.deepEqual(calls.filter(([kind]) => kind === 'failure'), [['failure', 'roadmap-step-restore', error]]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'event'), [
    ['event', 'roadmap_graph_toast', { act: 'complete', step: 'shown' }],
  ]);
});

test('Graph bulk completion is one progress gesture over the steps not yet done', (t) => {
  const { acts, calls } = roomFixture(t);
  acts.adoptLoaded({ completed: ['wind'], completedAt: { wind: 1 } });
  acts.markDone(new Set(['wind', 'dock']));
  assert.deepEqual(calls.filter(([kind]) => kind === 'write'), [['write', ['dock'], 'complete']]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'event'), [['event', 'roadmap_board_complete', { door: 'bulk', count: '1' }]]);
  calls.length = 0;
  acts.markDone(new Set(['wind', 'dock']));
  assert.deepEqual(calls, []);
});

test('only an owner\'s own marks enter the ledger; a demo\'s marks stay off the wire too', (t) => {
  const owned = roomFixture(t);
  owned.acts.reset('wind');
  assert.deepEqual(owned.calls.filter(([kind]) => kind === 'ledger'), [['ledger', 'sail', []]]);
  for (const overrides of [{ demo: true }, { shared: true }, { demotion: { edits: 0 } }]) {
    const { acts, calls } = roomFixture(t, { overrides });
    acts.reset('wind');
    assert.deepEqual(calls.filter(([kind]) => kind === 'ledger'), []);
    assert.equal(calls.filter(([kind]) => kind === 'write').length, overrides.demo ? 0 : 1);
  }
  const reader = roomFixture(t, { mine: false });
  reader.acts.reset('wind');
  assert.deepEqual(reader.calls.filter(([kind]) => kind === 'ledger'), []);
});

test('a remote mark adopts the owner\'s lane and says what moved; anyone else keeps what they are shown', (t) => {
  const { acts, calls } = roomFixture(t);
  assert.equal(acts.adoptRemote({ completed: ['wind'], completedAt: { wind: 5 } }), 'Read the wind done · Leave the dock up next');
  assert.deepEqual(acts.snapshot, { completed: new Set(['wind']), completedAt: { wind: 5 } });
  assert.deepEqual(calls.filter(([kind]) => kind === 'emit'), [['emit', 'completed', 'wind'], ['emit', 'unlocked', 'dock']]);
  assert.equal(acts.adoptRemote({ completed: ['wind'], completedAt: { wind: 5 } }), null);
  assert.equal(acts.adoptRemote({ completed: ['wind', 'dock'], completedAt: { wind: 5, dock: 6 } }), 'Leave the dock done');
  const many = roomFixture(t);
  assert.equal(many.acts.adoptRemote({ completed: ['wind', 'dock'], completedAt: { wind: 5, dock: 6 } }), '2 steps done');
  const reader = roomFixture(t, { mine: false });
  assert.equal(reader.acts.adoptRemote({ completed: ['wind'], completedAt: {} }), null);
  assert.deepEqual(reader.acts.snapshot.completed, new Set());
});

// My year: an ordinary root, a step that opens a tree behind it, and an ordinary step behind that.
function yearFixture(t, opening) {
  const fixture = roomFixture(t);
  fixture.acts.collaborators.treeRef.current = new SkillTree({ id: 'sail', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: opening.treeId, opening },
    { id: 'maya', label: 'Take Maya sailing', prerequisites: ['sail'] },
  ] });
  return fixture;
}
const sailing = (state, done) => Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state, done, total: 8, loop: false });

test('no mark reaches a step that opens a tree from any door: nothing changes, nothing is sent and nothing is said', (t) => {
  for (const opening of [sailing('open', 3), sailing('complete', 8), Opening.fromWire({ treeId: 't_gone', missing: true }), Opening.unread('t_sail')]) {
    const { acts, calls } = yearFixture(t, opening);
    acts.adoptLoaded({ completed: ['plan'], completedAt: { plan: 1 } });
    const before = acts.snapshot;

    acts.complete('sail', { at: 100 });
    acts.complete('sail', { quiet: true });
    acts.reset('sail');
    acts.restore('sail', { completed: new Set(['sail']) });
    acts.markDone(new Set(['sail']));

    assert.equal(acts.snapshot, before);
    assert.deepEqual(calls, []);
  }
});

test('a bulk Mark done marks the ordinary steps of a selection and leaves the one that opens a tree', (t) => {
  const { acts, calls } = yearFixture(t, sailing('open', 3));
  acts.markDone(new Set(['plan', 'sail', 'maya']));

  assert.deepEqual(calls.filter(([kind]) => kind === 'write'), [['write', ['plan', 'maya'], 'complete']]);
  assert.deepEqual(acts.snapshot.completed, new Set(['plan', 'maya']));
  assert.deepEqual(calls.filter(([kind]) => kind === 'event'), [['event', 'roadmap_board_complete', { door: 'bulk', count: '2-5' }]]);
});

test('the ledger and the crown read what stands complete: a step whose tree is done counts with no mark of its own', (t) => {
  const { acts, calls } = yearFixture(t, sailing('complete', 8));
  acts.adoptLoaded({ completed: ['plan'], completedAt: { plan: 1 } });
  acts.complete('maya', { at: 100 });

  assert.deepEqual(calls.filter(([kind]) => kind === 'ledger'), [['ledger', 'sail', ['plan', 'sail', 'maya']]]);
  assert.equal(calls.find(([kind]) => kind === 'ceremony')[1], 'Tree complete — 3/3 steps.');
});

test('a roadmap that read nothing of a tree one of its steps opens witnesses nothing: the ledger keeps what the last full load saw', (t) => {
  const { acts, calls } = yearFixture(t, Opening.unread('t_sail'));
  acts.adoptLoaded({ completed: ['plan'], completedAt: { plan: 1 } });
  acts.complete('maya', { quiet: true });
  acts.adoptRemote({ completed: new Set(['plan', 'maya']), completedAt: {} });

  assert.deepEqual(calls.filter(([kind]) => kind === 'ledger'), []);
});
