import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { TREE_DOORS, enterTree, readTreeVisit, settleTreeVisit, useTreeVisit } from '../../../../src/products/roadmap/room/useTreeVisit.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

// A browser history of entries { href, state } with the window surface the visit and the shell's navigation read.
function browser(t, href = '/#/app/t_year') {
  const entries = [{ href, state: null }];
  let at = 0;
  const window = new EventTarget();
  const hrefOf = (url) => {
    const next = new URL(url, window.location.href);
    return next.pathname + next.hash;
  };
  const locate = () => {
    const [pathname, hash = ''] = entries[at].href.split('#');
    window.location = { origin: 'http://localhost', pathname, search: '', hash: hash ? `#${hash}` : '', href: `http://localhost${entries[at].href}` };
  };
  window.history = {
    get state() { return entries[at].state; },
    replaceState(state, unused, url) {
      entries[at] = { href: url ? hrefOf(url) : entries[at].href, state };
      locate();
    },
    pushState(state, unused, url) {
      entries.splice(at + 1, entries.length, { href: hrefOf(url), state });
      at += 1;
      locate();
    },
    back() { at -= 1; locate(); },
  };
  locate();
  const priors = ['window', 'PopStateEvent'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  Object.defineProperty(globalThis, 'PopStateEvent', { configurable: true, writable: true, value: Event });
  t.after(() => {
    for (const [name, prior] of priors) {
      if (prior) Object.defineProperty(globalThis, name, prior);
      else delete globalThis[name];
    }
  });
  return { window, entries, here: () => entries[at] };
}

const year = () => new SkillTree({ id: 't_year', title: 'My year', nodes: [
  { id: 'plan', label: 'Plan the year', prerequisites: [] },
  { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail', opening: Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false }) },
  { id: 'bike', label: 'Fix the bike', prerequisites: ['plan'], opens: 't_gone', opening: Opening.fromWire({ treeId: 't_gone', missing: true }) },
] });

const room = (view) => ({ standingTreeRef: { current: year() }, viewRef: { current: view } });

// This device's index of trees: My year is Olya's, a tree planted signed out is nobody's yet.
function deviceIndex() {
  const disk = new Map([['windmill:device-trees', JSON.stringify({
    t_year: { title: 'My year', updatedAt: 1, claimed: true, owner: 'u_olya' },
    t_sail: { title: 'Learn to sail', updatedAt: 2, claimed: true, owner: 'u_olya' },
    t_draft: { title: 'A draft', updatedAt: 3, claimed: false, owner: null },
  })]]);
  return new LocalTreeRegistry({ getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) });
}

const visitOf = ({ open, back, ...visit }) => visit;
// What the visit keeps on an entry, beside the shell's own navigation record.
const kept = ({ state }) => { const { windmillNavigation, ...ours } = state ?? {}; return ours; };

test('a direct link has no way back: its history entry says nothing of a visit', (t) => {
  browser(t, '/#/app/t_sail');

  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null });
  assert.deepEqual(readTreeVisit({ roadmapCameFrom: { treeId: 7 }, roadmapWentThrough: { view: 'tree' } }), { from: null, through: null, view: null, door: null });
  assert.deepEqual(readTreeVisit({ roadmapCameFrom: { title: 'My year', view: 'tree' } }), { from: null, through: null, view: null, door: null });
});

test('only an entry that names a step, or null for a way up, as what was gone through is a return', (t) => {
  browser(t, '/#/app/t_sail');
  const back = (roadmapWentThrough, more = {}) => readTreeVisit({ roadmapWentThrough, ...more });

  assert.deepEqual(back({ stepId: 'rig', view: 'board' }), { from: null, through: 'rig', view: 'board', door: 'back' });
  assert.deepEqual(back({ stepId: null, view: 'tree' }), { from: null, through: null, view: 'tree', door: 'back' });
  assert.deepEqual(back({ stepId: null }), { from: null, through: null, view: null, door: 'back' });
  assert.deepEqual(back({ stepId: null, view: 'tree' }, { roadmapCameFrom: { treeId: 't_year', view: 'board' } }), { from: 't_year', through: null, view: 'tree', door: 'back' });
  for (const odd of [undefined, null, 'rig', 7, {}, { view: 'tree' }, { stepId: 7 }, { stepId: undefined, view: 'tree' }, { stepId: {} }, []]) {
    assert.deepEqual(back(odd), { from: null, through: null, view: null, door: null }, JSON.stringify(odd));
  }
  assert.deepEqual(readTreeVisit(null), { from: null, through: null, view: null, door: null });
});

test('going in leaves ids and a view on the two entries and no title, and coming back finds the step gone through', (t) => {
  const { window, entries, here } = browser(t);
  let navigated = 0;
  window.addEventListener('popstate', () => { navigated += 1; });

  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'tree' });

  assert.equal(navigated, 1);
  assert.deepEqual(entries.map((entry) => ({ href: entry.href, kept: kept(entry) })), [
    { href: '/#/app/t_year', kept: { roadmapWentThrough: { stepId: 'sail', view: 'tree' } } },
    { href: '/#/app/t_sail', kept: { roadmapCameFrom: { treeId: 't_year', view: 'tree' } } },
  ]);
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.equal(here().href, '/#/app/t_year');
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'tree', door: 'back' });
});

test('an arrival is settled once: the entry keeps the tree it was reached from, and a reload or a Forward carries no view, step or door', (t) => {
  const { window, entries } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board' });

  settleTreeVisit();
  assert.deepEqual(kept(entries[1]), { roadmapCameFrom: { treeId: 't_year' } });
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: null, door: null });

  window.history.back();
  settleTreeVisit();
  settleTreeVisit();
  assert.deepEqual(kept(entries[0]), {});
  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null });
});

test('a chain pops one tree per press: the middle tree keeps where it was reached from when the person comes back to it', (t) => {
  const { window } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board' });
  settleTreeVisit();
  enterTree('t_knots', { from: 't_sail', stepId: 'bowline', view: 'tree' });
  assert.deepEqual(readTreeVisit(), { from: 't_sail', through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: 'bowline', view: 'tree', door: 'back' });
  settleTreeVisit();
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: null, door: null });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'board', door: 'back' });
});


test('the way back is shown to whoever holds the roadmap it leads to, under the title this device keeps for them, and to nobody else', (t) => {
  browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'tree' });
  const arrival = readTreeVisit();
  const events = [];
  const track = (name, props) => events.push({ name, props });
  const at = (holder, from = arrival) => renderHook(t, () => useTreeVisit({ room: room('tree'), arrival: from, holder, band: 'desktop', registry: deviceIndex(), track })).tree;

  assert.deepEqual(visitOf(at({ place: 'account', account: 'u_olya' })), { from: { id: 't_year', title: 'My year' }, through: null, view: 'tree', door: 'tree' });
  assert.equal(typeof at({ place: 'account', account: 'u_olya' }).open, 'function');

  const signedOut = at(null);
  assert.deepEqual(visitOf(signedOut), { from: null, through: null, view: null, door: null });
  assert.equal(signedOut.open, null);

  assert.deepEqual(visitOf(at({ place: 'account', account: 'u_maya' })), { from: null, through: null, view: 'tree', door: 'tree' });
  assert.deepEqual(visitOf(at({ place: 'account', account: 'u_olya' }, { ...arrival, from: 't_draft' })).from, null);
  assert.deepEqual(visitOf(at({ place: 'account', account: 'u_olya' }, { ...arrival, from: 't_unknown' })).from, null);

  assert.deepEqual(visitOf(at({ place: 'device' }, { ...arrival, from: 't_draft' })), { from: { id: 't_draft', title: 'A draft' }, through: null, view: 'tree', door: 'tree' });
  assert.equal(typeof at({ place: 'device' }).open, 'function');
  assert.deepEqual(visitOf(at({ place: 'device' })).from, null);
  assert.deepEqual(events, []);
});

test('opening a tree from a step says which door and where, and nothing of the tree, the step or their names', (t) => {
  const { entries } = browser(t);
  const events = [];
  const hook = renderHook(t, () => useTreeVisit({ room: room('board'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'phone', registry: deviceIndex(), track: (name, props) => events.push({ name, props }) }));

  assert.equal(hook.tree.open('bike', 'pill'), false);
  assert.equal(hook.tree.open('plan', 'pill'), false);
  assert.throws(() => hook.tree.open('sail', 'card'), /unknown tree door "card"/);
  assert.equal(hook.tree.open('sail', 'pill'), true);

  assert.deepEqual(entries.map(({ href }) => href), ['/#/app/t_year', '/#/app/t_sail']);
  assert.deepEqual(events, [{ name: 'roadmap_tree_open', props: { door: 'pill', view: 'board', band: 'phone', place: 'account' } }]);
  assert.deepEqual(TREE_DOORS, ['pill', 'swipe', 'toast', 'step', 'dock', 'panel', 'bar', 'guide']);
});

test('on a tree that lives only on this device its holder goes in by the same doors, and the event says the device', (t) => {
  const { entries } = browser(t, '/#/app/t_draft');
  const events = [];
  const draft = new SkillTree({ id: 't_draft', title: 'A draft', nodes: [
    { id: 'sail', label: 'Learn to sail', prerequisites: [], opens: 't_sail', opening: new Opening({ treeId: 't_sail', read: true, valid: true, title: 'Learn to sail', done: 3, total: 8 }) },
  ] });
  const registry = deviceIndex();
  const hook = renderHook(t, () => useTreeVisit({ room: { standingTreeRef: { current: draft }, viewRef: { current: 'tree' } }, arrival: readTreeVisit(), holder: { place: 'device' }, band: 'desktop', registry, track: (name, props) => events.push({ name, props }) }));

  assert.equal(hook.tree.open('sail', 'step'), true);

  assert.deepEqual(entries.map((entry) => ({ href: entry.href, kept: kept(entry) })), [
    { href: '/#/app/t_draft', kept: { roadmapWentThrough: { stepId: 'sail', view: 'tree' } } },
    { href: '/#/app/t_sail', kept: { roadmapCameFrom: { treeId: 't_draft', view: 'tree' } } },
  ]);
  assert.deepEqual(events, [{ name: 'roadmap_tree_open', props: { door: 'step', view: 'graph', band: 'desktop', place: 'device' } }]);
  const { updatedAt, ...row } = registry.onDevice('t_draft');
  assert.deepEqual(row, { id: 't_draft', title: 'A draft', claimed: false });
});

test('the guide’s door goes up into a tree above, which no step here opens: its entry names this tree, and the one left names no step', (t) => {
  const { window, entries } = browser(t, '/#/app/t_sail');
  const events = [];
  const sail = new SkillTree({ id: 't_sail', title: 'Learn to sail', nodes: [{ id: 'rig', label: 'Rig the boat', prerequisites: [] }] });
  const registry = deviceIndex();
  const hook = renderHook(t, () => useTreeVisit({ room: { standingTreeRef: { current: sail }, viewRef: { current: 'tree' } }, arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: (name, props) => events.push({ name, props }) }));

  assert.equal(hook.tree.open('t_sail', 'guide'), false);
  assert.equal(hook.tree.open(undefined, 'guide'), false);
  assert.equal(hook.tree.open('t_year', 'pill'), false);
  assert.equal(hook.tree.open('t_year', 'guide'), true);

  assert.deepEqual(entries.map((entry) => ({ href: entry.href, kept: kept(entry) })), [
    { href: '/#/app/t_sail', kept: { roadmapWentThrough: { stepId: null, view: 'tree' } } },
    { href: '/#/app/t_year', kept: { roadmapCameFrom: { treeId: 't_sail', view: 'tree' } } },
  ]);
  assert.deepEqual(events, [{ name: 'roadmap_tree_open', props: { door: 'guide', view: 'graph', band: 'desktop', place: 'account' } }]);
  const above = renderHook(t, () => useTreeVisit({ room: room('tree'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: () => {} }));
  assert.deepEqual(visitOf(above.tree), { from: { id: 't_sail', title: 'Learn to sail' }, through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: 'tree', door: 'back' });
  const returned = renderHook(t, () => useTreeVisit({ room: { standingTreeRef: { current: sail }, viewRef: { current: 'tree' } }, arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: (name, props) => events.push({ name, props }) }));
  assert.deepEqual(visitOf(returned.tree), { from: null, through: null, view: 'tree', door: 'back' });
  assert.deepEqual(events.slice(1), [{ name: 'roadmap_tree_back', props: { band: 'desktop', place: 'account' } }]);
  assert.deepEqual(kept(entries[0]), {});
});

test('a step that opens the tree it stands in goes nowhere: no entry, no event, and no return for a later reload to report', (t) => {
  const { entries } = browser(t);
  const events = [];
  const track = (name, props) => events.push({ name, props });
  const self = new SkillTree({ id: 't_year', title: 'My year', nodes: [
    { id: 'again', label: 'Again', prerequisites: [], opens: 't_year', opening: Opening.fromWire({ treeId: 't_year', title: 'My year', state: 'open', done: 0, total: 1, loop: true }).inItsOwnTree() },
  ] });
  const hook = renderHook(t, () => useTreeVisit({ room: { standingTreeRef: { current: self }, viewRef: { current: 'board' } }, arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry: deviceIndex(), track }));

  assert.equal(hook.tree.open('again', 'step'), false);

  assert.deepEqual(entries, [{ href: '/#/app/t_year', state: null }]);
  const reloaded = renderHook(t, () => useTreeVisit({ room: room('board'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry: deviceIndex(), track }));
  assert.deepEqual(visitOf(reloaded.tree), { from: null, through: null, view: null, door: null });
  assert.deepEqual(events, []);
});

test('coming back is said once the room has its holder, with the band and where it acts, and a reload of the entry says nothing', (t) => {
  const { window } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'tree' });
  window.history.back();
  const events = [];
  const track = (name, props) => events.push({ name, props });
  const who = { holder: null };
  const arrival = readTreeVisit();

  const returned = renderHook(t, () => useTreeVisit({ room: room('tree'), arrival, holder: who.holder, band: 'desktop', registry: deviceIndex(), track }));
  assert.deepEqual(visitOf(returned.tree), { from: null, through: null, view: null, door: null });
  assert.deepEqual(events, []);

  who.holder = { place: 'account', account: 'u_olya' };
  returned.redraw();
  assert.deepEqual(visitOf(returned.tree), { from: null, through: 'sail', view: 'tree', door: 'back' });
  who.holder = null;
  returned.redraw();
  who.holder = { place: 'account', account: 'u_olya' };
  returned.redraw();
  assert.deepEqual(events, [{ name: 'roadmap_tree_back', props: { band: 'desktop', place: 'account' } }]);

  const reloaded = renderHook(t, () => useTreeVisit({ room: room('tree'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry: deviceIndex(), track }));
  assert.deepEqual(visitOf(reloaded.tree), { from: null, through: null, view: null, door: null });
  assert.deepEqual(events, [{ name: 'roadmap_tree_back', props: { band: 'desktop', place: 'account' } }]);
});

test('a return nobody holds is settled all the same: a reader who comes back, then signs in and reloads, is told of no return', (t) => {
  const { window, here } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board' });
  window.history.back();
  const events = [];

  renderHook(t, () => useTreeVisit({ room: room('tree'), arrival: readTreeVisit(), holder: null, band: 'phone', registry: deviceIndex(), track: (name, props) => events.push({ name, props }) }));

  assert.deepEqual(kept(here()), {});
  assert.deepEqual(events, []);
});

test('going in writes the roadmap’s row in the device’s index first, as the holder’s, so the way back is there on a first visit before the session has stored anything', (t) => {
  browser(t);
  const disk = new Map();
  const registry = new LocalTreeRegistry({ getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) });
  const leaving = renderHook(t, () => useTreeVisit({ room: room('board'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: () => {} }));
  assert.equal(registry.owned('t_year', 'u_olya'), null);

  assert.equal(leaving.tree.open('sail', 'pill'), true);

  const arrived = renderHook(t, () => useTreeVisit({ room: room('board'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: () => {} }));
  assert.deepEqual(arrived.tree.from, { id: 't_year', title: 'My year' });
  const elsewhere = renderHook(t, () => useTreeVisit({ room: room('board'), arrival: { from: 't_year', through: null, view: null, door: null }, holder: { place: 'account', account: 'u_maya' }, band: 'desktop', registry, track: () => {} }));
  assert.equal(elsewhere.tree.from, null);
});
