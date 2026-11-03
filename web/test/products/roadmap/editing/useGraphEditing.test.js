import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { useGraphEditing } from '../../../../src/products/roadmap/editing/useGraphEditing.js';
import { useTabletEditing } from '../../../../src/products/roadmap/ui/tablet/useTabletEditing.js';
import { useRoomTend } from '../../../../src/products/roadmap/tending/useTend.js';
import { parsePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';
import { edgeKey } from '../../../../src/products/roadmap/scene/edgeKey.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { renderHook } from '../../gym/harness.mjs';

const SAIL = { id: 'sail', title: 'Sail', nodes: [
  { id: 'course', label: 'Choose a course', prerequisites: [], color: 'terracotta' },
  { id: 'wind', label: 'Read the wind', prerequisites: ['course'], color: 'terracotta' },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'terracotta' },
  { id: 'knots', label: 'Tie the knots', prerequisites: ['course'], color: 'terracotta' },
] };

function room(t) {
  const session = new SyncSession({ treeId: 'sail', registry: null, store: { save: () => Promise.resolve() }, reportFailure: () => {} });
  session.seed(SAIL);
  const projectionRef = { current: session.lattice.toTreeData() };
  session.onTreeChanged((data) => { projectionRef.current = data; });
  const toasts = [];
  const selectedIdRef = { current: null };
  const scene = {
    nodesById: new Map(SAIL.nodes.map((node) => [node.id, node])),
    select() {}, pulseNode() {}, setLongPress() {}, setFaded() {}, clearFaded() {}, pickEdge: () => null,
    setEditTap(handler) { this.tap = handler; },
  };
  const selection = {
    selectedIdRef, selectedIdsRef: { current: new Set() }, selectedEdgesRef: { current: new Set() },
    setSelectedId: (id) => { selectedIdRef.current = id; }, leaveMulti() {}, enterMulti() {}, toggleMember() {}, multiMode: false,
  };
  const editing = renderHook(t, () => useGraphEditing({
    room: { sessionRef: { current: session }, projectionRef, sceneRef: { current: scene }, treeRef: { current: null } },
    legendRef: { current: [] }, desktopEditorRef: { current: true }, selection, emit() {},
    showToast: (message, options) => toasts.push({ message, ...options }),
  }));
  const tablet = renderHook(t, () => useTabletEditing({
    tabletEditor: true, scene, tree: new SkillTree(session.lattice.toTreeData()),
    nodesById: new Map(session.lattice.toTreeData().nodes.map((node) => [node.id, node])), selectedNode: null, projectionRef, selection, editing: editing.tree,
  }));
  return { session, editing, tablet, scene, selection, toasts };
}

const steps = (session) => Object.fromEntries(session.lattice.toTreeData().nodes.map(({ id, label, color, prerequisites }) => [id, { label, color, prerequisites: [...prerequisites] }]));
const LATER_RENAME = 'Tie better knots';
const later = (session) => session.dispatch({ kind: 'RenameNode', id: 'knots', label: LATER_RENAME });
const withLater = (expected) => ({ ...expected, knots: { ...expected.knots, label: LATER_RENAME } });

const ACTS = [
  ['Graph delete', 'delete', 'Step deleted', ({ editing }) => editing.tree.deleteNodeAt('dock')],
  ['Graph bulk delete', 'delete', '1 step and 1 link deleted', ({ editing, selection }) => {
    selection.selectedIdsRef.current = new Set(['dock']);
    selection.selectedEdgesRef.current = new Set([edgeKey('course', 'knots')]);
    editing.tree.bulkDelete();
  }],
  ['Graph bulk recolor', 'recolor', '2 steps recolored', ({ editing, selection }) => {
    selection.selectedIdsRef.current = new Set(['wind', 'dock']);
    editing.tree.bulkRecolor('gold');
  }],
  ['paste graft', 'graft', 'Added 2 steps under “Choose a course”', ({ editing }) => {
    editing.tree.graftImported(parsePlan('- Rent a boat\n- Find a crew', [], { bindOnly: true }));
  }],
  ['tablet rename', 'rename', 'Renamed', ({ tablet }) => tablet.tree.renameStep('wind', 'Read the sky')],
  ['tablet recolor', 'recolor', 'Recolored', ({ tablet }) => tablet.tree.recolorStep('wind', 'gold')],
  ['tablet add step', 'add', 'Step added', ({ tablet }) => tablet.tree.addStepUnder('course')],
  ['tablet link removal', 'link_remove', 'Link removed', ({ tablet }) => {
    tablet.tree.setRemoving({ from: 'wind', to: 'dock' });
    tablet.tree.removeLink();
  }],
  ['tablet link', 'link_add', 'Linked', ({ tablet, scene }) => {
    tablet.tree.enterAim('knots');
    scene.tap(0, 0, 'dock');
  }],
];

for (const [name, act, message, perform] of ACTS) {
  test(`${name}: its toast Undo after a later gesture reverts only its own act`, (t) => {
    const fixture = room(t);
    const { session, toasts } = fixture;
    const before = steps(session);
    perform(fixture);
    assert.notDeepEqual(steps(session), before);
    assert.equal(toasts.length, 1);
    const { action, ...options } = toasts[0];
    assert.deepEqual(options, { message, surface: 'graph', act });
    assert.deepEqual({ label: action.label, receipt: action.receipt }, { label: 'Undo', receipt: true });
    later(session);
    action.run();
    assert.deepEqual(steps(session), withLater(before));
    action.run();
    assert.deepEqual(steps(session), withLater(before));
    session.undo();
    assert.deepEqual(steps(session), before);
  });

  test(`${name}: an act the global stack already took back leaves its toast Undo with nothing to do`, (t) => {
    const fixture = room(t);
    const { session, toasts } = fixture;
    const before = steps(session);
    perform(fixture);
    session.undo();
    assert.deepEqual(steps(session), before);
    later(session);
    toasts[0].action.run();
    assert.deepEqual(steps(session), withLater(before));
  });

  test(`${name}: a session that takes nothing says nothing`, (t) => {
    const fixture = room(t);
    fixture.session.ready = false;
    perform(fixture);
    assert.deepEqual(fixture.toasts, []);
  });
}

test('Undo of an added step clears the selection it took, and a later naming goes with it', (t) => {
  const fixture = room(t);
  const { session, selection, toasts, tablet } = fixture;
  const before = steps(session);
  tablet.tree.addStepUnder('course');
  const added = selection.selectedIdRef.current;
  assert.ok(added);
  session.dispatch({ kind: 'RenameNode', id: added, label: 'Named after planting' });
  toasts[0].action.run();
  assert.equal(selection.selectedIdRef.current, null);
  assert.deepEqual(steps(session), before);
});

test('naming a new step is part of adding it and asks for no toast; renaming a named one does', (t) => {
  const fixture = room(t);
  const { session, toasts, tablet } = fixture;
  session.dispatch({ kind: 'CreateNode', id: 'bud', label: '', parentId: 'course' });
  tablet.tree.renameStep('bud', 'Named');
  assert.deepEqual(toasts, []);
  tablet.tree.renameStep('bud', 'Renamed');
  assert.equal(toasts.length, 1);
});

test('an unchanged rename writes nothing and asks for no toast', (t) => {
  const fixture = room(t);
  const stack = fixture.session.undoStack.length;
  fixture.tablet.tree.renameStep('wind', 'Read the wind');
  assert.deepEqual([fixture.session.undoStack.length, fixture.toasts], [stack, []]);
});

test('Ask AI: its Undo deletes exactly what the run planted, keeps a later gesture, and says so', async (t) => {
  const { session } = room(t);
  session.dispatch({ kind: 'CreateNode', id: 'ai-1', label: 'From the run', parentId: 'course', color: 'terracotta' });
  const before = steps(session);
  const toasts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('/tend')
      ? { status: 'done', summary: 'Added 1 step', edits: 1, created: ['ai-1'], detail: 'One step fits here.' }
      : { enabled: true }),
  });
  t.after(() => { globalThis.fetch = realFetch; });
  const tend = renderHook(t, () => useRoomTend({
    treeId: 'sail', treeMine: true, status: 'signed-in', shared: false, demo: false, demotion: null,
    room: { sessionRef: { current: session }, sceneRef: { current: null } }, showToast: (message, options) => toasts.push({ message, ...options }),
  }));
  await tend.tree.submitTend('Add a step');
  const { action, ...receipt } = toasts[0];
  assert.deepEqual(receipt, { message: 'Added 1 step', surface: 'tend', holdMs: 6000, detail: 'One step fits here.' });
  assert.equal(action.label, 'Undo');
  later(session);
  action.run();
  const { 'ai-1': planted, ...rest } = before;
  assert.ok(planted);
  assert.deepEqual(steps(session), withLater(rest));
  assert.deepEqual(toasts.slice(1), [{ message: 'AI changes reverted', surface: 'tend' }]);
});

test('Ask AI: an Undo the session cannot take claims nothing', async (t) => {
  const toasts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('/tend') ? { status: 'done', summary: 'Added 1 step', edits: 1, created: ['ai-1'] } : { enabled: true }),
  });
  t.after(() => { globalThis.fetch = realFetch; });
  const tend = renderHook(t, () => useRoomTend({
    treeId: 'sail', treeMine: true, status: 'signed-in', shared: false, demo: false, demotion: null,
    room: { sessionRef: { current: { dispatch: () => null } }, sceneRef: { current: null } }, showToast: (message, options) => toasts.push({ message, ...options }),
  }));
  await tend.tree.submitTend('Add a step');
  toasts[0].action.run();
  assert.equal(toasts.length, 1);
});
