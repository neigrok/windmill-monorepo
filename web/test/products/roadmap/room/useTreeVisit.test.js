import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { enterTree, readTreeVisit, settleReturn, useTreeVisit } from '../../../../src/products/roadmap/room/useTreeVisit.js';
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

test('a direct link has no way back: its history entry says nothing of a visit', (t) => {
  browser(t, '/#/app/t_sail');

  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null });
  assert.deepEqual(readTreeVisit({ roadmapCameFrom: { title: 7 }, roadmapWentThrough: { view: 'tree' } }), { from: null, through: null, view: null, door: null });
});

test('going in names where the person was on the opened tree’s entry, and coming back finds the step they went through on the one they left', (t) => {
  const { window, entries, here } = browser(t);
  let navigated = 0;
  window.addEventListener('popstate', () => { navigated += 1; });

  enterTree('t_sail', { from: { id: 't_year', title: 'My year' }, stepId: 'sail', view: 'tree' });

  assert.equal(navigated, 1);
  assert.deepEqual(entries.map(({ href }) => href), ['/#/app/t_year', '/#/app/t_sail']);
  assert.deepEqual(readTreeVisit(), { from: 'My year', through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.equal(here().href, '/#/app/t_year');
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'tree', door: 'back' });

  assert.deepEqual([settleReturn(), settleReturn()], [true, false]);
  assert.deepEqual(readTreeVisit(), { from: null, through: null, view: null, door: null });
});

test('a chain pops one tree per press: the middle tree keeps where it was reached from when the person comes back to it', (t) => {
  const { window } = browser(t);
  enterTree('t_sail', { from: { id: 't_year', title: 'My year' }, stepId: 'sail', view: 'board' });
  enterTree('t_knots', { from: { id: 't_sail', title: 'Learn to sail' }, stepId: 'bowline', view: 'tree' });
  assert.deepEqual(readTreeVisit(), { from: 'Learn to sail', through: null, view: 'tree', door: 'tree' });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: 'My year', through: 'bowline', view: 'tree', door: 'back' });
  settleReturn();
  assert.deepEqual(readTreeVisit(), { from: 'My year', through: null, view: 'board', door: 'tree' });

  window.history.back();
  assert.deepEqual(readTreeVisit(), { from: null, through: 'sail', view: 'board', door: 'back' });
});

test('a step that opens the tree it stands in goes nowhere new and names no way back', (t) => {
  const { entries } = browser(t);
  enterTree('t_year', { from: { id: 't_year', title: 'My year' }, stepId: 'self', view: 'board' });

  assert.deepEqual(entries.map(({ href }) => href), ['/#/app/t_year']);
  assert.equal(readTreeVisit().from, null);
});

test('opening a tree from a step says which door and where, and nothing of the tree, the step or their names', (t) => {
  const { entries } = browser(t);
  const events = [];
  const hook = renderHook(t, () => useTreeVisit({ room: room('board'), band: 'phone', track: (name, props) => events.push({ name, props }) }));

  assert.equal(hook.tree.open('bike', 'pill'), false);
  assert.equal(hook.tree.open('plan', 'pill'), false);
  assert.equal(hook.tree.open('sail', 'pill'), true);

  assert.deepEqual(entries.map(({ href }) => href), ['/#/app/t_year', '/#/app/t_sail']);
  assert.deepEqual(events, [{ name: 'roadmap_tree_open', props: { door: 'pill', view: 'board', band: 'phone' } }]);
});

test('coming back is said once, with the band alone: the step gone through leaves the entry, so a reload says nothing', (t) => {
  const { window } = browser(t);
  enterTree('t_sail', { from: { id: 't_year', title: 'My year' }, stepId: 'sail', view: 'tree' });
  window.history.back();
  const events = [];
  const track = (name, props) => events.push({ name, props });

  const returned = renderHook(t, () => useTreeVisit({ room: room('tree'), band: 'desktop', track }));
  const { open, back, ...visit } = returned.tree;
  const reloaded = renderHook(t, () => useTreeVisit({ room: room('tree'), band: 'desktop', track }));

  assert.deepEqual(visit, { from: null, through: 'sail', view: 'tree', door: 'back' });
  assert.equal(reloaded.tree.door, null);
  assert.deepEqual(events, [{ name: 'roadmap_tree_back', props: { band: 'desktop' } }]);
});
