import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardActs } from '../../../../src/products/roadmap/board/useBoardActs.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';

function fixture(overrides = {}) {
  const calls = [];
  const receipt = {};
  const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
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
    track: (name, props) => calls.push(['event', name, props]), report: (op) => calls.push(['report', op]),
    ...overrides,
  };
  return { acts: new BoardActs(c), c, calls, receipt };
}

for (const via of ['timer', 'replaced', 'left']) {
  test(`held deletion releases once through ${via}`, () => {
    const { acts, c, calls } = fixture();
    acts.delete('wind');
    assert.equal(c.held.ids[0], 'wind');
    assert.equal(c.toast.holdMs, 9000);
    assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held' }]]);
    c.toast.onLeave(via);
    c.toast.onLeave(via);
    acts.release(via);
    assert.equal(c.held, null);
    assert.deepEqual(calls, [
      ['event', 'roadmap_board_delete', { step: 'held' }],
      ['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }],
      ['event', 'roadmap_board_delete', { step: 'sent', via }],
    ]);
  });
}

test('delete Undo restores the projection and sends nothing even when its toast leaves', () => {
  const { acts, c, calls } = fixture();
  acts.delete('wind');
  c.toast.action.run();
  c.toast.onLeave('timer');
  assert.equal(c.held, null);
  assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held' }], ['quiet'], ['reveal', 'wind'], ['event', 'roadmap_board_undo', { act: 'delete' }]]);
});

test('a new held delete releases its predecessor and owns its own Undo', () => {
  const { acts, c, calls } = fixture();
  acts.delete('wind');
  const first = c.toast;
  acts.delete('dock');
  first.action.run();
  first.onLeave('replaced');
  assert.deepEqual(c.held.ids, ['dock']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }]]);
});

test('a release retains its original session across roadmap changes', () => {
  const { acts, c, calls } = fixture();
  acts.delete('wind');
  acts.update({ ...c, session: { dispatch() { throw Error('Wrong session'); } } });
  acts.release('left');
  assert.deepEqual(calls.filter(([kind]) => kind === 'dispatch'), [['dispatch', { kind: 'BulkDelete', nodeIds: ['wind'] }]]);
});

for (const dispatch of [() => null, () => { throw Error('private content'); }]) {
  test('release failure restores the Board and reports only a static operation', () => {
    const { acts, c, calls } = fixture({ session: { dispatch } });
    acts.delete('wind');
    acts.release('timer');
    assert.equal(c.held, null);
    assert.deepEqual(calls, [['event', 'roadmap_board_delete', { step: 'held' }], ['quiet'], ['report', 'roadmap-board-delete']]);
  });
}

test('complete snapshots progress; Undo targets its own step and reveal names the newly unlocked step', () => {
  const { acts, c, calls } = fixture();
  const before = c.progress;
  acts.complete('wind', 'key');
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
    acts.complete(Object.keys(options).length ? 'wind' : 'dock', 'key');
    assert.deepEqual(calls, []);
  }
});

const request = Object.freeze({ id: 'reef', label: 'Reefing basics', description: '', color: 'blue', prerequisites: ['wind'] });

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
    const { acts, calls } = fixture({ session });
    assert.deepEqual(acts.create(request), { ok: false });
    assert.deepEqual(calls, [['report', 'roadmap-board-create']]);
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
  acts.delete('wind');
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
