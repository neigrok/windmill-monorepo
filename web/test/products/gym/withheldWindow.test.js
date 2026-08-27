import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { WINDOW_CLOSED } from '../../../src/products/gym/withheld.js';
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
