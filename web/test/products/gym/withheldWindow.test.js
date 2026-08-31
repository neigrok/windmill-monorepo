import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { WINDOW_CLOSED } from '../../../src/products/gym/withheld.js';
import { dateLocalOf } from '../../../src/products/gym/bodyweight/bodyweight.js';
import {
  browserWith, elementsOf, findByClass, loadScreen, renderHook, roomAndScreen, roomLog, settle,
  textOf,
} from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// The room, alone. Its own reads go through the injected api; anything a screen does goes through
// `fetch`, so the two are never confused in the wire log.
// One object for the life of the room: the boot read runs again whenever the api it was handed is a
// new one, so a literal built inside the render would re-read for ever.
const quietApi = (api = {}) => ({
  exercises: async () => [],
  sessions: async () => [],
  preferences: async () => ({}),
  ...api,
});

async function room(t, api = {}) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const held = quietApi(api);
  const view = renderHook(t, () => useTrainingLog({ api: held }));
  await settle();
  return view;
}

// The room with one screen inside it, rendered as one tree: the window belongs to the room, and a
// screen tested without one is a screen that cannot exist.
async function roomWith(t, module, render, api = {}) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const screens = await loadScreen(module);
  const held = quietApi(api);
  const view = renderHook(t, () => {
    const log = useTrainingLog({ api: held });
    return { log, screen: render(screens, log) };
  });
  await settle();
  return { view, log: () => view.tree.log, screen: () => view.tree.screen };
}

test('the window holds more than one delete: each has its own clock, and a second settles nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const sent = [];
  const view = await room(t);

  view.log.withhold({ kind: 'set', id: 'set_1', line: 'one is out of the log.', send: async () => sent.push('set_1') });
  view.log.withhold({ kind: 'set', id: 'set_2', line: 'two is out of the log.', send: async () => sent.push('set_2') });

  assert.deepEqual(sent, [], 'withheld means not sent');
  assert.equal(view.log.held.length, 2);
  assert.equal(view.log.transient.text, '2 deleted.');
  assert.equal(view.log.transient.action.label, 'Undo');

  // The second delete did not shorten the first's clock: both close at their own nine seconds.
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(sent, ['set_1', 'set_2']);
  assert.equal(view.log.held.length, 0);
  assert.equal(view.log.transient, null, 'the transient retires when the last clock closes');
});

test('Undo takes the newest first, and the transient re-reads for the rest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const sent = [];
  const view = await room(t);

  view.log.withhold({ kind: 'set', id: 'set_1', line: 'one is out of the log.', send: async () => sent.push('set_1') });
  view.log.withhold({ kind: 'routine', id: 'rt_1', line: 'Push A deleted.', send: async () => sent.push('rt_1') });
  assert.equal(view.log.transient.text, '2 deleted.');

  view.log.transient.action.run();
  assert.deepEqual(view.log.held.map((each) => each.id), ['set_1']);
  assert.equal(view.log.transient.text, 'one is out of the log.', 'the transient re-reads for what is left');

  view.log.transient.action.run();
  assert.equal(view.log.held.length, 0);
  assert.equal(view.log.transient, null);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(sent, [], 'two deletes taken back, and neither ever happened');
});

test('two deletes in one second both come back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const sent = [];
  const back = [];
  const view = await room(t);

  view.log.withhold({ kind: 'entry', id: 'drop_1', line: 'Back Squat is out of the routine.', undo: () => back.push('drop_1') });
  t.mock.timers.tick(500);
  view.log.withhold({ kind: 'entry', id: 'drop_2', line: 'Bench Press is out of the routine.', undo: () => back.push('drop_2') });

  view.log.transient.action.run();
  view.log.transient.action.run();
  assert.deepEqual(back, ['drop_2', 'drop_1']);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(sent, []);
  assert.equal(view.log.held.length, 0);
});

test('Undo pressed after the window has closed says so rather than answering nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  let settled = false;
  const view = await room(t);

  view.log.withhold({ kind: 'set', id: 'set_1', line: 'one is out of the log.', send: async () => { settled = true; } });
  const undo = view.log.transient.action.run;

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(settled, true);
  assert.equal(view.log.transient, null, 'the way back is off the screen before it can be pressed');

  // Held from the render before the clock fired — the seam a real thumb can land in.
  undo();
  assert.equal(view.log.transient.text, WINDOW_CLOSED);
  assert.equal(view.log.transient.action, null);
});

test('while a send is in the air the way back is gone, and the row it hid is still hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  let answer = null;
  const view = await room(t);

  view.log.withhold({
    kind: 'set',
    id: 'set_1',
    line: 'one is out of the log.',
    send: () => new Promise((resolve) => { answer = resolve; }),
  });
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.equal(view.log.transient, null, 'the clock closed the way back before the store answered');
  assert.deepEqual([...view.log.hidden('set')], ['set_1'], 'and the row stays hidden meanwhile');

  answer();
  await settle();
  assert.equal(view.log.held.length, 0);
});

test('a refusal said while another window runs is read, because the transient is whichever spoke last', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const view = await room(t);

  view.log.withhold({ kind: 'set', id: 'set_1', line: 'one is out of the log.', send: async () => {} });
  view.log.say('That set is still in the log — the log didn’t answer. Try again when you have signal.');
  assert.equal(view.log.transient.text, 'That set is still in the log — the log didn’t answer. Try again when you have signal.');
  assert.equal(view.log.transient.action, null);
  assert.equal(view.log.held.length, 1, 'the window is still open behind it');
});

test('the editor’s window closes with the draft it could put a line back into, and sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const back = [];
  const view = await room(t);

  view.log.withhold({ kind: 'entry', id: 'drop_1', line: 'Back Squat is out of the routine.', undo: () => back.push('drop_1') });
  view.log.withhold({ kind: 'set', id: 'set_1', line: 'one is out of the log.', send: async () => {} });

  view.log.dropWithheld('entry');
  assert.deepEqual(view.log.held.map((each) => each.kind), ['set'], 'only the draft’s own window closed');
  assert.deepEqual(back, [], 'a window closing is not an undo');
  t.mock.timers.tick(UNDO_MS);
  await settle();
});

// ── The three verbs, each proved at the screen that draws it ────────────────

// `deleted` is the store's memory: a re-read after the window closes answers the truth, which is the
// only way a screen that trusts a stale read can be caught.
function routinesOnTheWire({ deleteStatus = 204 } = {}) {
  const wire = [];
  let deleted = false;
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/routines') {
      const routines = deleted ? [] : [{ id: 'rt_push', name: 'Push A', position: 0, revision: 1, entries: [] }];
      return { ok: true, status: 200, json: async () => ({ routines }) };
    }
    if (path === '/routines/rt_push' && options.method === 'DELETE') {
      if (deleteStatus < 300) deleted = true;
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return wire;
}

const overflowOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'Overflow');

test('a routine delete is in the row overflow, is not on the wire until the window closes, and names the routine', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire();
  const home = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();

  assert.deepEqual(overflowOf(home.screen()).props.items.map((item) => item.label), ['Duplicate', 'Delete']);
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);

  overflowOf(home.screen()).props.items[1].run();
  assert.deepEqual(wire, ['GET /routines'], 'nothing is on the wire while the window runs');
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'the row is off the home');
  // Deleting a routine cascades its proposals, so the transient says WHICH routine it was.
  assert.equal(home.log().transient.text, 'Push A deleted.');
  assert.equal(home.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS - 1);
  assert.deepEqual(wire, ['GET /routines']);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(wire, ['GET /routines', 'DELETE /routines/rt_push']);
  assert.equal(home.log().transient, null);
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'and it stays gone');
});

test('a routine delete taken back is never sent, and the row is back on the home', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire();
  const home = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();

  overflowOf(home.screen()).props.items[1].run();
  home.log().transient.action.run();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /routines']);
});

test('leaving the room abandons a held routine delete: the row is back, and nothing ever went', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire();
  const home = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();

  overflowOf(home.screen()).props.items[1].run();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), []);

  // Out of the gym and into another product, four seconds in. Committing the delete here would put
  // it past every way back, reached by two ordinary acts — so the room abandons what it holds.
  t.mock.timers.tick(4000);
  home.view.unmount();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /routines'], 'nothing went on the wire, and no clock outlived the room');

  // Back in: the routine the store still has, and no sentence about a delete that never happened.
  const again = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();
  assert.deepEqual(findByClass(again.screen(), 'gym-routine-name').map(textOf), ['Push A']);
  assert.equal(again.log().transient, null);
  assert.deepEqual(again.log().held, []);
});

test('a hidden tab abandons a held routine delete: the row is back, and nothing ever went', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = browserWith();
  const wire = routinesOnTheWire();
  const home = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();

  overflowOf(home.screen()).props.items[1].run();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), []);

  // Another tab, four seconds in. A hidden tab is a room that has left the foreground — the exact
  // counterpart of the phones' ON_STOP — so letting the clock run here would spend the row while
  // nobody could see the Undo, reached by two ordinary acts.
  t.mock.timers.tick(4000);
  browser.hide();
  await settle();
  assert.deepEqual(home.log().held, [], 'the window let go of everything it was holding');
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A'], 'the row is back');
  assert.equal(home.log().transient, null, 'and nothing is said, because nothing happened');

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /routines'], 'no clock outlived the hide, and nothing reached the store');

  // Back to the tab: still the routine the store never lost, and still no sentence about it.
  browser.show();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);
  assert.equal(home.log().transient, null);
  assert.deepEqual(wire, ['GET /routines']);
});

test('a hidden tab puts a dropped editor line back in the draft, the one verb that owns its own way back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = browserWith();
  const back = [];
  const view = await room(t);

  view.log.withhold({ kind: 'entry', id: 'drop_1', line: 'Back Squat is out of the routine.', undo: () => back.push('drop_1') });
  browser.hide();
  await settle();

  assert.deepEqual(back, ['drop_1'], 'a draft line is hidden by nothing but its own removal, so it is put back');
  assert.deepEqual(view.log.held, []);
  assert.equal(view.log.transient, null);
});

test('a hidden tab abandons what is still open and leaves what is already settling, whose send is in the air', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = browserWith();
  let answer = null;
  const sent = [];
  const view = await room(t);

  view.log.withhold({
    kind: 'routine',
    id: 'rt_push',
    line: 'Push A deleted.',
    send: () => new Promise((resolve) => { answer = resolve; }).then(() => sent.push('rt_push')),
  });
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(view.log.held.map((each) => each.settling), [true], 'the first clock fired and its send went');

  // A second delete, taken while the first is still in the air: one window, two deletes, only one of
  // them still recallable.
  view.log.withhold({ kind: 'routine', id: 'rt_pull', line: 'Pull A deleted.', send: async () => sent.push('rt_pull') });
  browser.hide();
  await settle();

  assert.deepEqual(view.log.held.map((each) => each.id), ['rt_push'], 'a send cannot be taken back by leaving');
  assert.equal(view.log.hidden('routine').has('rt_push'), true, 'so the row it hid may not flash back');
  assert.equal(view.log.hidden('routine').has('rt_pull'), false, 'and the one still open is back on screen');
  assert.equal(view.log.transient, null, 'nothing is offered back and nothing is said');

  answer();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(sent, ['rt_push'], 'the abandoned delete never reached the store');
  assert.deepEqual(view.log.held, []);
  assert.equal(view.log.hidden('routine').has('rt_push'), true, 'and the store has confirmed the other gone');
});

// The home, torn down and built again while the room holds the window — the lifter walking off the
// routines tab and back inside the nine seconds.
const homeAgainAndAgain = (t, api = {}) => roomAndScreen(t, {
  module: 'products/gym/Routines.jsx',
  render: ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }),
  api: quietApi(api),
});
const namesOn = (home) => findByClass(home.screen(), 'gym-routine-name').map(textOf);

test('a delete settles into a screen that never armed it, and the row does not come back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire();
  const home = await homeAgainAndAgain(t);

  overflowOf(home.screen()).props.items[1].run();
  home.redraw();
  assert.deepEqual(namesOn(home), [], 'off the home for the length of the window');

  // Off the tab and back, four seconds in. The new screen reads a store that STILL HAS the routine,
  // because withheld means not sent — so it is drawn around a read that the delete is about to
  // falsify, and it knows nothing about the delete the screen before it armed.
  t.mock.timers.tick(4000);
  await home.remount();
  assert.deepEqual(wire, ['GET /routines', 'GET /routines'], 'the second screen read the store again');
  assert.deepEqual(namesOn(home), [], 'still held, and the room is what is holding it');

  // The clock closes into a screen that armed nothing.
  t.mock.timers.tick(UNDO_MS);
  await settle();
  home.redraw();
  assert.deepEqual(wire, ['GET /routines', 'GET /routines', 'DELETE /routines/rt_push']);
  assert.deepEqual(namesOn(home), [], 'the delete landed, and the row it hid stayed gone');
  assert.equal(home.log().transient, null, 'the window retired with its last clock');

  // And on every screen after that: the fact is the room's for as long as the room lives.
  await home.remount();
  assert.deepEqual(namesOn(home), []);
});

test('a refusal reaches the room even though the screen that armed it is gone, and the row is back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire({ deleteStatus: 500 });
  const home = await homeAgainAndAgain(t);

  overflowOf(home.screen()).props.items[1].run();
  t.mock.timers.tick(4000);
  await home.remount();
  assert.deepEqual(namesOn(home), []);

  t.mock.timers.tick(UNDO_MS);
  await settle();
  home.redraw();
  assert.deepEqual(wire, ['GET /routines', 'GET /routines', 'DELETE /routines/rt_push']);
  // Nothing settled, so nothing is hidden — and the sentence is still the one the screen wrote.
  assert.deepEqual(namesOn(home), ['Push A'], 'the store kept it, so the home draws it');
  assert.equal(
    home.log().transient.text,
    'Push A is still in your program — the log didn’t answer. Try again when you have signal.',
  );
});

test('a routine delete the store refuses says the routine is still in the program, and puts the row back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = routinesOnTheWire({ deleteStatus: 500 });
  const home = await roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log, onSignIn: () => {} }));
  await settle();

  overflowOf(home.screen()).props.items[1].run();
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.deepEqual(wire, ['GET /routines', 'DELETE /routines/rt_push']);
  assert.equal(
    home.log().transient.text,
    'Push A is still in your program — the log didn’t answer. Try again when you have signal.',
  );
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);
});

test('the editor’s × drops the line from the draft and hands the way back to the room’s transient', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/routines/rt_push') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'rt_push',
          name: 'Push A',
          position: 0,
          revision: 1,
          entries: [{ exerciseId: 'bench-press' }, { exerciseId: 'dip' }],
        }),
      };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  const catalog = [{ id: 'bench-press', name: 'Bench Press' }, { id: 'dip', name: 'Dip' }];
  const editor = await roomWith(
    t,
    'products/gym/Routines.jsx',
    ({ RoutineEditor }, log) => RoutineEditor({ id: 'rt_push', log: { ...log, catalog } }),
  );
  await settle();

  const entries = () => elementsOf(editor.screen())
    .find((each) => typeof each.type === 'function' && each.type.name === 'EntryList').props.entries;
  assert.deepEqual(entries().map((entry) => entry.exerciseId), ['bench-press', 'dip']);

  const list = () => elementsOf(editor.screen())
    .find((each) => typeof each.type === 'function' && each.type.name === 'EntryList');
  list().props.onRemove(0);
  assert.deepEqual(entries().map((entry) => entry.exerciseId), ['dip']);
  assert.equal(editor.log().transient.text, 'Bench Press is out of the routine.');
  assert.equal(editor.log().transient.action.label, 'Undo');

  // Back where it was, not appended to the end.
  editor.log().transient.action.run();
  assert.deepEqual(entries().map((entry) => entry.exerciseId), ['bench-press', 'dip']);
  assert.equal(editor.log().transient, null);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /routines/rt_push'], 'a draft edit is never on the wire');
});

test('the editor’s window closes when the editor does, because the draft it would restore into is gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  global.fetch = async (url) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    if (path === '/routines/rt_push') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'rt_push', name: 'Push A', position: 0, revision: 1, entries: [{ exerciseId: 'dip' }] }),
      };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  const editor = await roomWith(
    t,
    'products/gym/Routines.jsx',
    ({ RoutineEditor }, log) => RoutineEditor({ id: 'rt_push', log: { ...log, catalog: [{ id: 'dip', name: 'Dip' }] } }),
  );
  await settle();

  elementsOf(editor.screen())
    .find((each) => typeof each.type === 'function' && each.type.name === 'EntryList').props.onRemove(0);
  assert.equal(editor.log().held.length, 1);

  editor.view.unmount();
  assert.equal(editor.log().held.length, 0);
});

function finishOnTheWire({ deleteStatus = 204 } = {}) {
  const wire = [];
  const session = { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_000_600_000 };
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [] }) };
    if (path === '/sessions?limit=2') return { ok: true, status: 200, json: async () => ({ sessions: [session] }) };
    if (path === '/sessions/ses_1') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets: [] }) };
    if (path === '/sessions/ses_1/review') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ slight: true, stats: { durationMs: 600_000, workingSets: 1, topE1rm: null }, record: null, against: null }),
      };
    }
    if (path === '/sessions/ses_1' && options.method === 'DELETE') {
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return wire;
}

test('Discard asks nothing, holds the session for the window, and only then reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = finishOnTheWire();
  const finish = await roomWith(t, 'products/gym/Finish.jsx', ({ FinishScreen }, log) => FinishScreen({ id: 'ses_1', log }));
  await settle();

  // A child component is not rendered by the harness, so the short-session block is drawn here.
  const short = () => {
    const element = elementsOf(finish.screen()).find((each) => typeof each.type === 'function' && each.type.name === 'ShortSession');
    return element.type(element.props);
  };
  const discard = findByClass(short(), 'gym-short-discard')[0];
  assert.equal(textOf(discard), 'Discard session');
  window.location.hash = '#/gym/finish/ses_1';
  discard.props.onClick();

  // No confirmation stands between the press and the window; Law 2 refuses one on an undoable act.
  assert.equal(findByClass(short(), 'gym-confirm').length, 0);
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 0);
  assert.equal(finish.log().transient.text, 'Session deleted.');
  assert.equal(finish.log().transient.action.label, 'Undo');
  assert.equal(window.location.hash, '#/gym', 'the lifter is back in the room, and the transient came with them');

  t.mock.timers.tick(UNDO_MS - 1);
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(wire.filter((line) => line.startsWith('DELETE')), ['DELETE /sessions/ses_1']);
  assert.equal(finish.log().transient, null);
});

test('a discard taken back inside the window never reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = finishOnTheWire();
  const finish = await roomWith(t, 'products/gym/Finish.jsx', ({ FinishScreen }, log) => FinishScreen({ id: 'ses_1', log }));
  await settle();

  const short = elementsOf(finish.screen()).find((each) => typeof each.type === 'function' && each.type.name === 'ShortSession');
  findByClass(short.type(short.props), 'gym-short-discard')[0].props.onClick();
  finish.log().transient.action.run();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 0);
});

test('a session the window is holding is off the log, and on it again the moment the delete is taken back', async (t) => {
  browserWith();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ weighIns: [], latest: null }) });
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const summaries = [
    { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000, routine: 'Push A' },
    { id: 'ses_2', startedAt: 1_754_900_000_000, finishedAt: 1_754_903_600_000, routine: 'Pull A' },
  ];
  const held = [{ key: 'session:ses_1', kind: 'session', id: 'ses_1', line: 'Session deleted.', at: 1, settling: false }];
  const draw = (log) => renderHook(t, () => LogList({ log, onSignIn: () => {} })).tree;
  // A row is its own component, so the tree holds it as an element and its props are what the list
  // handed it.
  const rows = (tree) => elementsOf(tree)
    .filter((each) => typeof each.type === 'function' && each.type.name === 'SessionRow')
    .map((each) => each.props.summary.id);

  assert.deepEqual(rows(draw(roomLog({ summaries, held }))), ['ses_2']);

  // The only session there is, withheld: the log reads as the log of an account with none.
  const alone = draw(roomLog({ summaries: [summaries[0]], held }));
  assert.deepEqual(rows(alone), []);
  assert.equal(textOf(elementsOf(alone).filter((each) => each.props?.className === 'gym-quiet')[0]), 'No sessions yet.');

  assert.deepEqual(rows(draw(roomLog({ summaries, held: [] }))), ['ses_1', 'ses_2']);
});

// ── The two verbs that used to ask a question ───────────────────────────────
// A note and a weigh-in are deleted in one press now, and every state the confirmation carried is
// re-homed here: `are you sure` is the window, `this row is gone` is `log.hidden`, and the refusal
// after the window is said by the room.

function notesOnTheWire({ count = 10, deleteStatus = 204, said = null } = {}) {
  const wire = [];
  const deleted = new Set();
  const stored = () => Array.from({ length: count }, (_, at) => ({ id: `note_${at}`, position: at, title: `Note ${at}`, body: '', updatedAt: 0 }))
    .filter((note) => !deleted.has(note.id));
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/notes' && method === 'GET') return { ok: true, status: 200, json: async () => ({ notes: stored() }) };
    if (path.startsWith('/notes/') && method === 'DELETE') {
      if (deleteStatus < 300) deleted.add(path.slice('/notes/'.length));
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => (said ? { error: said } : {}) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return wire;
}

const noteList = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteList');
const noteEditor = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteEditor');

test('a note delete is one press, leaves the editor in the same act, and is not on the wire until the window closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = notesOnTheWire({ count: 3 });
  const notes = await roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));
  await settle();

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  assert.notEqual(noteEditor(notes.screen()), undefined);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  assert.equal(noteEditor(notes.screen()), undefined, 'the editor is left in the same act');
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
  assert.deepEqual(wire, ['GET /notes'], 'nothing is on the wire while the window runs');
  assert.equal(notes.log().transient.text, 'Note deleted.');
  assert.equal(notes.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  // The store renumbers the rest, so the list re-reads — and a reorder sent afterwards carries the
  // store's own list rather than an id the store no longer has.
  assert.deepEqual(wire, ['GET /notes', 'DELETE /notes/note_1', 'GET /notes']);
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
});

test('the re-read after a note delete keeps the list drawn: the screen does not blank nine seconds after the act', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  notesOnTheWire({ count: 3 });
  const notes = await roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));
  await settle();

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  // The store's answer lands; the re-read behind it is still in the air.
  let answerTheRead = null;
  global.fetch = async (url, options = {}) => {
    if ((options.method ?? 'GET') === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    return new Promise((resolve) => { answerTheRead = () => resolve({ ok: true, status: 200, json: async () => ({ notes: [{ id: 'note_0', position: 0, title: 'Note 0', body: '', updatedAt: 0 }, { id: 'note_2', position: 1, title: 'Note 2', body: '', updatedAt: 0 }] }) }); });
  };
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2'], 'the rows stand');
  assert.equal(findByClass(notes.screen(), 'gym-quiet').length, 0, 'never back to `Opening your notes…`');
  answerTheRead();
  await settle();
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
});

test('a note delete taken back is never sent, and the row is back on the list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = notesOnTheWire({ count: 3 });
  const notes = await roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));
  await settle();

  const held = noteList(notes.screen()).props.notes[0];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();
  notes.log().transient.action.run();
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 1', 'Note 2']);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /notes']);
});

test('the cap is the store’s count: a tenth note held for deletion still fills the account, so the cap line stands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  notesOnTheWire({ count: 10 });
  const notes = await roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));
  await settle();
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-full')[0]), '10 of 10 notes. Delete one to add another.');

  const held = noteList(notes.screen()).props.notes[9];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  assert.equal(noteList(notes.screen()).props.notes.length, 9, 'nine rows are drawn');
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-full')[0]), '10 of 10 notes. Delete one to add another.');
  assert.equal(findByClass(notes.screen(), 'gym-notes-add').length, 0, 'and no door onto a mint the store would refuse');

  // Once the store has answered, the account really has nine and the door comes back.
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(findByClass(notes.screen(), 'gym-notes-full').length, 0);
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-add')[0]), 'Add a note');
});

test('a note delete the store refuses is said in the room’s words, and the row is back because nothing was taken', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  // Wordless, so what is read is the room's own sentence and not the store's.
  notesOnTheWire({ count: 3, deleteStatus: 500 });
  const notes = await roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));
  await settle();

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.equal(notes.log().transient.text, 'That note wasn’t deleted — the log didn’t answer. Try again when you have signal.');
  assert.equal(notes.log().transient.action, null, 'a refusal carries no way back');
  // Only a send that RESOLVES records the id gone, so a refused delete leaves the row standing —
  // which is the state the sentence names, and the reason it names the way out as trying again.
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 1', 'Note 2']);
});

// A store that really keeps the series, so a delete that lands and a weigh-in written afterwards are
// read back off the same rows the screens are drawing from.
function weighInsOnTheWire(entries, { deleteStatus = 204 } = {}) {
  const wire = [];
  let stored = [...entries];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/bodyweight' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ entries: stored, latest: stored[stored.length - 1] ?? null }) };
    }
    if (path.startsWith('/bodyweight/') && method === 'DELETE') {
      const day = path.slice('/bodyweight/'.length);
      if (deleteStatus < 300) stored = stored.filter((each) => each.dateLocal !== day);
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    if (path.startsWith('/bodyweight/') && method === 'PUT') {
      const day = path.slice('/bodyweight/'.length);
      const entry = { dateLocal: day, ...JSON.parse(options.body) };
      stored = [...stored.filter((each) => each.dateLocal !== day), entry];
      return { ok: true, status: 200, json: async () => ({ entry }) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { wire, onTheLog: () => stored };
}

// Both screens that read the series, in one room: the chart owns one instance of `useBodyweight` and
// the log's head owns a second, and the hide is inside the hook precisely so the two never disagree.
async function weighInRoom(t, entries, options = {}) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const held = quietApi();
  const { wire, onTheLog } = weighInsOnTheWire(entries, options);
  const view = renderHook(t, () => {
    const log = useTrainingLog({ api: held });
    return { log, chart: BodyweightScreen({ log }), logScreen: LogList({ log, onSignIn: () => {} }) };
  });
  await settle();
  const named = (tree, name) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === name);
  const reading = () => named(view.tree.logScreen, 'BodyweightReading');
  const chart = () => named(view.tree.chart, 'DotChart');
  const sheet = () => named(view.tree.chart, 'WeighInSheet');
  // The chip in the log's reach band, which opens a sheet on any date — the one door that can write
  // the day a delete is holding.
  const chip = () => named(view.tree.logScreen, 'WeighInChip');
  const chipSheet = () => named(view.tree.logScreen, 'WeighInSheet');
  // Every quiet line the chart screen is drawing: its stance about the account, and its line about
  // the window it is showing.
  const quiet = () => findByClass(view.tree.chart, 'gym-quiet').map(textOf);
  return { wire, onTheLog, log: () => view.tree.log, reading, chart, sheet, chip, chipSheet, quiet };
}

test('a weigh-in delete is one press, closes the sheet over the transient, and drops the dot AND the log’s head reading together', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [
    { dateLocal: '2026-08-20', weightKg: 83.1, recordedAt: 1 },
    { dateLocal: today, weightKg: 82.4, recordedAt: 2 },
  ]);

  assert.equal(room.reading().props.latest.dateLocal, today);
  assert.equal(room.chart().props.points.length, 2);

  room.chart().props.onPick(room.chart().props.points[1]);
  const sheet = room.sheet();
  assert.equal(sheet.props.fixedDate, today);
  sheet.props.onDelete(today);
  await settle();

  assert.equal(room.sheet(), undefined, 'a sheet over the room would hide the only Undo there is');
  assert.equal(room.chart().props.points.length, 1, 'the dot is gone');
  assert.equal(room.reading().props.latest.dateLocal, '2026-08-20', 'and so is the head reading, from the same filter');
  assert.deepEqual(room.wire.filter((line) => line.startsWith('DELETE')), []);
  assert.equal(room.log().transient.text, 'Weigh-in deleted.');
  assert.equal(room.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(room.wire.filter((line) => line.startsWith('DELETE')), [`DELETE /bodyweight/${today}`]);
});

test('a weigh-in delete taken back puts the dot and the reading back, and never reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();
  assert.equal(room.chart(), undefined, 'the only weigh-in there was: the chart draws no frame');
  assert.equal(room.reading().props.latest, null, 'and the head has no number to read');

  room.log().transient.action.run();
  await settle();
  assert.equal(room.chart().props.points.length, 1);
  assert.equal(room.reading().props.latest.dateLocal, today);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(room.wire.filter((line) => line.startsWith('DELETE')), []);
});

// 13-gestures.md: a window decides which rows are drawn; it never decides what state a screen is in.
// The stance about the account reads the STORE, so the invitation to weigh in for the first time is
// never drawn over a number the transient is still offering back.
test('the chart’s empty stance reads the store, so a held delete of the only weigh-in draws no invitation and the settled one does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);
  assert.deepEqual(room.quiet(), []);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();
  assert.equal(room.chart(), undefined, 'the dot is off the chart, which is the window’s whole business');
  assert.deepEqual(room.quiet(), [], 'and nothing offers to seed an account the store has not stopped holding');
  assert.equal(room.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(room.onTheLog(), [], 'the store took it, and only now is the account empty');
  assert.deepEqual(room.quiet(), ['No weigh-ins yet.', 'Weigh in from the log and the number lands here.']);
});

test('a weigh-in delete the store refuses is said in the screen’s own words', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }], { deleteStatus: 500 });

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.equal(room.log().transient.text, 'That weigh-in wasn’t deleted. Try again in a moment.');
  assert.equal(room.log().transient.action, null);
  // The same rule on the other verb: the store refused, so the dot and the head reading are back.
  assert.equal(room.chart().props.points.length, 1);
  assert.equal(room.reading().props.latest.dateLocal, today);
});

// The one id in this room a lifter can write again. Every other verb is keyed by a mint, so the
// window's two answers — the delete still standing, and the id recorded gone — can only ever be
// about the row that was there. A date can be written again, and then both answers are wrong.

test('a weigh-in written again on a day whose delete is still holding takes that delete back, and nothing is sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();
  assert.equal(room.log().transient.action.label, 'Undo');

  room.chip().props.onOpen();
  await settle();
  assert.equal(await room.chipSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 }), null);
  await settle();
  assert.equal(room.log().held.length, 0, 'writing the day again IS the way back');

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(room.wire.filter((line) => line.startsWith('DELETE')), [], 'the clock is gone, so the new number is never destroyed');
  assert.deepEqual(room.onTheLog(), [{ dateLocal: today, weightKg: 79.5, recordedAt: 3 }]);
  assert.equal(room.reading().props.latest.weightKg, 79.5);
});

test('a weigh-in written again on a day whose delete already settled is drawn: the dot and the head reading both come back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(room.onTheLog(), [], 'the store took it, and the room records the date gone');
  assert.equal(room.chart(), undefined);

  room.chip().props.onOpen();
  await settle();
  assert.equal(await room.chipSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 }), null);
  await settle();

  assert.deepEqual(room.onTheLog(), [{ dateLocal: today, weightKg: 79.5, recordedAt: 3 }]);
  assert.equal(room.reading().props.latest.weightKg, 79.5, 'a number on the log that the room draws nowhere would be the worse lie');
  // The dot the title names, and the stance beside it: the day is back in the account, so the chart
  // may not go on offering to seed an account that holds a number the head is reading out.
  assert.equal(room.chart().props.points.length, 1);
  assert.deepEqual(room.quiet(), []);
});

test('a weigh-in written again while the delete’s send is still in the air is drawn: the room records nothing gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();

  // The seam the window has always had: the clock has fired, the DELETE is on the wire, and the
  // answer that would record the date gone has not come back yet.
  const takenFromTheWire = global.fetch;
  let answerTheDelete = null;
  global.fetch = async (url, options = {}) => {
    if ((options.method ?? 'GET') !== 'DELETE') return takenFromTheWire(url, options);
    await new Promise((resolve) => { answerTheDelete = resolve; });
    return takenFromTheWire(url, options);
  };
  t.mock.timers.tick(UNDO_MS);
  await settle();

  room.chip().props.onOpen();
  await settle();
  assert.equal(await room.chipSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 }), null);
  await settle();

  answerTheDelete();
  await settle();
  assert.equal(room.reading().props.latest.weightKg, 79.5, 'the date was written again, so it is not a date the store answered for');
  // And the chart is reading the same account the head is: the day is a day the account holds.
  assert.equal(room.chart().props.points.length, 1);
  assert.deepEqual(room.quiet(), []);
});
