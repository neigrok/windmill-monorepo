import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { TREE_DOORS, enterTree, readTreeVisit, settleTreeVisit, useTreeVisit } from '../../../../src/products/roadmap/room/useTreeVisit.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { Opening, TreePlace } from '../../../../src/products/roadmap/model/Opening.js';
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

  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
  assert.deepEqual(readTreeVisit({ roadmapCameFrom: { treeId: 7 }, roadmapWentThrough: { view: 'tree' } }), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
  assert.deepEqual(readTreeVisit({ roadmapCameFrom: { title: 'My year', view: 'tree' } }), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
});

test('only an entry that names a step, or null for a way up, as what was gone through is a return', (t) => {
  browser(t, '/#/app/t_sail');
  const back = (roadmapWentThrough, more = {}) => readTreeVisit({ roadmapWentThrough, ...more });

  assert.deepEqual(back({ stepId: 'rig', view: 'board' }), { from: null, through: 'rig', view: 'board', door: 'back', downFromParent: false, upFromSubtree: false });
  assert.deepEqual(back({ stepId: null, view: 'tree' }), { from: null, through: null, view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false });
  assert.deepEqual(back({ stepId: null }), { from: null, through: null, view: null, door: 'back', downFromParent: false, upFromSubtree: false });
  assert.deepEqual(back({ stepId: null, view: 'tree' }, { roadmapCameFrom: { treeId: 't_year', view: 'board' } }), { from: 't_year', through: null, view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false });
  for (const odd of [undefined, null, 'rig', 7, {}, { view: 'tree' }, { stepId: 7 }, { stepId: undefined, view: 'tree' }, { stepId: {} }, []]) {
    assert.deepEqual(back(odd), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false }, JSON.stringify(odd));
  }
  assert.deepEqual(readTreeVisit(null), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
});

test('going in leaves ids and a view on the two entries and no title, and coming back finds the step gone through', (t) => {
  const { window, entries, here } = browser(t);
  let navigated = 0;
  window.addEventListener('popstate', () => { navigated += 1; });

  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'tree' });

  assert.equal(navigated, 1);
  assert.deepEqual(entries.map((entry) => ({ href: entry.href, kept: kept(entry) })), [
    { href: '/#/app/t_year', kept: { roadmapWentThrough: { stepId: 'sail', view: 'tree', subtree: false } } },
    { href: '/#/app/t_sail', kept: { roadmapCameFrom: { treeId: 't_year', view: 'tree', subtree: false } } },
  ]);
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: 'tree', door: 'tree', downFromParent: false, upFromSubtree: false });

  window.history.back();
  assert.equal(here().href, '/#/app/t_year');
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false });
});

test('an arrival is settled once: the entry keeps the tree it was reached from, and a reload or a Forward carries no view, step or door', (t) => {
  const { window, entries } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board' });

  settleTreeVisit();
  assert.deepEqual(kept(entries[1]), { roadmapCameFrom: { treeId: 't_year', subtree: false } });
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });

  window.history.back();
  settleTreeVisit();
  settleTreeVisit();
  assert.deepEqual(kept(entries[0]), {});
  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
});

test('a chain pops one tree per press: the middle tree keeps where it was reached from when the person comes back to it', (t) => {
  const { window } = browser(t);
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board' });
  settleTreeVisit();
  enterTree('t_knots', { from: 't_sail', stepId: 'bowline', view: 'tree' });
  assert.deepEqual(readTreeVisit(), { from: 't_sail', through: null, view: 'tree', door: 'tree', downFromParent: false, upFromSubtree: false });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: 'bowline', view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false });
  settleTreeVisit();
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'board', door: 'back', downFromParent: false, upFromSubtree: false });
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
    { href: '/#/app/t_draft', kept: { roadmapWentThrough: { stepId: 'sail', view: 'tree', subtree: false } } },
    { href: '/#/app/t_sail', kept: { roadmapCameFrom: { treeId: 't_draft', view: 'tree', subtree: false } } },
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
    { href: '/#/app/t_sail', kept: { roadmapWentThrough: { stepId: null, view: 'tree', subtree: false } } },
    { href: '/#/app/t_year', kept: { roadmapCameFrom: { treeId: 't_sail', view: 'tree', subtree: false } } },
  ]);
  assert.deepEqual(events, [{ name: 'roadmap_tree_open', props: { door: 'guide', view: 'graph', band: 'desktop', place: 'account' } }]);
  const above = renderHook(t, () => useTreeVisit({ room: room('tree'), arrival: readTreeVisit(), holder: { place: 'account', account: 'u_olya' }, band: 'desktop', registry, track: () => {} }));
  assert.deepEqual(visitOf(above.tree), { from: { id: 't_sail', title: 'Learn to sail' }, through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false });
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

// My year's step Learn to sail owns its subtree t_sail; Rig the boat, inside it, owns t_rig.
const ownedYear = () => new SkillTree({ id: 't_year', title: 'My year', nodes: [
  { id: 'sail', label: 'Learn to sail', prerequisites: [], opening: Opening.owned({ id: 't_sail', done: 0, total: 1, state: 'open' }) },
  { id: 'coast', label: 'Sail the coast', prerequisites: ['sail'] },
] });
const sailPlace = TreePlace.fromWire({ root: 't_year', parent: { tree: 't_year', step: 'sail' }, path: [{ tree: 't_year', step: 'sail', title: 'My year' }], depth: 1 });

test('anyone who reads a shared roadmap goes into the subtree a step owns on the share’s own address, and the event says who, not what', (t) => {
  const { entries } = browser(t, '/#/t/t_year');
  const events = [];
  const hook = renderHook(t, () => useTreeVisit({
    room: { standingTreeRef: { current: ownedYear() }, viewRef: { current: 'tree' } }, arrival: readTreeVisit(), holder: null, visitor: true,
    route: '#/t/', role: 'reader', band: 'phone', registry: deviceIndex(), track: (name, props) => events.push({ name, props }),
  }));

  assert.equal(hook.tree.open('coast', 'step'), false);
  assert.equal(hook.tree.open('sail', 'step'), true);

  assert.deepEqual(entries.map((entry) => ({ href: entry.href, kept: kept(entry) })), [
    { href: '/#/t/t_year', kept: { roadmapWentThrough: { stepId: 'sail', view: 'tree', subtree: true } } },
    { href: '/#/t/t_sail', kept: { roadmapCameFrom: { treeId: 't_year', view: 'tree', subtree: true } } },
  ]);
  assert.deepEqual(readTreeVisit(), { from: 't_year', through: null, view: 'tree', door: 'tree', downFromParent: true, upFromSubtree: false });
  assert.deepEqual(events, [{ name: 'roadmap_subtree_open', props: { door: 'step', view: 'graph', band: 'phone', role: 'reader' } }]);
});

test('a subtree’s way back names its parent from where it sits: back through the history where the person came down its step, else up to that step', (t) => {
  const { entries, here } = browser(t, '/#/app/t_year');
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board', subtree: true });
  const events = [];
  const track = (name, props) => events.push({ name, props });
  const sail = new SkillTree({ id: 't_sail', title: 'Learn to sail', nodes: [] });
  const at = (arrival, holder = { place: 'account', account: 'u_olya' }, visitor = false) => renderHook(t, () => useTreeVisit({
    room: { standingTreeRef: { current: sail }, viewRef: { current: 'tree' } }, arrival, holder, visitor, place: sailPlace, role: 'owner',
    band: 'desktop', registry: deviceIndex(), track,
  })).tree;

  const cameDown = at(readTreeVisit());
  assert.deepEqual(visitOf(cameDown), { from: { id: 't_year', title: 'My year' }, through: null, view: 'board', door: 'tree' });
  cameDown.back();
  assert.equal(here().href, '/#/app/t_year');

  const linked = at({ from: null, through: null, view: null, door: null, downFromParent: false, upFromSubtree: false });
  assert.deepEqual(visitOf(linked), { from: { id: 't_year', title: 'My year' }, through: null, view: null, door: null });
  linked.back();
  assert.equal(here().href, '/#/app/t_year?step=sail');
  assert.deepEqual(kept(here()), { roadmapWentThrough: { stepId: 'sail', view: 'tree', subtree: true } });
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'tree', door: 'back', downFromParent: false, upFromSubtree: true });

  assert.deepEqual(visitOf(at(readTreeVisit(), null)), { from: null, through: null, view: null, door: null });
  assert.equal(entries.length, 2);
  assert.deepEqual(events, []);
});

test('coming back up from a subtree is said once the room knows whose it is, to a reader as to its owner, and a pointer’s return still needs the holder', (t) => {
  const { window } = browser(t, '/#/t/t_year');
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'tree', subtree: true, route: '#/t/' });
  window.history.back();
  const events = [];
  const track = (name, props) => events.push({ name, props });
  const arrival = readTreeVisit();

  const who = { role: null };
  const returned = renderHook(t, () => useTreeVisit({
    room: { standingTreeRef: { current: ownedYear() }, viewRef: { current: 'tree' } }, arrival, holder: null, visitor: true, route: '#/t/',
    role: who.role, band: 'tablet', registry: deviceIndex(), track,
  }));
  assert.deepEqual({ visit: visitOf(returned.tree), events }, { visit: { from: null, through: 'sail', view: 'tree', door: 'back' }, events: [] });
  who.role = 'reader';
  returned.redraw();
  returned.redraw();
  assert.deepEqual(events, [{ name: 'roadmap_subtree_back', props: { band: 'tablet', role: 'reader' } }]);

  const pointer = { from: null, through: 'sail', view: 'tree', door: 'back', downFromParent: false, upFromSubtree: false };
  const visited = renderHook(t, () => useTreeVisit({
    room: room('tree'), arrival: pointer, holder: null, visitor: true, role: 'reader', band: 'tablet', registry: deviceIndex(), track,
  }));
  assert.deepEqual(visitOf(visited.tree), { from: null, through: null, view: null, door: null });
  assert.equal(events.length, 1);
});

test('a root reached by a pointer keeps its way back after a trip down into one of its subtrees and up again', (t) => {
  const { window } = browser(t, '/#/app/t_road');
  const registry = new LocalTreeRegistry((() => {
    const disk = new Map([['windmill:device-trees', JSON.stringify({
      t_road: { title: 'Road', updatedAt: 1, claimed: true, owner: 'u_olya' },
      t_year: { title: 'My year', updatedAt: 2, claimed: true, owner: 'u_olya' },
    })]]);
    return { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) };
  })());
  const events = [];
  const yearRoom = () => renderHook(t, () => useTreeVisit({
    room: { standingTreeRef: { current: ownedYear() }, viewRef: { current: 'board' } }, arrival: readTreeVisit(),
    holder: { place: 'account', account: 'u_olya' }, place: TreePlace.fromWire({ root: 't_year', parent: null, path: [], depth: 0 }),
    role: 'owner', band: 'desktop', registry, track: (name, props) => events.push({ name, props }),
  })).tree;

  enterTree('t_year', { from: 't_road', stepId: 'go', view: 'board' });
  settleTreeVisit();
  const before = visitOf(yearRoom());
  yearRoom().open('sail', 'step');
  window.history.back();
  const after = visitOf(yearRoom());

  assert.deepEqual({ before, after }, {
    before: { from: { id: 't_road', title: 'Road' }, through: null, view: null, door: null },
    after: { from: { id: 't_road', title: 'Road' }, through: 'sail', view: 'board', door: 'back' },
  });
  assert.deepEqual(events.map(({ name }) => name), ['roadmap_subtree_open', 'roadmap_subtree_back']);
});

test('a subtree come back to from a tree its pointer opens goes up through the history it came down, not a new entry', (t) => {
  const { window, entries, here } = browser(t, '/#/app/t_year');
  enterTree('t_sail', { from: 't_year', stepId: 'sail', view: 'board', subtree: true });
  settleTreeVisit();
  enterTree('t_weather', { from: 't_sail', stepId: 'wind', view: 'board' });
  window.history.back();
  const arrival = readTreeVisit();
  const sail = new SkillTree({ id: 't_sail', title: 'Learn to sail', nodes: [] });
  const visit = renderHook(t, () => useTreeVisit({
    room: { standingTreeRef: { current: sail }, viewRef: { current: 'board' } }, arrival,
    holder: { place: 'account', account: 'u_olya' }, place: sailPlace, role: 'owner', band: 'desktop', registry: deviceIndex(), track: () => {},
  })).tree;

  assert.deepEqual(arrival, { from: 't_year', through: 'wind', view: 'board', door: 'back', downFromParent: true, upFromSubtree: false });
  visit.back();
  assert.deepEqual({ at: here().href, entries: entries.length }, { at: '/#/app/t_year', entries: 3 });
});

