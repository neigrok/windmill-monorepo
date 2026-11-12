import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { BoardActs, BoardComposer, useBoardActs } from '../../../../src/products/roadmap/board/useBoardActs.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { renderHook } from '../../gym/harness.mjs';

const holdingSession = (session) => ({ ready: true, holdAct: () => {}, endHeldAct: () => {}, leavePage: () => {}, ...session });

function fixture(overrides = {}) {
  const calls = [];
  const receipt = {};
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
    { id: 'spare', label: 'Practice knots', prerequisites: [], color: 'blue' },
    { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'blue' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'blue' },
  ] });
  const c = {
    tree, treeId: tree.id, active: true, owner: true,
    progress: { completed: new Set(), completedAt: {} }, query: new BoardQuery(), now: () => 17,
    session: holdingSession({ dispatch: (gesture) => { calls.push(['dispatch', gesture]); return receipt; }, revert: (value) => { calls.push(['revert', value]); return true; } }),
    completeStep: (id, options) => { calls.push(['complete', id, options]); return advanceProgress(c.progress, [id], 'complete', options.at); },
    restoreStep: (id, before) => calls.push(['restore', id, before]),
    showToast: (message, options) => { c.toast = { message, ...options }; },
    setQuery: (query) => calls.push(['query', query]), onReveal: (id) => calls.push(['reveal', id]),
    onQuiet: () => calls.push(['quiet']), onHeld: (held) => { c.held = held; },
    track: (name, props) => calls.push(['event', name, props]),
    emit: () => {},
    errors: [], report: (op, error) => { calls.push(['report', op]); c.errors.push(error); },
    ...overrides,
  };
  return { acts: new BoardActs(c), c, calls, receipt };
}

for (const via of ['timer', 'replaced', 'left']) {
  test(`held deletion releases once through ${via}`, () => {
    const { acts, c, calls } = fixture();
    acts.delete(['wind'], 'menu');
    assert.equal(c.held.ids[0], 'wind');
    assert.equal(c.toast.holdMs, 9000);
    assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }]]);
    c.toast.onLeave(via);
    c.toast.onLeave(via);
    acts.release(via);
    assert.equal(c.held, null);
    assert.deepEqual(calls, [
      ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }],
      ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }],
      ['event', 'roadmap_board_delete', { step: 'sent', via, view: 'board' }],
    ]);
  });
}

test('delete Undo restores the projection and sends nothing even when its toast leaves', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  c.toast.action.run();
  c.toast.onLeave('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }], ['quiet'], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'delete' }]]);
});

test('a new held delete releases its predecessor and owns its own Undo', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  const first = c.toast;
  acts.delete(['dock'], 'menu');
  first.action.run();
  first.onLeave('replaced');
  assert.deepEqual(c.held.ids, ['dock']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }]]);
});

test('a release retains its original session across roadmap changes', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  acts.update({ ...c, session: { dispatch() { throw Error('Wrong session'); } } });
  acts.release('left');
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }]]);
});

test('a no-op release clears the projection without reporting an expected refusal', () => {
  const { acts, c, calls } = fixture({ session: holdingSession({ dispatch: () => null }) });
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }], ['quiet']]);
  assert.deepEqual(c.errors, []);
});

test('an unexpected release failure reports its original error for stack frames', () => {
  const error = new Error('private content');
  const { acts, c, calls } = fixture({ session: holdingSession({ dispatch: () => { throw error; } }) });
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }], ['quiet'], ['report', 'roadmap-board-delete'],
    ['event', 'roadmap_board_delete', { step: 'failed', outcome: 'error', view: 'board' }],
  ]);
  assert.deepEqual(c.errors, [error]);
});

test('a session not ready says the delete failed at once, holds nothing and reports no Issue; Retry runs it again', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (line) => warned.push(line));
  const session = holdingSession({ ready: false, dispatch: () => { throw new Error('nothing to dispatch yet'); } });
  const { acts, c, calls } = fixture({ session });
  assert.equal(acts.delete(['wind'], 'key'), false);
  assert.equal(c.held, undefined);
  assert.deepEqual({ message: c.toast.message, surface: c.toast.surface, act: c.toast.act, label: c.toast.action.label, holdMs: c.toast.holdMs },
    { message: 'Couldn’t delete Read the wind', surface: 'board', act: 'delete', label: 'Retry', holdMs: undefined });
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'failed', outcome: 'not_ready', view: 'board' }]]);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(warned, ['[sync] a delete could not land: the session is not ready']);
  calls.length = 0;
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'retry', view: 'board' }],
    ['event', 'roadmap_board_delete', { step: 'failed', outcome: 'not_ready', view: 'board' }],
  ]);
  session.ready = true;
  calls.length = 0;
  c.toast.action.run();
  assert.deepEqual(c.held.ids, ['wind']);
  assert.equal(c.toast.message, 'Read the wind deleted');
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'retry', view: 'board' }],
    ['event', 'roadmap_board_delete', { step: 'held', door: 'key', view: 'board' }],
  ]);
});

test('a session with no socket yet is not ready either, and several steps name their count', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { acts, c } = fixture({ session: null });
  assert.equal(acts.delete(['wind', 'dock'], 'bulk'), false);
  assert.equal(c.toast.message, 'Couldn’t delete 2 steps');
  assert.deepEqual(c.errors, []);
});

test('a release that fails when its hold ends brings the step back and says so; Retry holds it again', (t) => {
  t.mock.method(console, 'warn', () => {});
  const session = holdingSession({ dispatch: () => null });
  const { acts, c, calls } = fixture({ session });
  acts.delete(['wind'], 'menu');
  session.ready = false;
  c.toast.onLeave('timer');
  assert.equal(c.held, null);
  assert.equal(c.toast.message, 'Couldn’t delete Read the wind');
  assert.deepEqual(calls.slice(1), [['quiet'], ['event', 'roadmap_board_delete', { step: 'failed', outcome: 'not_ready', view: 'board' }]]);
  session.ready = true;
  c.toast.action.run();
  assert.deepEqual(c.held.ids, ['wind']);
  assert.equal(c.toast.holdMs, 9000);
});

for (const via of ['replaced', 'left']) {
  test(`a release that fails as its toast is ${via} says nothing over what took its place, and still reports`, (t) => {
    t.mock.method(console, 'warn', () => {});
    const error = new Error('private content');
    const { acts, c, calls } = fixture({ session: holdingSession({ dispatch: () => { throw error; } }) });
    acts.delete(['wind'], 'menu');
    const shown = c.toast;
    shown.onLeave(via);
    assert.equal(c.toast, shown);
    assert.deepEqual(calls.at(-1), ['event', 'roadmap_board_delete', { step: 'failed', outcome: 'error', view: 'board' }]);
    assert.deepEqual(c.errors, [error]);
  });
}

test('⌘Z during a hold cancels it as the toast\'s Undo does: nothing sent, the stack untouched, the toast gone', () => {
  const session = new SyncSession({ treeId: 'sail', registry: null, store: { save: async () => {} } });
  const data = { id: 'sail', title: 'Sail', nodes: [
    { id: 'spare', label: 'Practice knots', prerequisites: [] },
    { id: 'wind', label: 'Read the wind', prerequisites: [] },
  ] };
  session.seed(data);
  const renamed = session.dispatch({ kind: 'RenameNode', id: 'spare', label: 'Earlier' });
  const cleared = [];
  const { acts, c, calls } = fixture({ tree: new SkillTree(data), session, clearBoardToast: () => cleared.push(true) });
  acts.delete(['wind'], 'menu');
  calls.length = 0;
  session.undo();
  assert.equal(c.held, null);
  assert.equal(acts.pending, null);
  assert.deepEqual(cleared, [true]);
  assert.deepEqual(calls, [['quiet'], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'delete' }]]);
  assert.deepEqual(session.lattice.toTreeData().nodes.map(({ label }) => label), ['Earlier', 'Read the wind']);
  assert.deepEqual([session.undoStack.length, session.redoStack.length], [1, 0]);
  c.toast.onLeave('replaced');
  assert.equal(session.lattice.hasNode('wind'), true);
  session.undo();
  assert.equal(session.lattice.toTreeData().nodes[0].label, 'Practice knots');
  assert.equal(session.revert(renamed), false);
});

test('after a hold ends, by release or Undo, ⌘Z walks the stack again', () => {
  const session = new SyncSession({ treeId: 'sail', registry: null, store: { save: async () => {} } });
  const data = { id: 'sail', title: 'Sail', nodes: [
    { id: 'spare', label: 'Practice knots', prerequisites: [] },
    { id: 'wind', label: 'Read the wind', prerequisites: [] },
  ] };
  session.seed(data);
  const { acts, c } = fixture({ tree: new SkillTree(data), session });
  acts.delete(['wind'], 'menu');
  c.toast.onLeave('timer');
  assert.equal(session.lattice.hasNode('wind'), false);
  session.undo();
  assert.equal(session.lattice.hasNode('wind'), true);
});

test('a completion whose Undo throws reports its static operation and lets its toast leave', () => {
  const error = new Error('private content');
  const { acts, c, calls } = fixture({ restoreStep: () => { throw error; } });
  acts.complete('wind', 'key');
  calls.length = 0;
  assert.doesNotThrow(() => c.toast.action.run());
  assert.deepEqual(calls, [['quiet'], ['report', 'roadmap-step-restore']]);
  assert.deepEqual(c.errors, [error]);
});

test('leaving the page turns the session synchronous before the release, so the release lands first', () => {
  const order = [];
  const { acts } = fixture({ session: holdingSession({
    leavePage: () => order.push('leaving'),
    dispatch: () => { order.push('dispatch'); return {}; },
  }) });
  acts.delete(['wind'], 'menu');
  acts.leavePage();
  acts.leavePage();
  assert.deepEqual(order, ['leaving', 'dispatch']);
});

test('complete snapshots progress; Undo targets its own step and reveal names the newly unlocked step', () => {
  const { acts, c, calls } = fixture();
  const before = c.progress;
  assert.equal(acts.complete('wind', 'key'), true);
  assert.equal(c.toast.message, 'Read the wind done · Leave the dock up next');
  assert.equal(c.toast.reveal, 'dock');
  acts.revealToast(c.toast);
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['complete', 'wind', { door: 'board', at: 17 }],
    ['event', 'roadmap_board_complete', { door: 'key' }],
    ['reveal', 'dock'], ['event', 'roadmap_board_toast_reveal', { act: 'complete' }],
    ['quiet'], ['restore', 'wind', before], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'complete' }],
  ]);
});

test('complete ignores locked, done, inactive and reader steps', () => {
  for (const options of [{}, { active: false }, { owner: false }, { progress: { completed: new Set(['wind']), completedAt: { wind: 1 } } }]) {
    const { acts, calls } = fixture(options);
    assert.equal(acts.complete(Object.keys(options).length ? 'wind' : 'dock', 'key'), false);
    assert.deepEqual(calls, []);
  }
});

const request = Object.freeze({ id: 'reef', label: 'Reefing basics', description: '', color: 'blue', prerequisites: ['wind'] });

test('Graph create preserves Board filters, reveals on the Graph and Undo reverts its own receipt', () => {
  const { acts, c, calls, receipt } = fixture({
    active: false, graphActive: true,
    query: new BoardQuery({ search: 'invisible', sort: 'oldest' }),
  });
  c.onGraphReveal = (id) => calls.push(['graph reveal', id]);
  assert.deepEqual(acts.create(request), { ok: true });
  assert.deepEqual({
    message: c.toast.message, surface: c.toast.surface, act: c.toast.act,
    reveal: c.toast.reveal, holdMs: c.toast.holdMs, action: c.toast.action.label,
  }, {
    message: 'Reefing basics added · Locked', surface: 'graph', act: 'create',
    reveal: 'reef', holdMs: 6000, action: 'Undo',
  });
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['dispatch', { kind: 'CreateNode', ...request }], ['graph reveal', request.id],
    ['event', 'roadmap_graph_toast', { act: 'create', step: 'shown' }],
    ['event', 'roadmap_board_create', { step: 'saved', column: 'locked', filterCleared: false }],
    ['revert', receipt], ['quiet'], ['event', 'roadmap_graph_toast', { act: 'create', step: 'undo' }],
  ]);
});

test('Graph availability permits owner create without enabling Board keyboard or bulk doors', () => {
  for (const owner of [false, true]) {
    const { acts, c, calls } = fixture({ active: false, graphActive: true, owner });
    c.onGraphReveal = () => {};
    assert.equal(acts.complete('wind', 'key'), false);
    assert.equal(acts.delete(['wind'], 'key'), false);
    assert.equal(acts.delete(['wind'], 'bulk'), false);
    assert.deepEqual(acts.edit({ ...request, id: 'wind' }), { ok: false });
    assert.deepEqual(acts.recolor(['wind'], 'gold'), { ok: false });
    assert.deepEqual(calls, []);
    assert.deepEqual(acts.create(request), { ok: owner });
    if (!owner) assert.deepEqual(calls, []);
  }
});

test('Graph create Undo refuses expired receipts quietly and reports thrown reverts with their stack', () => {
  for (const throws of [false, true]) {
    const failure = new Error('private content');
    const { acts, c, calls } = fixture({ active: false, graphActive: true, onGraphReveal: () => {},
      session: { dispatch: () => ({}), revert: () => { if (throws) throw failure; return false; } },
    });
    acts.create(request);
    calls.length = 0;
    c.toast.action.run();
    assert.deepEqual(calls, throws ? [['report', 'roadmap-board-create']] : []);
    assert.deepEqual(c.errors, throws ? [failure] : []);
  }
});

test('Graph composers expose owner create and open-detail edit to the owner alone', () => {
  for (const owner of [false, true]) {
    for (const detailId of [null, 'wind']) {
      const calls = [];
      const draft = { door: 'verbs', view: 'tree' };
      const composer = new BoardComposer({ owner, view: 'tree',
        detailId, composer: draft,
        acts: { edit: (request) => { calls.push(['edit', request]); return { ok: true }; } },
        onOpen: (value) => calls.push(['open', value]),
      });
      const editable = owner && detailId !== null;
      assert.equal(composer.shown, owner ? draft : null);
      composer.openEdit('wind');
      assert.deepEqual(calls, editable ? [['open', { door: 'detail', editing: 'wind' }]] : []);
      assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
      composer.composer = { door: 'detail', view: 'tree', editing: 'wind' };
      assert.equal(composer.shown, editable ? composer.composer : null);
      assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: editable });
      assert.deepEqual(composer.saveEdit({ id: 'other' }), { ok: false });
      assert.deepEqual(calls, editable ? [
        ['open', { door: 'detail', editing: 'wind' }], ['edit', { id: 'wind' }],
      ] : []);
    }
  }
});

test('a composer is hidden immediately after switching away from its originating view', () => {
  for (const origin of ['board', 'tree']) {
    for (const view of ['board', 'tree']) {
      const draft = { door: 'verbs', view: origin };
      const composer = new BoardComposer({ owner: true,
        view, detailId: null, composer: draft,
      });
      assert.equal(composer.shown, origin === view ? draft : null);
    }
  }
});

test('create dispatches one pinned request and Undo reverts its receipt', () => {
  const { acts, c, calls, receipt } = fixture({ query: new BoardQuery({ search: 'invisible', sort: 'oldest' }) });
  assert.deepEqual(acts.create(request), { ok: true });
  assert.equal(c.toast.message, 'Reefing basics added · filter cleared');
  assert.equal(c.toast.reveal, request.id);
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['dispatch', { kind: 'CreateNode', ...request }],
    ['query', new BoardQuery({ sort: 'oldest' })], ['reveal', request.id],
    ['event', 'roadmap_board_create', { step: 'saved', column: 'locked', filterCleared: true }],
    ['revert', receipt], ['quiet'], ['event', 'roadmap_board_undo', { act: 'create' }],
  ]);
});

test('create not-ready is an expected refusal; Retry carries the same request', () => {
  const requests = [];
  const { acts, c, calls } = fixture({ session: { dispatch: (gesture) => { requests.push(gesture); return null; } } });
  assert.deepEqual(acts.create(request), { ok: false });
  assert.deepEqual(acts.create(request), { ok: false });
  assert.deepEqual(requests, [{ kind: 'CreateNode', ...request }, { kind: 'CreateNode', ...request }]);
  assert.deepEqual(calls, []);
  assert.equal(c.toast, undefined);
});

for (const session of [null, { dispatch() { throw Error('private content'); } }]) {
  test('create boundary failure reports a static operation and returns false', () => {
    const { acts, c, calls } = fixture({ session });
    assert.deepEqual(acts.create(request), { ok: false });
    assert.deepEqual(calls, [['report', 'roadmap-board-create']]);
    assert.equal(c.errors.length, 1);
    assert.ok(c.errors[0] instanceof Error);
    assert.ok(c.errors[0].stack.includes('useBoardActs'));
  });
}

test('create Undo targets its receipt after another structural gesture', () => {
  const applied = [];
  const reverted = [];
  const session = {
    dispatch(gesture) { const receipt = { gesture }; applied.push(receipt); return receipt; },
    revert(receipt) { reverted.push(receipt); return true; },
  };
  const { acts, c } = fixture({ session });
  assert.deepEqual(acts.create(request), { ok: true });
  session.dispatch({ kind: 'SetNodeColor', nodeId: 'wind', color: 'green' });
  c.toast.action.run();
  assert.deepEqual(reverted, [applied[0]]);
  assert.deepEqual(applied.map(({ gesture }) => gesture), [
    { kind: 'CreateNode', ...request }, { kind: 'SetNodeColor', nodeId: 'wind', color: 'green' },
  ]);
});

test('delete confirmation and cancellation only emit their bounded event', () => {
  const { acts, calls } = fixture();
  acts.deletePrompt('confirm');
  acts.deletePrompt('cancel');
  acts.deletePrompt('private content');
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'confirm', view: 'board' }],
    ['event', 'roadmap_board_delete', { step: 'cancel', view: 'board' }],
  ]);
});

test('Board create and held release use the common dispatch receipt policy', () => {
  const options = [];
  const { acts } = fixture({ session: holdingSession({ dispatch: (_gesture, value) => { options.push(value); return {}; } }) });
  acts.create(request);
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.deepEqual(options, [undefined, undefined]);
});

test('toast reveal clears only query parts hiding its target and keeps sort', () => {
  const { acts, calls } = fixture({ query: new BoardQuery({ search: 'wind', kinds: ['blue'], sort: 'oldest' }) });
  acts.revealToast({ act: 'complete', reveal: 'dock' });
  assert.deepEqual(calls, [
    ['query', new BoardQuery({ kinds: ['blue'], sort: 'oldest' })],
    ['reveal', 'dock'], ['event', 'roadmap_board_toast_reveal', { act: 'complete' }],
  ]);
});

test('expired create receipt causes no quiet marker or Undo event', () => {
  const { acts, c, calls } = fixture({ session: { dispatch: () => ({}), revert: () => false } });
  acts.create(request);
  calls.length = 0;
  c.toast.action.run();
  assert.deepEqual(calls, []);
});

for (const via of ['timer', 'left']) {
  test(`a held deletion released through ${via} exposes no masked work in its real session notification or persisted state`, async () => {
    const observed = [];
    const saved = [];
    const session = new SyncSession({ treeId: 'sail', registry: null,
      store: { save: async (_treeId, state) => saved.push(state.frame) } });
    const data = { id: 'sail', title: 'Sail', nodes: [
      { id: 'course', label: 'Choose a course', prerequisites: [] },
      { id: 'wind', label: 'Read the wind', prerequisites: ['course'] },
      { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'] },
    ] };
    session.seed(data);
    session.onTreeChanged(() => observed.push(session.maskedWork()));
    const { acts, c, calls } = fixture({ tree: new SkillTree(data), session });
    acts.delete(['wind'], 'menu');
    assert.deepEqual(session.maskedWork(), []);
    assert.equal(saved.length, 0);
    c.toast.onLeave(via);
    await Promise.resolve();
    assert.deepEqual(observed, [[]]);
    assert.deepEqual(session.maskedWork(), []);
    assert.deepEqual(session.lattice.presentEdges(), [{ from: 'course', to: 'dock' }]);
    const persisted = new SyncSession({ treeId: 'sail', registry: null });
    assert.equal(saved.length, 1);
    persisted.lattice.join(saved[0]);
    assert.deepEqual(persisted.maskedWork(), []);
    assert.deepEqual(persisted.lattice.toTreeData().nodes.map(({ id, prerequisites }) => ({ id, prerequisites })), [
      { id: 'course', prerequisites: [] }, { id: 'dock', prerequisites: ['course'] },
    ]);
    assert.deepEqual(calls, [
      ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }],
      ['event', 'roadmap_board_delete', { step: 'sent', via, view: 'board' }],
    ]);
  });
}

test('recolor dispatches once with the common receipt policy, preserves the query and Undo targets its receipt quietly', () => {
  const options = [];
  const { acts, c, calls, receipt } = fixture();
  const dispatch = c.session.dispatch;
  c.session.dispatch = (gesture, capture) => { options.push(capture); return dispatch(gesture); };
  assert.deepEqual(acts.recolor(['wind', 'dock'], 'gold'), { ok: true, changed: true });
  assert.equal(c.toast.message, '2 steps recolored');
  assert.equal(c.toast.holdMs, 6000);
  assert.deepEqual(options, [undefined]);
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['dispatch', { kind: 'BulkRecolor', nodeIds: ['wind', 'dock'], color: 'gold' }],
    ['event', 'roadmap_board_bulk', { step: 'recolor', count: '2-5' }],
    ['quiet'], ['revert', receipt], ['event', 'roadmap_board_undo', { act: 'recolor' }],
  ]);
});

test('recolor choosing the shared kind and empty selections are no-ops without toast or events', () => {
  const { acts, c, calls } = fixture();
  assert.deepEqual(acts.recolor(['wind', 'dock'], 'blue'), { ok: true, changed: false });
  assert.deepEqual(acts.recolor([], 'gold'), { ok: true, changed: false });
  assert.deepEqual(calls, []);
  assert.equal(c.toast, undefined);
});

test('bulk and key deletion use one held entity and reject the sole root', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'wind', label: 'Wind', prerequisites: ['root'] },
    { id: 'dock', label: 'Dock', prerequisites: ['wind'] },
  ] });
  const { acts, c, calls } = fixture({ tree });
  assert.equal(acts.delete(['root'], 'key'), false);
  assert.equal(acts.delete(['wind', 'dock'], 'bulk'), true);
  assert.deepEqual(c.held.ids, ['wind', 'dock']);
  assert.equal(c.toast.message, '2 steps deleted');
  c.toast.onLeave('timer');
  acts.release('left');
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'bulk', view: 'board' }],
    ['event', 'roadmap_board_bulk', { step: 'delete', count: '2-5' }],
    ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind', 'dock'] }],
    ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer', view: 'board' }],
  ]);
  calls.length = 0;
  assert.equal(acts.delete(['dock'], 'key'), true);
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'key', view: 'board' }],
    ['quiet'], ['reveal', 'dock'], ['event', 'roadmap_board_undo', { act: 'delete' }],
  ]);
});

const editRequest = { id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', prerequisites: [] };

test('edit diffs, marks quiet before one contained write, emits rename and bounded changes without toast', () => {
  const { acts, c, calls } = fixture();
  const options = [];
  const dispatch = c.session.dispatch;
  c.session.dispatch = (gesture, capture) => { options.push(capture); return dispatch(gesture); };
  c.emit = (event, emitted) => calls.push(['activity', event, emitted]);
  assert.deepEqual(acts.edit(editRequest), { ok: true });
  assert.deepEqual(options, [undefined]);
  assert.equal(c.toast, undefined);
  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'EditNode', id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', addPrerequisites: [], removePrerequisites: ['wind'] }],
    ['activity', { verb: 'renamed', nodeId: 'dock', label: 'Leave the harbor', kind: 'gold' }, { silent: true }],
    ['event', 'roadmap_board_edit', { step: 'saved', name: true, description: true, kind: true, prerequisites: true }],
  ]);
});

test('edit has no write or event for an unchanged request and refuses an absent or held step', () => {
  const { acts, calls } = fixture();
  assert.deepEqual(acts.edit({ id: 'dock', label: 'Leave the dock', description: '', color: 'blue', prerequisites: ['wind'] }), { ok: true });
  assert.deepEqual(acts.edit({ ...editRequest, id: 'missing' }), { ok: false });
  assert.deepEqual(calls, []);
  acts.delete(['dock'], 'key');
  calls.length = 0;
  assert.deepEqual(acts.edit(editRequest), { ok: false });
  assert.deepEqual(calls, []);
});

for (const action of ['edit', 'recolor']) {
  test(`${action} reports unexpected boundaries with stacks and treats null receipt as expected`, () => {
    for (const session of [null, { dispatch: () => { throw new Error('private content'); } }, { dispatch: () => null }]) {
      const { acts, c, calls } = fixture({ session });
      const result = action === 'edit' ? acts.edit(editRequest) : acts.recolor(['dock'], 'gold');
      assert.deepEqual(result, { ok: false });
      assert.equal(c.toast, undefined);
      assert.deepEqual(calls.filter(([kind]) => kind === 'event'), []);
      if (session?.dispatch && c.errors.length === 0) {
        assert.deepEqual(calls, action === 'edit' ? [['quiet']] : []);
      } else {
        assert.equal(c.errors.length, 1);
        assert.ok(c.errors[0].stack);
        assert.deepEqual(calls.filter(([kind]) => kind === 'report'), [['report', `roadmap-board-${action}`]]);
      }
    }
  });
}

test('edit is one session receipt and global revert restores its fields and edges together', () => {
  const session = new SyncSession({ treeId: 'sail', registry: null });
  session.seed({ id: 'sail', title: 'Sail', nodes: [
    { id: 'wind', label: 'Wind', color: 'blue', prerequisites: [] },
    { id: 'dock', label: 'Dock', color: 'blue', prerequisites: ['wind'] },
  ] });
  const before = session.lattice.toTreeData();
  const receipts = [];
  const dispatch = session.dispatch.bind(session);
  session.dispatch = (gesture, options) => { const receipt = dispatch(gesture, options); receipts.push(receipt); return receipt; };
  const { acts } = fixture({ session, tree: new SkillTree(before) });
  assert.deepEqual(acts.edit(editRequest), { ok: true });
  assert.equal(receipts.length, 1);
  assert.equal(session.revert(receipts[0]), true);
  assert.deepEqual(session.lattice.toTreeData(), before);
});

test('an applied edit remains successful when activity emission fails and reports the unexpected failure', () => {
  const error = new Error('private content');
  const { acts, c, calls } = fixture({ emit: () => { throw error; } });
  assert.deepEqual(acts.edit(editRequest), { ok: true });
  assert.deepEqual(c.errors, [error]);
  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'EditNode', id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', addPrerequisites: [], removePrerequisites: ['wind'] }],
    ['report', 'roadmap-board-edit'],
    ['event', 'roadmap_board_edit', { step: 'saved', name: true, description: true, kind: true, prerequisites: true }],
  ]);
});

test('an applied edit remains successful when product event emission fails', () => {
  const error = new Error('private content');
  const { acts, c, calls } = fixture({ track: () => { throw error; } });
  assert.deepEqual(acts.edit(editRequest), { ok: true });
  assert.deepEqual(c.errors, [error]);
  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'EditNode', id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', addPrerequisites: [], removePrerequisites: ['wind'] }],
    ['report', 'roadmap-board-edit'],
  ]);
});

test('an unchanged edit succeeds without a session and reports nothing', () => {
  const { acts, c, calls } = fixture({ session: null });
  assert.deepEqual(acts.edit({ id: 'dock', label: 'Leave the dock', description: '', color: 'blue', prerequisites: ['wind'] }), { ok: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(c.errors, []);
  assert.equal(c.toast, undefined);
});

test('an expired recolor receipt emits no Undo event and never changes the query', () => {
  const { acts, c, calls } = fixture({ session: { dispatch: () => ({}), revert: () => false } });
  assert.deepEqual(acts.recolor(['dock'], 'gold'), { ok: true, changed: true });
  calls.length = 0;
  c.toast.action.run();
  assert.deepEqual(calls, [['quiet']]);
  assert.deepEqual(c.errors, []);
});

test('bulk Undo cancels the entire hold without sending any selected step', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'wind', label: 'Wind', prerequisites: ['root'] },
    { id: 'dock', label: 'Dock', prerequisites: ['wind'] },
  ] });
  const { acts, c, calls } = fixture({ tree });
  assert.equal(acts.delete(['wind', 'dock'], 'bulk'), true);
  c.toast.action.run();
  c.toast.onLeave('timer');
  acts.release('left');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'bulk', view: 'board' }],
    ['event', 'roadmap_board_bulk', { step: 'delete', count: '2-5' }],
    ['quiet'], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'delete' }],
  ]);
});

test('edit compares against the held projection and does not write a parent removal already projected', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'wind', label: 'Wind', prerequisites: ['root'] },
    { id: 'dock', label: 'Dock', color: 'blue', prerequisites: ['wind'] },
  ] });
  const { acts, c, calls } = fixture({ tree });
  assert.equal(acts.delete(['wind'], 'key'), true);
  const toast = c.toast;
  calls.length = 0;
  assert.deepEqual(acts.edit({ id: 'dock', label: 'Dock', description: '', color: 'blue', prerequisites: ['root'] }), { ok: true });
  assert.deepEqual(calls, []);
  assert.equal(c.toast, toast);
  assert.deepEqual(c.held.ids, ['wind']);
});

test('invalid edit prerequisites refuse before quiet, dispatch, activity or an expected-case Issue', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
    { id: 'wind', label: 'Wind', prerequisites: [] },
    { id: 'dock', label: 'Dock', prerequisites: ['wind'] },
    { id: 'solo', label: 'Solo', prerequisites: ['dock'] },
  ] });
  const { acts, c, calls } = fixture({ tree, emit: () => assert.fail('refused edits have no activity') });
  for (const id of ['missing', 'wind', 'dock', 'solo']) {
    assert.deepEqual(acts.edit({ id: 'wind', label: 'Wind', description: '', color: 'sky', prerequisites: [id] }), { ok: false });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(c.errors, []);
  assert.equal(c.toast, undefined);
});

test('receipt invalidation dismisses its captured toast without releasing a held delete', (t) => {
  const calls = [];
  const { c } = fixture({ receiptVersion: 0, dismissInvalidatedToast: () => calls.push('dismiss') });
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const hook = renderHook(t, () => useBoardActs(c));
  t.after(() => { globalThis.window = previousWindow; });
  const acts = hook.tree.acts;
  acts.delete(['wind'], 'menu');
  const held = hook.tree.held;
  const pending = acts.pending;
  c.receiptVersion = 1;
  hook.redraw();
  assert.deepEqual(calls, ['dismiss']);
  assert.equal(acts.held, held);
  assert.equal(acts.pending, pending);
  assert.equal(hook.tree.held, held);
});

for (const action of ['create', 'recolor', 'complete', 'delete']) {
  test(`${action} identifies only receipt-backed Undo for invalidation`, () => {
    const { acts, c } = fixture();
    if (action === 'create') acts.create({ id: 'new', label: 'New step', description: '', color: 'sky', prerequisites: [] });
    if (action === 'recolor') acts.recolor(['wind'], 'sky');
    if (action === 'complete') acts.complete('wind', 'key');
    if (action === 'delete') acts.delete(['wind'], 'menu');
    assert.equal(c.toast.action.receipt === true, ['create', 'recolor'].includes(action));
  });
}

test('a held delete whose timer expires during discard waits for the server baseline', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  const held = c.held;
  c.session.rebaselining = 'structure';
  acts.release('timer');
  assert.equal(acts.held, held);
  assert.equal(acts.pending.held, held);
  assert.equal(acts.pending.releaseVia, 'timer');
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }]]);
  c.session.rebaselining = null;
  acts.release(acts.pending.releaseVia);
  assert.equal(acts.held, null);
  assert.equal(acts.pending, null);
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'board' }],
    ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }],
    ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer', view: 'board' }],
  ]);
});

test('Graph detail edits use the same action and receipt policy as Board detail edits', () => {
  for (const graphActive of [false, true]) {
    for (const owner of [false, true]) {
      const { acts, calls } = fixture({ active: false, graphActive, owner, emit: () => {} });
      assert.deepEqual(acts.edit(editRequest), { ok: graphActive && owner });
      if (!graphActive || !owner) assert.deepEqual(calls, []);
      else assert.deepEqual(calls, [
        ['quiet'],
        ['dispatch', { kind: 'EditNode', id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', addPrerequisites: [], removePrerequisites: ['wind'] }],
        ['event', 'roadmap_board_edit', { step: 'saved', name: true, description: true, kind: true, prerequisites: true }],
      ]);
    }
  }
});

for (const undo of [false, true]) {
  test(`Graph detail delete uses the shared held policy${undo ? ' and Undo cancels it' : ' and releases once'}`, () => {
    const { acts, c, calls } = fixture({ active: false, graphActive: true });
    c.onGraphReveal = (id) => calls.push(['graph reveal', id]);
    assert.equal(acts.delete(['wind'], 'menu'), true);
    assert.deepEqual({ surface: c.toast.surface, act: c.toast.act, holdMs: c.toast.holdMs }, {
      surface: 'graph', act: 'delete', holdMs: 9000,
    });
    assert.deepEqual(acts.pending.surface, 'graph');
    assert.deepEqual(calls, [
      ['event', 'roadmap_graph_toast', { act: 'delete', step: 'shown' }],
      ['event', 'roadmap_board_delete', { step: 'held', door: 'menu', view: 'graph' }],
    ]);
    calls.length = 0;
    if (undo) c.toast.action.run();
    c.toast.onLeave('timer');
    c.toast.onLeave('timer');
    assert.equal(c.held, null);
    assert.deepEqual(calls, undo ? [
      ['quiet'], ['graph reveal', 'wind'], ['event', 'roadmap_graph_toast', { act: 'delete', step: 'undo' }],
    ] : [
      ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }],
      ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer', view: 'graph' }],
    ]);
  });
}

for (const origin of ['board', 'graph']) {
  test(`a ${origin} held delete survives redraw but releases on leaving its originating view`, (t) => {
    const { c, calls } = fixture({ active: origin === 'board', graphActive: origin === 'graph' });
    const previousWindow = globalThis.window;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    const hook = renderHook(t, () => useBoardActs(c));
    t.after(() => { globalThis.window = previousWindow; });
    const acts = hook.tree.acts;
    acts.delete(['wind'], 'menu');
    calls.length = 0;
    hook.redraw();
    assert.deepEqual(calls, []);
    assert.deepEqual(acts.held.ids, ['wind']);
    c.active = origin !== 'board';
    c.graphActive = origin !== 'graph';
    hook.redraw();
    assert.equal(acts.held, null);
    assert.deepEqual(calls, [
      ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }],
      ['event', 'roadmap_board_delete', { step: 'sent', via: 'left', view: origin }],
    ]);
  });
}

test('delete confirmation and cancellation identify the current Graph surface', () => {
  const { acts, calls } = fixture({ active: false, graphActive: true });
  acts.deletePrompt('confirm');
  acts.deletePrompt('cancel');
  acts.deletePrompt('other');
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'confirm', view: 'graph' }],
    ['event', 'roadmap_board_delete', { step: 'cancel', view: 'graph' }],
  ]);
});

test('the edit door belongs to the active owner detail only', () => {
  for (const [owner, id] of [[false, 'wind'], [true, 'dock'], [true, 'wind']]) {
    const calls = [];
    const composer = new BoardComposer({ owner, detailId: 'wind', composer: null,
      onOpen: (draft) => calls.push(draft) });
    composer.openEdit(id);
    assert.deepEqual(calls, owner && id === 'wind' ? [{ door: 'detail', editing: 'wind' }] : []);
  }
});

test('closing, removing or replacing an edit detail immediately excludes its composer and rejects writes', () => {
  for (const detailId of [null, 'dock', 'wind']) {
    const calls = [];
    const draft = { door: 'detail', editing: 'wind' };
    const composer = new BoardComposer({ owner: true, detailId, composer: draft,
      acts: { edit: (request) => { calls.push(request); return { ok: true }; } } });
    const request = { id: 'wind', label: 'Read the wind' };
    assert.equal(composer.shown, detailId === 'wind' ? draft : null);
    assert.deepEqual(composer.saveEdit(request), { ok: detailId === 'wind' });
    assert.deepEqual(calls, detailId === 'wind' ? [request] : []);
  }
});

test('edit save refuses a lost owner', () => {
  const composer = new BoardComposer({ owner: false, detailId: 'wind',
    composer: { door: 'detail', editing: 'wind' },
    acts: { edit: () => assert.fail('an unavailable edit must not dispatch') } });
  assert.equal(composer.shown, null);
  assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
});

test('create composers remain visible without a detail but cannot write through the edit door', () => {
  const draft = { door: 'verbs' };
  const composer = new BoardComposer({ owner: true, detailId: null, composer: draft,
    acts: { edit: () => assert.fail('a create draft must not dispatch an edit') },
    onOpen: () => assert.fail('there is no detail to edit') });
  assert.equal(composer.shown, draft);
  composer.openEdit(null);
  assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
});

test('C or a swipe on a card that opens a tree completes nothing: the toast says what completes it and offers the way in', () => {
  const cases = [
    [Opening.fromWire({ treeId: 't_wind', title: 'Wind drills', state: 'open', done: 3, total: 8, loop: false }), 'Completes with its tree', true],
    [Opening.fromWire({ treeId: 't_wind', title: 'Wind drills', state: 'open', done: 0, total: 0, loop: false }), 'Completes with its tree', true],
    [Opening.fromWire({ treeId: 't_wind', title: 'Wind drills', state: 'open', done: 3, total: 8, loop: true }), 'Won’t complete by itself', true],
    [Opening.fromWire({ treeId: 't_gone', missing: true }), 'Can’t complete yet', false],
    [Opening.fromWire({ treeId: 'sail', title: 'Sail', state: 'open', done: 1, total: 2, loop: true }).inItsOwnTree(), 'Won’t complete by itself', false],
    [Opening.unread('t_wind'), null, false],
  ];
  for (const [opening, said, leads] of cases) {
    const opened = [];
    const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
      { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'blue', opens: opening.treeId, opening },
      { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'blue' },
    ] });
    const { acts, c, calls } = fixture({ tree, openTree: (id, door) => opened.push([id, door]) });

    assert.equal(acts.complete('wind', 'key'), false);
    assert.equal(acts.complete('wind', 'swipe'), false);
    assert.deepEqual(calls, []);
    if (said === null) {
      assert.equal(c.toast, undefined);
      continue;
    }
    const { action, ...toast } = c.toast;
    assert.deepEqual(toast, { message: said, surface: 'board', act: 'tree', reveal: null, holdMs: 6000 });
    assert.equal(action?.label, leads ? 'Open tree' : undefined);
    action?.run();
    assert.deepEqual(opened, leads ? [['wind', 'toast']] : []);
  }
});

test('where no tree can be gone into, the toast a C raises says what completes the step and offers nothing', () => {
  const opening = Opening.fromWire({ treeId: 't_wind', title: 'Wind drills', state: 'open', done: 3, total: 8, loop: false });
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [{ id: 'wind', label: 'Read the wind', prerequisites: [], color: 'blue', opens: 't_wind', opening }] });
  const { acts, c, calls } = fixture({ tree, openTree: null });

  assert.equal(acts.complete('wind', 'key'), false);

  assert.deepEqual(c.toast, { message: 'Completes with its tree', surface: 'board', act: 'tree', reveal: null, holdMs: 6000 });
  assert.deepEqual(calls, []);
});

function myYear(sail = {}) {
  return new SkillTree({ id: 't_year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [], color: 'gold' },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], color: 'sky', ...sail },
    { id: 'coast', label: 'Sail the coast', prerequisites: ['sail'], color: 'sky' },
  ] });
}
const marked = (...ids) => ({ completed: new Set(ids), completedAt: {} });

test('attaching a tree is one gesture with one toast: Tree attached, six seconds, in the room’s seat, and Undo reverts its receipt', () => {
  const { acts, c, calls, receipt } = fixture({ tree: myYear(), progress: marked('plan', 'sail'), band: 'desktop' });

  assert.deepEqual(acts.setTree('sail', 't_sail'), { ok: true });

  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'SetNodeTree', id: 'sail', opens: 't_sail' }],
    ['event', 'roadmap_tree_attach', { step: 'attach', band: 'desktop', view: 'board', mark: 'kept' }],
  ]);
  const { action, ...toast } = c.toast;
  assert.deepEqual(toast, { message: 'Tree attached', act: 'attach', reveal: null, holdMs: 6000 });
  assert.deepEqual({ label: action.label, receipt: action.receipt }, { label: 'Undo', receipt: true });
  action.run();
  assert.deepEqual(calls.slice(3), [['quiet'], ['revert', receipt], ['event', 'roadmap_tree_attach', { step: 'undo', band: 'desktop', view: 'board' }]]);
});

test('a step that opens a tree already changes it, and a step with no mark says so in the event', () => {
  const { acts, c, calls } = fixture({ tree: myYear({ opens: 't_sail' }), progress: marked('plan'), band: 'phone' });

  assert.deepEqual(acts.setTree('sail', 't_coast'), { ok: true });

  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'SetNodeTree', id: 'sail', opens: 't_coast' }],
    ['event', 'roadmap_tree_attach', { step: 'change', band: 'phone', view: 'board', mark: 'none' }],
  ]);
  assert.equal(c.toast.message, 'Tree attached');
});

test('detaching says the mark is back only where the step held one', () => {
  const held = fixture({ tree: myYear({ opens: 't_sail' }), progress: marked('plan', 'sail'), band: 'tablet' });
  assert.deepEqual(held.acts.setTree('sail', ''), { ok: true });
  assert.deepEqual(held.calls, [
    ['quiet'],
    ['dispatch', { kind: 'SetNodeTree', id: 'sail', opens: '' }],
    ['event', 'roadmap_tree_attach', { step: 'detach', band: 'tablet', view: 'board', mark: 'kept' }],
  ]);
  const { action, ...toast } = held.c.toast;
  assert.deepEqual(toast, { message: 'Tree detached · your mark is back', act: 'detach', reveal: null, holdMs: 6000 });
  assert.equal(action.label, 'Undo');

  const bare = fixture({ tree: myYear({ opens: 't_sail' }), progress: marked('plan'), band: 'tablet' });
  bare.acts.setTree('sail', '');
  assert.equal(bare.c.toast.message, 'Tree detached');
  assert.deepEqual(bare.calls.at(-1), ['event', 'roadmap_tree_attach', { step: 'detach', band: 'tablet', view: 'board', mark: 'none' }]);
});

test('the step’s page over the Graph attaches through the same act, named as the Graph', () => {
  const { acts, calls } = fixture({ tree: myYear(), progress: marked('plan'), active: false, graphActive: true, band: 'desktop' });

  assert.deepEqual(acts.setTree('sail', 't_sail'), { ok: true });
  assert.deepEqual(calls.at(-1), ['event', 'roadmap_tree_attach', { step: 'attach', band: 'desktop', view: 'graph', mark: 'none' }]);
});

test('a write the session will not take, one that throws and a missing session say the tree could not be changed, with no Undo and no event', () => {
  const refused = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop', session: holdingSession({ dispatch: () => null }) });
  assert.deepEqual(refused.acts.setTree('sail', 't_sail'), { ok: false });
  assert.deepEqual(refused.c.toast, { message: 'Couldn’t change the tree. Try again.', act: 'notice' });
  assert.deepEqual(refused.calls, [['quiet']]);

  const thrown = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop', session: holdingSession({ dispatch: () => { throw new Error('lattice'); } }) });
  assert.deepEqual(thrown.acts.setTree('sail', 't_sail'), { ok: false });
  assert.deepEqual(thrown.c.toast, { message: 'Couldn’t change the tree. Try again.', act: 'notice' });
  assert.deepEqual(thrown.calls, [['quiet'], ['report', 'roadmap-tree-attach']]);

  const sessionless = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop', session: null });
  assert.deepEqual(sessionless.acts.setTree('sail', 't_sail'), { ok: false });
  assert.deepEqual(sessionless.calls, [['quiet']]);
});

test('no tree is set for a reader, off both views, on a step the roadmap lacks or on one held in a pending delete', () => {
  const quiet = (overrides, id = 'sail') => {
    const { acts, c, calls } = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop', ...overrides });
    return { answer: acts.setTree(id, 't_sail'), calls, toast: c.toast };
  };

  assert.deepEqual(quiet({ owner: false }), { answer: { ok: false }, calls: [], toast: undefined });
  assert.deepEqual(quiet({ active: false, graphActive: false }), { answer: { ok: false }, calls: [], toast: undefined });
  assert.deepEqual(quiet({}, 'gone'), { answer: { ok: false }, calls: [], toast: undefined });

  const { acts, c, calls } = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop' });
  acts.delete(['coast'], 'menu');
  const held = c.toast;
  assert.deepEqual(acts.setTree('coast', 't_sail'), { ok: false });
  assert.equal(c.toast, held);
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), []);
});

test('an Undo whose receipt is spent says nothing, and one that throws reports', () => {
  const spent = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop' });
  spent.c.session.revert = () => false;
  spent.acts.setTree('sail', 't_sail');
  spent.c.toast.action.run();
  assert.deepEqual(spent.calls.slice(3), [['quiet']]);

  const thrown = fixture({ tree: myYear(), progress: marked('plan'), band: 'desktop' });
  thrown.c.session.revert = () => { throw new Error('lattice'); };
  thrown.acts.setTree('sail', 't_sail');
  thrown.c.toast.action.run();
  assert.deepEqual(thrown.calls.slice(3), [['quiet'], ['report', 'roadmap-tree-attach']]);
});
