import test from 'node:test';
import assert from 'node:assert/strict';

import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { WINDOW_CLOSED } from '../../../src/products/gym/withheld.js';
import { dateLocalOf } from '../../../src/products/gym/bodyweight/bodyweight.js';
import {
  browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomAndScreen, roomLog, settle,
  textOf,
} from './harness.mjs';

// One wall clock for every test that lets the engine release a hold: the room's window and the
// engine's hold are both armed off it, so one tick closes both.
const NOW = new Date(2026, 8, 24, 18, 5).getTime();

// The room, alone, in a signed-in account with nothing in it.
async function room(t) {
  await gymAccount(t);
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const view = renderHook(t, () => useTrainingLog(), { live: true });
  await settle();
  return view;
}

// The room with one screen inside it, rendered as one tree: the window belongs to the room, and a
// screen tested without one is a screen that cannot exist.
async function roomWith(t, module, render) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const screens = await loadScreen(module);
  const view = renderHook(t, () => {
    const log = useTrainingLog();
    return { log, screen: render(screens, log) };
  }, { live: true });
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

// The account's one routine, as the server confirmed it.
const pushA = () => confirmed('routine', 'routinePushA', { name: 'Push A', position: 0, entries: [{ exerciseId: 'bench-press' }] });

const menuOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'Menu');
const routinesHome = (t) => roomWith(t, 'products/gym/Routines.jsx', ({ RoutinesList }, log) => RoutinesList({ log }));

test('a routine delete is in the row overflow, is held on the device until the window closes, and names the routine', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);

  assert.deepEqual(menuOf(home.screen()).props.items.map((item) => item.label), ['Log past', 'Delete']);
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'the row is off the home');
  await settle();
  assert.deepEqual(gym.owed(), ['held delete routine routinePushA'], 'held on the device, and nothing is owed to the store yet');
  // Deleting a routine cascades its proposals, so the transient says WHICH routine it was.
  assert.equal(home.log().transient.text, 'Push A deleted.');
  assert.equal(home.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete routine routinePushA']);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA'], 'the window closing is the release');
  assert.equal(home.log().transient, null);
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'and it stays gone');
});

test('a routine delete taken back is never sent, and the row is back on the home', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  home.log().transient.action.run();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), []);
});

// 13-gestures.md: a window decides which rows are drawn; it never decides what state a screen is in.
// The sharpest instance in the room, because this stance carries an ACT: every other one only says
// something that is wrong.
test('the home’s empty stance and its new routine action read the store: a held delete of the only routine offers no act, and the settled one does', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);
  const quiet = () => findByClass(home.screen(), 'gym-plan-empty').map(textOf);
  const build = () => elementsOf(findByClass(home.screen(), 'gym-plan-empty')[0])
    .filter((each) => typeof each.type === 'function' && each.type.name === 'Button' && textOf(each.props.children) === 'New routine');
  assert.deepEqual(quiet(), []);
  assert.deepEqual(build(), []);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'the row is off the home, which is all the window decides');
  assert.deepEqual(quiet(), [], 'the account still holds a routine, so nothing on this home says it holds none');
  assert.deepEqual(build(), [], 'least of all an act offered over a program that has one');
  assert.equal(home.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  // The stance becomes true only once the release takes the delete into the store the home reads.
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA']);
  assert.deepEqual(quiet(), ['No routines yet. Build the first one.']);
  assert.equal(build().length, 1, 'the store took it, and only now is the offer honest');
});

test('leaving the room takes its Undo with it, and the engine still lets the delete go on its own clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), []);

  // Out of the gym and into another product, four seconds in. The delete is already on the device;
  // the room that offered it back is what goes, and no clock of its own outlives it.
  t.mock.timers.tick(4000);
  home.view.unmount();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA'], 'the hold ran out on the engine’s clock');

  // Back in, after the hold: the routine is gone, and nothing is offered back for a delete that went.
  const again = await routinesHome(t);
  assert.deepEqual(findByClass(again.screen(), 'gym-routine-name').map(textOf), []);
  assert.equal(again.log().transient, null);
  assert.deepEqual(again.log().held, []);
});

test('a hidden tab ends the Undo: the offer leaves with the foreground, the row stays off, and nothing is said', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const browser = browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), []);

  // Another tab, four seconds in. A hidden tab is the app leaving the foreground — the exact
  // counterpart of the phones' ON_STOP — and leaving lets every held delete go into the queue.
  t.mock.timers.tick(4000);
  browser.hide();
  await settle();
  assert.deepEqual(home.log().held, [], 'the window let go of everything it was holding');
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), [], 'the row stays off: the delete stands');
  assert.equal(home.log().transient, null, 'and nothing is offered back or said');

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA'], 'the delete went into the queue');

  // Back to the tab: the routine is still gone, and still no sentence about it.
  browser.show();
  await settle();
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), []);
  assert.equal(home.log().transient, null);
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA']);
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
const homeAgainAndAgain = (t) => roomAndScreen(t, {
  module: 'products/gym/Routines.jsx',
  render: ({ RoutinesList }, log) => RoutinesList({ log }),
});
const namesOn = (home) => findByClass(home.screen(), 'gym-routine-name').map(textOf);

test('a delete settles into a screen that never armed it, and the row does not come back', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await homeAgainAndAgain(t);

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  home.redraw();
  assert.deepEqual(namesOn(home), [], 'off the home for the length of the window');
  await settle();

  // Off the tab and back, four seconds in. The new screen reads a store that STILL HAS the routine,
  // because a held delete is not in the store — and it knows nothing about the delete the screen
  // before it armed.
  t.mock.timers.tick(4000);
  await home.remount();
  assert.deepEqual(gym.owed(), ['held delete routine routinePushA'], 'the store the second screen reads still holds it');
  assert.deepEqual(namesOn(home), [], 'still held, and the room is what hides it');

  // The clock closes into a screen that armed nothing.
  t.mock.timers.tick(UNDO_MS);
  await settle();
  home.redraw();
  assert.deepEqual(gym.owed(), ['ready delete routine routinePushA']);
  assert.deepEqual(namesOn(home), [], 'the delete landed, and the row it hid stayed gone');
  assert.equal(home.log().transient, null, 'the window retired with its last clock');

  // And on every screen after that.
  await home.remount();
  assert.deepEqual(namesOn(home), []);
});

test('a refusal reaches the room even though the screen that armed it is gone, and the row is back', async (t) => {
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await homeAgainAndAgain(t);
  gym.refuseWrites();

  // The screen is torn down in the same turn as the act, before the device has answered it.
  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  await home.remount();
  await settle();
  home.redraw();
  assert.deepEqual(gym.owed(), []);
  // Nothing was taken, so nothing is hidden — and the sentence is still the one the screen wrote.
  assert.deepEqual(namesOn(home), ['Push A'], 'the device kept it, so the home draws it');
  assert.equal(
    home.log().transient.text,
    'Push A is still in your program — the log didn’t answer. Try again when you have signal.',
  );
});

test('a routine delete the device cannot keep says the routine is still in the program, and puts the row back', async (t) => {
  browserWith();
  const gym = await gymAccount(t, [pushA()]);
  const home = await routinesHome(t);
  gym.refuseWrites();

  menuOf(home.screen()).props.items.find((item) => item.label === 'Delete').run();
  await settle();

  assert.deepEqual(gym.owed(), []);
  assert.equal(
    home.log().transient.text,
    'Push A is still in your program — the log didn’t answer. Try again when you have signal.',
  );
  assert.deepEqual(findByClass(home.screen(), 'gym-routine-name').map(textOf), ['Push A']);
});

test('the editor’s × drops the line from the draft and hands the way back to the room’s transient', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const gym = await gymAccount(t, [confirmed('routine', 'routinePushA', {
    name: 'Push A', position: 0, entries: [{ exerciseId: 'bench-press' }, { exerciseId: 'dip' }],
  })]);
  const catalog = [{ id: 'bench-press', name: 'Bench Press' }, { id: 'dip', name: 'Dip' }];
  const editor = await roomWith(
    t,
    'products/gym/Routines.jsx',
    ({ RoutineEditor }, log) => RoutineEditor({ id: 'routinePushA', log: { ...log, catalog } }),
  );

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
  assert.deepEqual(gym.owed(), [], 'a draft edit writes nothing');
});

test('the editor’s window closes when the editor does, because the draft it would restore into is gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  await gymAccount(t, [confirmed('routine', 'routinePushA', { name: 'Push A', position: 0, entries: [{ exerciseId: 'dip' }] })]);
  const editor = await roomWith(
    t,
    'products/gym/Routines.jsx',
    ({ RoutineEditor }, log) => RoutineEditor({ id: 'routinePushA', log: { ...log, catalog: [{ id: 'dip', name: 'Dip' }] } }),
  );

  elementsOf(editor.screen())
    .find((each) => typeof each.type === 'function' && each.type.name === 'EntryList').props.onRemove(0);
  assert.equal(editor.log().held.length, 1);

  editor.view.unmount();
  assert.equal(editor.log().held.length, 0);
});

// A short finished workout: no sets, so its review offers Keep it or Discard.
const shortSession = () => confirmed('session', 'session0001', { startedAt: 1_755_000_000_000, finishedAt: 1_755_000_600_000 });

// A child component is not rendered by the harness, and the short-session block reads the account
// through hooks, so it is drawn inside the same render as the review that holds it.
const reviewWithShort = (review) => {
  const element = elementsOf(review).find((each) => typeof each.type === 'function' && each.type.name === 'ShortSession');
  return { review, short: element ? element.type(element.props) : null };
};

test('Discard asks nothing, holds the session for the window, and only then lets it go to the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const finish = await roomWith(t, 'products/gym/Finish.jsx', ({ FinishScreen }, log) => reviewWithShort(FinishScreen({ id: 'session0001', log })));
  const short = () => finish.screen().short;
  const discard = findByClass(short(), 'gym-short-discard')[0];
  assert.equal(textOf(discard), 'Discard session');
  window.location.hash = '#/gym/finish/session0001';
  discard.props.onClick();

  // No confirmation stands between the press and the window; Law 2 refuses one on an undoable act.
  assert.equal(findByClass(short(), 'gym-confirm').length, 0);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete session session0001']);
  assert.equal(finish.log().transient.text, 'Session deleted.');
  assert.equal(finish.log().transient.action.label, 'Undo');
  assert.equal(window.location.hash, '#/gym', 'the lifter is back in the room, and the transient came with them');

  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete session session0001']);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete session session0001']);
  assert.equal(finish.log().transient, null);
});

test('a discard taken back inside the window never reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const finish = await roomWith(t, 'products/gym/Finish.jsx', ({ FinishScreen }, log) => reviewWithShort(FinishScreen({ id: 'session0001', log })));

  findByClass(finish.screen().short, 'gym-short-discard')[0].props.onClick();
  finish.log().transient.action.run();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), []);
});

test('a finished session’s detail draws Discard session, and it takes the same window as every other delete', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const detail = await roomWith(t, 'products/gym/Log.jsx', ({ SessionDetail }, log) => SessionDetail({ id: 'session0001', log }));

  const discard = findByClass(detail.screen(), 'gym-short-discard');
  assert.equal(discard.length, 1);
  assert.equal(textOf(discard[0]), 'Discard session');
  window.location.hash = '#/gym/log/session0001';
  discard[0].props.onClick();

  assert.equal(findByClass(detail.screen(), 'gym-confirm').length, 0, 'no confirmation in front of an act with a way back');
  assert.equal(detail.log().hidden('session').has('session0001'), true);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete session session0001']);
  assert.equal(detail.log().transient.text, 'Session deleted.');
  assert.equal(detail.log().transient.action.label, 'Undo');
  assert.equal(window.location.hash, '#/gym/log', 'the lifter is on the log, where the row is already off it');

  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete session session0001']);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete session session0001']);
  assert.equal(detail.log().transient, null);
});

test('a detail discard taken back never reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const detail = await roomWith(t, 'products/gym/Log.jsx', ({ SessionDetail }, log) => SessionDetail({ id: 'session0001', log }));
  findByClass(detail.screen(), 'gym-short-discard')[0].props.onClick();
  detail.log().transient.action.run();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), []);
});

test('a detail discard the device cannot keep says the session was not discarded, in the review’s own words', async (t) => {
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const detail = await roomWith(t, 'products/gym/Log.jsx', ({ SessionDetail }, log) => SessionDetail({ id: 'session0001', log }));
  gym.refuseWrites();
  findByClass(detail.screen(), 'gym-short-discard')[0].props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), []);
  assert.equal(
    detail.log().transient.text,
    'That session wasn’t discarded — the log didn’t answer. Try again when you have signal.',
  );
  assert.equal(detail.log().hidden('session').has('session0001'), false, 'the device kept it, so the log draws it');
});

test('the open session’s detail draws no discard: the phone owns it', async (t) => {
  browserWith();
  await gymAccount(t, [confirmed('session', 'session0001', { startedAt: Date.now() - 600_000 })]);
  const detail = await roomWith(t, 'products/gym/Log.jsx', ({ SessionDetail }, log) => SessionDetail({ id: 'session0001', log }));
  assert.equal(findByClass(detail.screen(), 'gym-reader-totals').length, 1, 'the open session is drawn');
  assert.equal(findByClass(detail.screen(), 'gym-short-discard').length, 0);
});

test('history hides pending sessions immediately and restores them on Undo from the rows it already drew', async (t) => {
  browserWith();
  await gymAccount(t, [
    confirmed('session', 'session0001', { startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000, displayName: 'Push A' }),
    confirmed('session', 'session0002', { startedAt: 1_754_900_000_000, finishedAt: 1_754_903_600_000, displayName: 'Pull A' }),
  ]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  let held = [{ key: 'session:session0001', kind: 'session', id: 'session0001', line: 'Session deleted.', at: 1, settling: false }];
  const screen = renderHook(t, () => LogList({ log: roomLog({ held }) }));
  await settle();
  const rows = () => elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'HistoryIndex').props.sessions.map((session) => session.id);
  assert.deepEqual(rows(), ['session0002']);
  held = [];
  screen.redraw();
  assert.deepEqual(rows(), ['session0001', 'session0002']);
});

// The log's own instance of the law: the settled delete has to leave the READ as well as the drawn
// rows, and the stance follows the store and never the window.
test('the log’s empty stance reads the store: a held delete of the only session invites nothing, and the settled one does', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [shortSession()]);
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const { FinishScreen } = await loadScreen('products/gym/Finish.jsx');
  const view = renderHook(t, () => {
    const log = useTrainingLog();
    return { log, logScreen: LogList({ log }), finish: reviewWithShort(FinishScreen({ id: 'session0001', log })) };
  }, { live: true });
  await settle();
  const quiet = () => findByClass(view.tree.logScreen, 'gym-quiet').map(textOf);
  const rows = () => elementsOf(view.tree.logScreen).find((each) => typeof each.type === 'function' && each.type.name === 'HistoryIndex').props.sessions.length;
  const short = () => view.tree.finish.short;
  assert.equal(rows(), 1);
  assert.deepEqual(quiet(), []);

  findByClass(short(), 'gym-short-discard')[0].props.onClick();
  await settle();
  assert.equal(rows(), 0, 'the row is off the log, which is all the window decides');
  assert.deepEqual(quiet(), [], 'and the account still holds the session, so nothing offers to log the first one');
  assert.equal(view.tree.log.transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete session session0001']);
  assert.deepEqual(quiet(), ['No sessions yet.']);
});

// The other screen that reads the log's page for a decision, and the decision is a REFUSAL with a
// door in it. `withhold` is the room's own verb, the one `ShortSession` calls; this drives it
// directly so the test stays on the screen whose read is under test.
test('the past workout’s overlap refusal reads the account: it stands while the window holds the session it names, and falls away once the store has answered', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, [confirmed('session', 'session0001', {
    startedAt: new Date(2026, 8, 24, 15).getTime(), finishedAt: new Date(2026, 8, 24, 16, 10).getTime(),
  })]);
  const past = await roomWith(t, 'products/gym/backfill/Backfill.jsx', ({ Backfill }, log) => {
    const workout = Backfill({ target: 'free', log });
    return workout.type(workout.props);
  });
  findByClass(past.screen(), 'gym-past-add')[0].props.onClick();
  past.view.redraw();
  elementsOf(past.screen()).find((each) => typeof each.type === 'function' && each.type.name === 'MovementPicker').props.onPick('bench-press');
  await settle();
  past.view.redraw();
  const cell = (field) => {
    const [movement] = elementsOf(past.screen()).filter((each) => typeof each.type === 'function' && each.type.name === 'Movement');
    return elementsOf(movement.type(movement.props))
      .find((each) => typeof each.type === 'function' && each.type.name === 'EditableNumber' && each.props.field === field);
  };
  cell('load').props.onCommit(60);
  past.view.redraw();
  cell('reps').props.onCommit(8);
  past.view.redraw();
  findByClass(past.screen(), 'gym-past-link')[0].props.onClick();
  past.view.redraw();
  elementsOf(past.screen()).find((each) => each.props?.['aria-label'] === 'Start time').props.onChange({ target: { value: '15:30' } });
  past.view.redraw();

  const refusal = () => findByClass(past.screen(), 'gym-past-refusal-body').map(textOf);
  const door = () => findByClass(past.screen(), 'gym-past-refusal-open').map((each) => each.props.href);
  assert.equal(refusal().length, 1, 'the account holds that session, so the workout that crosses it is refused');
  assert.deepEqual(door(), ['#/gym/session/session0001']);

  past.log().withhold({ kind: 'session', id: 'session0001', engineDeath: { type: 'session', id: 'session0001' }, line: 'Session deleted.' });
  await settle();
  past.view.redraw();
  assert.deepEqual(gym.owed(), ['held delete session session0001']);
  assert.equal(refusal().length, 1, 'a window decides which rows are drawn, and never whether a workout may be filed');
  assert.deepEqual(door(), ['#/gym/session/session0001'], 'and the door it offers still opens on a session that is there');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  past.view.redraw();
  assert.deepEqual(gym.owed(), ['ready delete session session0001']);
  assert.deepEqual(refusal(), [], 'the store answered, so nothing is left to cross');
  assert.deepEqual(door(), [], 'and no door onto `This session isn’t in your log.`');
  findByClass(past.screen(), 'gym-save-do')[0].props.onClick();
  await settle();
  assert.deepEqual(gym.owed().map((line) => line.replace(/ses_[0-9a-f]{16}$/, 'ses_…')),
    ['ready delete session session0001', 'ready gym.importSession ses_…'], 'and the workout is filed');
});

// ── The two verbs that used to ask a question ───────────────────────────────
// A note and a weigh-in are deleted in one press, and every state a confirmation would carry is
// homed here: `are you sure` is the window, `this row is gone` is `log.hidden`, and a refusal is
// said by the room.

// The account's notes as the server confirmed them, in the store's order.
const storedNotes = (count) => Array.from({ length: count }, (_, at) =>
  confirmed('note', `note00000${at}`, { title: `Note ${at}`, body: '', ord: `a${at}`, updatedAt: 0 }));

const noteList = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteList');
const noteEditor = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteEditor');
const noteCount = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'CoachNavigation').props.noteCount;
const notesRoom = (t) => roomWith(t, 'products/gym/notes/Notes.jsx', ({ Notes }, log) => Notes({ log }));

test('a note delete is one press, leaves the editor in the same act, and is held on the device until the window closes', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, storedNotes(3));
  const notes = await notesRoom(t);

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  assert.notEqual(noteEditor(notes.screen()), undefined);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  assert.equal(noteEditor(notes.screen()), undefined, 'the editor is left in the same act');
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
  assert.deepEqual(gym.owed(), ['held delete note note000001'], 'held on the device, and nothing is owed to the store yet');
  assert.equal(noteCount(notes.screen()), 3, 'the store still holds it');
  assert.equal(notes.log().transient.text, 'Note deleted.');
  assert.equal(notes.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  // The release takes the note out of the store, so the list is read again — and a reorder sent
  // afterwards carries the store's own list rather than an id the store no longer has.
  assert.deepEqual(gym.owed(), ['ready delete note note000001']);
  assert.equal(noteCount(notes.screen()), 2, 'the list was read again from the store');
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
});

test('the re-read after a note delete keeps the list drawn: the screen does not blank nine seconds after the act', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, storedNotes(3));
  const notes = await notesRoom(t);

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  // The release lands in the store; the re-read behind it is still in the air at that moment.
  const meanwhile = [];
  gym.engine.observe('self/gym').subscribe(() => meanwhile.push({
    titles: noteList(notes.screen())?.props.notes.map((note) => note.title),
    opening: findByClass(notes.screen(), 'gym-quiet').length,
  }));
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.notEqual(meanwhile.length, 0, 'the store changed under the screen');
  for (const drawn of meanwhile) {
    assert.deepEqual(drawn, { titles: ['Note 0', 'Note 2'], opening: 0 }, 'the rows stand, never back to `Opening your notes…`');
  }
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 2']);
});

test('a note delete taken back is never sent, and the row is back on the list', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, storedNotes(3));
  const notes = await notesRoom(t);

  const held = noteList(notes.screen()).props.notes[0];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();
  notes.log().transient.action.run();
  await settle();
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 1', 'Note 2']);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), []);
});

test('the cap is the store’s count: a tenth note held for deletion still fills the account, so the cap line stands', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  await gymAccount(t, storedNotes(10));
  const notes = await notesRoom(t);
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-full')[0]), '10 of 10 notes. Delete one to add another.');

  const held = noteList(notes.screen()).props.notes[9];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  assert.equal(noteList(notes.screen()).props.notes.length, 9, 'nine rows are drawn');
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-full')[0]), '10 of 10 notes. Delete one to add another.');
  assert.equal(findByClass(notes.screen(), 'gym-notes-add').length, 0, 'and no door onto a mint the store would refuse');

  // Once the delete is released into the store, the account really has nine and the door comes back.
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(findByClass(notes.screen(), 'gym-notes-full').length, 0);
  assert.equal(textOf(findByClass(notes.screen(), 'gym-notes-add')[0]), 'Add a note');
});

test('a note delete the device cannot keep is said in the room’s words, and the row is back because nothing was taken', async (t) => {
  browserWith();
  const gym = await gymAccount(t, storedNotes(3));
  const notes = await notesRoom(t);
  // The browser's refusal carries no sentence, so what is read is the room's own.
  gym.refuseWrites();

  const held = noteList(notes.screen()).props.notes[1];
  noteList(notes.screen()).props.onOpen(held);
  noteEditor(notes.screen()).props.onDelete(held);
  await settle();

  assert.equal(notes.log().transient.text, 'That note wasn’t deleted — the log didn’t answer. Try again when you have signal.');
  assert.equal(notes.log().transient.action, null, 'a refusal carries no way back');
  assert.deepEqual(gym.owed(), []);
  // Nothing was taken, so the row is back — which is the state the sentence names, and the reason
  // it names the way out as trying again.
  assert.deepEqual(noteList(notes.screen()).props.notes.map((note) => note.title), ['Note 0', 'Note 1', 'Note 2']);
});

// Both screens that read the series, in one room: the chart owns one instance of `useBodyweight` and
// the log owns a second, and the hide is inside the hook precisely so the two never disagree.
async function weighInRoom(t, entries) {
  const gym = await gymAccount(t, entries.map(({ dateLocal, weightKg, recordedAt }) => confirmed('weighin', dateLocal, { kg: weightKg, recordedAt })));
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => {
    const log = useTrainingLog();
    return { log, chart: BodyweightScreen({ log }), logScreen: LogList({ log }) };
  }, { live: true });
  await settle();
  const named = (tree, name) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === name);
  // The weigh-ins the store holds, in the store's own words.
  const onTheLog = () => gym.engine.observe('self/gym').getSnapshot().stored
    .filter((row) => row.t === 'weighin' && row.life?.[0] !== 'dead')
    .map((row) => ({ dateLocal: row.id, weightKg: row.f.kg[0], recordedAt: row.f.recordedAt[0] }));
  const reading = () => named(view.tree.logScreen, 'BodyweightReading');
  const chart = () => named(view.tree.chart, 'DotChart');
  const sheet = () => named(view.tree.chart, 'WeighInSheet');
  const weighButton = () => findByClass(view.tree.logScreen, 'gym-history-weigh')[0];
  const logSheet = () => named(view.tree.logScreen, 'WeighInSheet');
  // Every quiet line the chart screen is drawing: its stance about the account, and its line about
  // the window it is showing.
  const quiet = () => findByClass(view.tree.chart, 'gym-quiet').map(textOf);
  return { owed: gym.owed, refuseWrites: gym.refuseWrites, onTheLog, log: () => view.tree.log, reading, chart, sheet, weighButton, logSheet, quiet };
}

test('a weigh-in delete is one press, closes the sheet over the transient, and drops the dot AND the log’s head reading together', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
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
  assert.deepEqual(room.owed(), [`held delete weighin ${today}`]);
  assert.equal(room.log().transient.text, 'Weigh-in deleted.');
  assert.equal(room.log().transient.action.label, 'Undo');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(room.owed(), [`ready delete weighin ${today}`]);
});

test('a weigh-in delete taken back puts the dot and the reading back, and never reaches the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
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
  assert.deepEqual(room.owed(), []);
});

// 13-gestures.md: a window decides which rows are drawn; it never decides what state a screen is in.
// The stance about the account reads the STORE, so the invitation to weigh in for the first time is
// never drawn over a number the transient is still offering back.
test('the chart’s empty stance reads the store, so a held delete of the only weigh-in draws no invitation and the settled one does', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
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

test('a weigh-in delete the device cannot keep is said in the screen’s own words', async (t) => {
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);
  room.refuseWrites();

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();

  assert.equal(room.log().transient.text, 'That weigh-in wasn’t deleted. Try again in a moment.');
  assert.equal(room.log().transient.action, null);
  assert.deepEqual(room.owed(), []);
  // The same rule on the other verb: nothing was taken, so the dot and the head reading are back.
  assert.equal(room.chart().props.points.length, 1);
  assert.equal(room.reading().props.latest.dateLocal, today);
});

// The one id in this room a lifter can write again. Every other verb is keyed by a mint, so the
// window's two answers — the delete still standing, and the id recorded gone — can only ever be
// about the row that was there. A date can be written again, and then both answers are wrong.

test('a weigh-in written again on a day whose delete is still holding takes that delete back, and nothing is sent', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();
  assert.equal(room.log().transient.action.label, 'Undo');

  room.weighButton().props.onClick();
  await settle();
  assert.equal(await room.logSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 }), null);
  await settle();
  assert.equal(room.log().held.length, 0, 'writing the day again IS the way back');
  assert.deepEqual(room.owed(), [`ready put weighin ${today} kg recordedAt`], 'the held delete is retired by the write');

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(room.owed(), [`ready put weighin ${today} kg recordedAt`], 'no hold is left to destroy the new number');
  assert.deepEqual(room.onTheLog(), [{ dateLocal: today, weightKg: 79.5, recordedAt: NOW }]);
  assert.equal(room.reading().props.latest.weightKg, 79.5);
});

test('a weigh-in written again on a day whose delete already settled is drawn: the dot and the head reading both come back', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(room.onTheLog(), [], 'the store took it, and the room records the date gone');
  assert.equal(room.chart(), undefined);

  room.weighButton().props.onClick();
  await settle();
  assert.equal(await room.logSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 }), null);
  await settle();

  assert.deepEqual(room.onTheLog(), [{ dateLocal: today, weightKg: 79.5, recordedAt: NOW + UNDO_MS }]);
  assert.equal(room.reading().props.latest.weightKg, 79.5, 'a number on the log that the room draws nowhere would be the worse lie');
  // The dot the title names, and the stance beside it: the day is back in the account, so the chart
  // may not go on offering to seed an account that holds a number the head is reading out.
  assert.equal(room.chart().props.points.length, 1);
  assert.deepEqual(room.quiet(), []);
});

test('a weigh-in written again while the delete’s release is still landing is drawn: the room records nothing gone', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const today = dateLocalOf(Date.now());
  const room = await weighInRoom(t, [{ dateLocal: today, weightKg: 82.4, recordedAt: 2 }]);

  room.chart().props.onPick(room.chart().props.points[0]);
  room.sheet().props.onDelete(today);
  await settle();

  // The seam the window has: the clock has fired, the engine is writing the release, and the day is
  // written again before that write has landed.
  t.mock.timers.tick(UNDO_MS);
  room.weighButton().props.onClick();
  const saved = room.logSheet().props.onSave({ dateLocal: today, weightKg: 79.5, recordedAt: 3 });
  assert.equal(await saved, null);
  await settle();

  assert.deepEqual(room.onTheLog(), [{ dateLocal: today, weightKg: 79.5, recordedAt: NOW + UNDO_MS }]);
  assert.equal(room.reading().props.latest.weightKg, 79.5, 'the date was written again, so it is not a date the store answered for');
  // And the chart is reading the same account the head is: the day is a day the account holds.
  assert.equal(room.chart().props.points.length, 1);
  assert.deepEqual(room.quiet(), []);
});
