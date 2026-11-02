import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';

function sessionWith({ notify = () => {}, registry = null, save = () => Promise.resolve(), reportFailure = () => {} } = {}) {
  const session = new SyncSession({ treeId: 'tree', registry, store: { save }, reportFailure });
  session.seed({ id: 'tree', title: 'Tree', nodes: [{ id: 'root', label: 'Root', prerequisites: [] }] });
  session.onTreeChanged(notify);
  return session;
}

const snapshot = (session) => session.lattice.toTreeData().nodes.map(({ id, label, prerequisites }) => ({ id, label, prerequisites }));

test('dispatch returns null before ready and for gestures writing nothing', () => {
  const session = new SyncSession({ treeId: 'tree', registry: null });
  assert.equal(session.dispatch({ kind: 'CreateNode', id: 'x' }), null);
  assert.equal(session.revert({}), false);
  assert.deepEqual(session.undoStack, []);
  session.ready = true;
  assert.equal(session.dispatch({ kind: 'DeleteNode', id: 'absent' }), null);
  assert.deepEqual(session.undoStack, []);
});

test('a receipt reverts its own create once without undoing a newer gesture', () => {
  const session = sessionWith();
  const created = session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  const renamed = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed root' });
  assert.ok(Object.isFrozen(created));
  assert.equal(session.revert(created), true);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Renamed root', prerequisites: [] }]);
  assert.equal(session.revert(created), false);
  assert.equal(session.revert(null), false);
  assert.equal(session.undoStack.length, 1);
  assert.equal(session.revert(renamed), true);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }]);
  assert.deepEqual(session.undoStack, []);
  assert.deepEqual(session.redoStack, []);
});

test('a receipt is session-bound and a global Undo consumes its authority', () => {
  const session = sessionWith();
  const other = sessionWith();
  const receipt = session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  assert.equal(other.revert(receipt), false);
  session.undo();
  assert.equal(session.revert(receipt), false);
  session.redo();
  assert.equal(session.revert(receipt), false);
  assert.equal(session.lattice.toTreeData().nodes[0].color, 'sky');
});

test('revert restamps only the captured fields and preserves an unrelated later edit', () => {
  const session = sessionWith();
  const receipt = session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Later description' });
  assert.equal(session.revert(receipt), true);
  const step = session.lattice.toTreeData().nodes[0];
  assert.deepEqual({ color: step.color, description: step.description }, { color: 'terracotta', description: 'Later description' });
  assert.equal(session.undoStack.length, 1);
});

test('a pre-apply refusal preserves the undo journal and leaves no node', () => {
  const session = sessionWith();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
  session.undo();
  const redo = [...session.redoStack];
  assert.throws(() => session.dispatch({ kind: 'CreateNode', id: null, prerequisites: [] }, { captureFailures: true }), { message: 'malformed node entry' });
  assert.deepEqual(session.undoStack, []);
  assert.deepEqual(session.redoStack, redo);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }]);
});

test('applied writes keep their receipt when notification, persistence and send boundaries fail', () => {
  const failures = [];
  const session = sessionWith({ notify: () => { throw new Error('private notification'); },
    registry: { touch: () => { throw new Error('private storage'); } }, reportFailure: (operation) => failures.push(operation) });
  session.phase = 'live';
  session.ws = { readyState: 1, send: () => { throw new Error('private transport'); } };
  const receipt = session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] }, { captureFailures: true });
  assert.ok(receipt);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }, { id: 'child', label: 'Child', prerequisites: ['root'] }]);
  assert.deepEqual(failures, ['roadmap-sync-notify', 'roadmap-sync-persist', 'roadmap-sync-send']);
  assert.equal(session.durabilityAtRisk, true);
  assert.equal(session.revert(receipt), true);
});

test('asynchronous persistence failure reports safely after dispatch succeeded', async () => {
  const failures = [];
  const session = sessionWith({ save: () => Promise.reject(new Error('private storage')), reportFailure: (operation) => failures.push(operation) });
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' }, { captureFailures: true });
  await Promise.resolve();
  assert.ok(receipt);
  assert.deepEqual(failures, ['roadmap-sync-persist']);
  assert.equal(session.durabilityAtRisk, true);
});

test('legacy dispatch keeps post-apply boundary exceptions when failure capture is not requested', () => {
  const failures = [];
  const session = sessionWith({ notify: () => { throw new Error('legacy callback'); }, reportFailure: (operation) => failures.push(operation) });
  assert.throws(() => session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' }), { message: 'legacy callback' });
  assert.deepEqual(failures, []);
  assert.equal(session.undoStack.length, 1);
});
