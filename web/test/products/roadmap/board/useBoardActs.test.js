import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { BoardActs, BoardComposer } from '../../../../src/products/roadmap/board/useBoardActs.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';

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
    session: { dispatch: (gesture) => { calls.push(['dispatch', gesture]); return receipt; }, revert: (value) => { calls.push(['revert', value]); return true; } },
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
    assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }]]);
    c.toast.onLeave(via);
    c.toast.onLeave(via);
    acts.release(via);
    assert.equal(c.held, null);
    assert.deepEqual(calls, [
      ['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }],
      ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'], retireIncidentEdges: true }],
      ['event', 'roadmap_board_delete', { step: 'sent', via }],
    ]);
  });
}

test('delete Undo restores the projection and sends nothing even when its toast leaves', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  c.toast.action.run();
  c.toast.onLeave('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }], ['quiet'], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'delete' }]]);
});

test('a new held delete releases its predecessor and owns its own Undo', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  const first = c.toast;
  acts.delete(['dock'], 'menu');
  first.action.run();
  first.onLeave('replaced');
  assert.deepEqual(c.held.ids, ['dock']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'], retireIncidentEdges: true }]]);
});

test('a release retains its original session across roadmap changes', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  acts.update({ ...c, session: { dispatch() { throw Error('Wrong session'); } } });
  acts.release('left');
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'], retireIncidentEdges: true }]]);
});

test('a no-op release clears the projection without reporting an expected refusal', () => {
  const { acts, c, calls } = fixture({ session: { dispatch: () => null } });
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }], ['quiet']]);
  assert.deepEqual(c.errors, []);
});

test('an unexpected release failure reports its original error for stack frames', () => {
  const error = new Error('private content');
  const { acts, c, calls } = fixture({ session: { dispatch: () => { throw error; } } });
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }], ['quiet'], ['report', 'roadmap-board-delete']]);
  assert.deepEqual(c.errors, [error]);
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

test('Graph availability permits owner create only, without enabling Board mutation doors', () => {
  for (const owner of [false, true]) {
    const { acts, c, calls } = fixture({ active: false, graphActive: true, owner });
    c.onGraphReveal = () => {};
    assert.equal(acts.complete('wind', 'key'), false);
    assert.equal(acts.delete(['wind']), false);
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

test('Graph composers expose create for owners behind the gate and reject every edit door', () => {
  for (const gate of [false, true]) {
    for (const owner of [false, true]) {
      const draft = { door: 'verbs', view: 'tree' };
      const composer = new BoardComposer({ gate, active: false, owner, view: 'tree',
        detailId: 'wind', composer: draft,
        acts: { edit: () => assert.fail('Graph must not dispatch Board edits') },
        onOpen: () => assert.fail('Graph must not open Board edits'),
      });
      assert.equal(composer.shown, gate && owner ? draft : null);
      composer.openEdit('wind');
      assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
      composer.composer = { door: 'detail', view: 'tree', editing: 'wind' };
      assert.equal(composer.shown, null);
      assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
    }
  }
});

test('a composer is hidden immediately after switching away from its originating view', () => {
  for (const origin of ['board', 'tree']) {
    for (const view of ['board', 'tree']) {
      const draft = { door: 'verbs', view: origin };
      const composer = new BoardComposer({ gate: true, active: view === 'board', owner: true,
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
    ['event', 'roadmap_board_delete', { step: 'confirm' }],
    ['event', 'roadmap_board_delete', { step: 'cancel' }],
  ]);
});

test('Board create and held release opt into truthful dispatch receipts', () => {
  const options = [];
  const { acts } = fixture({ session: { dispatch: (_gesture, value) => { options.push(value); return {}; } } });
  acts.create(request);
  acts.delete(['wind'], 'menu');
  acts.release('timer');
  assert.deepEqual(options, [{ captureFailures: true }, { captureFailures: true }]);
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
      ['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }],
      ['event', 'roadmap_board_delete', { step: 'sent', via }],
    ]);
  });
}

test('recolor dispatches once with truthful capture, preserves the query and Undo targets its receipt quietly', () => {
  const options = [];
  const { acts, c, calls, receipt } = fixture();
  const dispatch = c.session.dispatch;
  c.session.dispatch = (gesture, capture) => { options.push(capture); return dispatch(gesture); };
  assert.deepEqual(acts.recolor(['wind', 'dock'], 'gold'), { ok: true, changed: true });
  assert.equal(c.toast.message, '2 steps recolored');
  assert.equal(c.toast.holdMs, 6000);
  assert.deepEqual(options, [{ captureFailures: true }]);
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
    ['event', 'roadmap_board_delete', { step: 'held', door: 'bulk' }],
    ['event', 'roadmap_board_bulk', { step: 'delete', count: '2-5' }],
    ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind', 'dock'], retireIncidentEdges: true }],
    ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer' }],
  ]);
  calls.length = 0;
  assert.equal(acts.delete(['dock'], 'key'), true);
  c.toast.action.run();
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'key' }],
    ['quiet'], ['reveal', 'dock'], ['event', 'roadmap_board_undo', { act: 'delete' }],
  ]);
});

const editRequest = { id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', prerequisites: [] };

test('edit diffs, marks quiet before one captured write, emits rename and bounded changes without toast', () => {
  const { acts, c, calls } = fixture();
  const options = [];
  const dispatch = c.session.dispatch;
  c.session.dispatch = (gesture, capture) => { options.push(capture); return dispatch(gesture); };
  c.emit = (event) => calls.push(['activity', event]);
  assert.deepEqual(acts.edit(editRequest), { ok: true });
  assert.deepEqual(options, [{ captureFailures: true }]);
  assert.equal(c.toast, undefined);
  assert.deepEqual(calls, [
    ['quiet'],
    ['dispatch', { kind: 'EditNode', id: 'dock', label: 'Leave the harbor', description: 'Practice', color: 'gold', addPrerequisites: [], removePrerequisites: ['wind'] }],
    ['activity', { verb: 'renamed', nodeId: 'dock', label: 'Leave the harbor', kind: 'gold' }],
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
    ['event', 'roadmap_board_delete', { step: 'held', door: 'bulk' }],
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


test('receipt invalidation dismisses its captured toast without releasing a held delete', () => {
  const calls = [];
  const { acts, c } = fixture({ dismissInvalidatedToast: () => calls.push('dismiss') });
  acts.delete(['wind'], 'menu');
  const held = c.held;
  const pending = acts.pending;
  acts.invalidateReceipts();
  assert.deepEqual(calls, ['dismiss']);
  assert.equal(acts.held, held);
  assert.equal(acts.pending, pending);
  assert.equal(c.held, held);
});


test('a held delete whose timer expires during discard waits for the server baseline', () => {
  const { acts, c, calls } = fixture();
  acts.delete(['wind'], 'menu');
  const held = c.held;
  c.session.rebaselining = 'structure';
  acts.release('timer');
  assert.equal(acts.held, held);
  assert.equal(acts.pending.held, held);
  assert.equal(acts.pending.releaseVia, 'timer');
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }]]);
  c.session.rebaselining = null;
  acts.release(acts.pending.releaseVia);
  assert.equal(acts.held, null);
  assert.equal(acts.pending, null);
  assert.deepEqual(calls, [
    ['event', 'roadmap_board_delete', { step: 'held', door: 'menu' }],
    ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'], retireIncidentEdges: true }],
    ['event', 'roadmap_board_delete', { step: 'sent', via: 'timer' }],
  ]);
});
