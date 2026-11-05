import test from 'node:test';
import assert from 'node:assert/strict';
import { LegendStore } from '../../../../src/products/roadmap/persistence/LegendStore.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { MilestoneLedger } from '../../../../src/products/roadmap/persistence/MilestoneLedger.js';
import { PlaceStore } from '../../../../src/products/roadmap/persistence/PlaceStore.js';
import { ProgressStore } from '../../../../src/products/roadmap/persistence/ProgressStore.js';
import { ReturnLedger } from '../../../../src/products/roadmap/persistence/ReturnLedger.js';
import { ViewPrefs, clearBorn, noteForked, notePlantedQuest, peekBorn, stampBorn, takePlantNote } from '../../../../src/products/roadmap/persistence/ViewPrefs.js';
import { WorkspaceStore } from '../../../../src/products/roadmap/persistence/WorkspaceStore.js';

function refuseStorage(t) {
  const refuse = () => { throw new DOMException('Access is denied for this document.', 'SecurityError'); };
  const refusing = { get localStorage() { return refuse(); }, get sessionStorage() { return refuse(); } };
  const before = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: refusing });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: refuse });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

test('every store opens where the browser refuses storage, reads nothing and keeps nothing', (t) => {
  refuseStorage(t);
  const legend = new LegendStore();
  legend.save('sail', { kinds: [], open: true });
  const place = new PlaceStore();
  place.save({ treeId: 'sail', layout: 'bubble' });
  const prefs = new ViewPrefs();
  prefs.setLastView('sail', 'board');
  const returns = new ReturnLedger();
  returns.save('sail', { completed: new Set(['wind']), at: 1 });
  const milestones = new MilestoneLedger();
  milestones.markOffered('sail', 'first');
  const registry = new LocalTreeRegistry();
  registry.record('sail', 'Learn to sail', null);
  const workspaces = new WorkspaceStore();
  workspaces.save('sail', { wind: {} });
  assert.deepEqual({
    legend: legend.load('sail'), legendTrees: legend.treeIds(),
    place: place.load('bubble'),
    view: prefs.lastView('sail'),
    returned: returns.load('sail'), returnTrees: returns.treeIds(),
    offered: [...milestones.load('sail')], offeredFirst: milestones.has('sail', 'first'), milestoneTrees: milestones.treeIds(),
    trees: registry.list(null),
    workspace: workspaces.load('sail'), workspaceTrees: workspaces.treeIds(),
    progressTrees: new ProgressStore().treeIds(),
  }, {
    legend: null, legendTrees: [],
    place: null,
    view: null,
    returned: null, returnTrees: [],
    offered: [], offeredFirst: false, milestoneTrees: [],
    trees: [],
    workspace: null, workspaceTrees: [],
    progressTrees: [],
  });
});

test('a planting door\'s notes read as unwritten where the browser refuses storage', (t) => {
  refuseStorage(t);
  stampBorn('sail');
  notePlantedQuest();
  noteForked();
  assert.deepEqual([peekBorn('sail'), takePlantNote()], [false, { quest: false, forked: false }]);
  clearBorn('sail');
});

test('a store reaches the browser\'s storage while the browser offers it', (t) => {
  const items = new Map();
  const offered = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: offered } });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'window', before);
    else delete globalThis.window;
  });
  new LegendStore().save('sail', { kinds: [], open: true });
  assert.deepEqual(new LegendStore().load('sail'), { kinds: [], open: true });
});
