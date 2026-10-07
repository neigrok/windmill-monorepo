import test from 'node:test';
import assert from 'node:assert/strict';

import { projectGym } from '../../../../src/products/gym/syncProjections.js';
import {
  browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf,
} from '../harness.mjs';

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const NOW = at(24, 18, 5);

const CATALOG = [
  { id: 'bench-press', name: 'Bench Press', stepKg: 2.5 },
  { id: 'overhead-press', name: 'Overhead Press', stepKg: 1.25 },
  { id: 'chin-up', name: 'Chin-up', stepKg: 2.5 },
  { id: 'face-pull', name: 'Face Pull', stepKg: 2.5 },
];

const PUSH_A = confirmed('routine', 'routinePushA', {
  name: 'Push A',
  position: 0,
  entries: [
    { exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }] },
    { exerciseId: 'overhead-press', sets: [{ reps: 8, weightKg: 32.5 }, { reps: 8, weightKg: 32.5 }, { reps: 8, weightKg: 32.5 }] },
    { exerciseId: 'chin-up', sets: [{ reps: 8 }, { reps: 7 }, { reps: 6 }] },
    { exerciseId: 'face-pull' },
  ],
});

// The one workout the account last trained these movements in: 19 Sep, each movement's `[kg, reps]`
// in the order it was lifted.
function lastWorkout(movements) {
  let minute = 0;
  return [
    confirmed('session', 'sessionOld01', { startedAt: at(19, 18), finishedAt: at(19, 19) }),
    ...movements.flatMap(([exerciseId, sets]) => sets.map(([weightKg, reps], index) => {
      minute += 1;
      return confirmed('set', `setOld_${exerciseId}_${index + 1}`, {
        sessionId: 'sessionOld01', exerciseId, setNumber: index + 1, weightKg, reps, kind: 'working', completedAt: at(19, 18, minute), note: '',
      });
    })),
  ];
}

// Push A, and last time for three of its four movements; Face Pull has never been trained.
const pushAAccount = (t, more = []) => gymAccount(t, [
  PUSH_A,
  ...lastWorkout([
    ['bench-press', [[60, 8], [60, 8], [57.5, 8]]],
    ['overhead-press', [[30, 8], [30, 8], [30, 8]]],
    ['chin-up', [[0, 8], [0, 7], [0, 6]]],
  ]),
  ...more,
]);

// The workout the form sent, as the replica holds it.
const imported = (gym) => gym.engine.device.activeReplica.entries().map((entry) => entry.intent.cmd?.args).filter(Boolean);

const named = (tree, name) => elementsOf(tree).filter((each) => typeof each.type === 'function' && each.type.name === name);

// The route draws one screen; the harness renders no child, so each level is hosted on its own.
async function route(t, target, log) {
  const { Backfill } = await loadScreen('products/gym/backfill/Backfill.jsx');
  const screen = Backfill({ target, log });
  const view = renderHook(t, () => screen.type(screen.props));
  await settle();
  view.redraw();
  return view;
}

async function form(t, target, log) {
  const outer = await route(t, target, log);
  if (outer.tree.type?.name !== 'PastWorkout' && named(outer.tree, 'PastWorkout').length === 0) return outer;
  const workout = outer.tree.type?.name === 'PastWorkout' ? outer.tree : named(outer.tree, 'PastWorkout')[0];
  return renderHook(t, () => workout.type(workout.props));
}

const movements = (tree) => named(tree, 'Movement').map((each) => ({ props: each.props, tree: each.type(each.props) }));

// Every row as the lifter reads it: the load cell, the reps cell.
const rowsOf = (movement) => named(movement.tree, 'EditableNumber').map((cell) => cell.props);

const saveButton = (tree) => findByClass(tree, 'gym-save-do')[0];

test('the pick lists the program in its own order, each row the log’s index row, and a free session under a rule', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  const four = [{}, {}, {}, {}];
  await gymAccount(t, [
    confirmed('routine', 'routineLegs1', { name: 'Legs', position: 2, entries: [{ exerciseId: 'a', sets: four }, { exerciseId: 'b', sets: four }, { exerciseId: 'c', sets: four }] }),
    PUSH_A,
    confirmed('routine', 'routineUpperB', { name: 'Upper B', position: 3, entries: [{ exerciseId: 'a' }, { exerciseId: 'b' }] }),
    confirmed('routine', 'routineGone1', { name: 'Gone', position: 1, entries: [{ exerciseId: 'a' }] }),
    confirmed('session', 'sessionPush1', { startedAt: at(22, 18), finishedAt: at(22, 19), routineId: 'routinePushA', historyRoutineId: 'routinePushA' }),
    confirmed('session', 'sessionLegs1', { startedAt: at(18, 9), finishedAt: at(18, 10), routineId: 'routineLegs1', historyRoutineId: 'routineLegs1' }),
  ]);
  // Gone is still in the store; the room's window is holding its delete.
  const outer = await route(t, null, roomLog({ held: [{ key: 'routine:routineGone1', kind: 'routine', id: 'routineGone1', settling: false }] }));
  assert.deepEqual(findByClass(outer.tree, 'gym-index-row').map((row) => [
    row.props.href, textOf(findByClass(row, 'gym-index-name')[0]), textOf(findByClass(row, 'gym-index-when')[0]), textOf(findByClass(row, 'gym-index-facts')[0]),
  ]), [
    ['#/gym/backfill/routinePushA', 'Push A', '22 Sep', '4 movements · 9 sets'],
    ['#/gym/backfill/routineLegs1', 'Legs', '18 Sep', '3 movements · 12 sets'],
    ['#/gym/backfill/routineUpperB', 'Upper B', 'Never trained', '2 movements'],
  ]);
  assert.deepEqual(findByClass(outer.tree, 'gym-index-free').map((link) => [link.props.href, textOf(link)]), [['#/gym/backfill/free', '+ Free session']]);
  assert.deepEqual(named(outer.tree, 'Back').map((back) => [back.props.href, back.props.children]), [['#/gym/log', 'The log']]);
  assert.deepEqual(findByClass(outer.tree, 'gym-title').map(textOf), ['Add a past workout']);
});

test('an account with no routines skips the pick: the free session, and a card that says where a routine comes from', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await gymAccount(t);
  const view = await form(t, null, roomLog({ catalog: CATALOG }));
  assert.deepEqual(named(view.tree, 'Back').map((back) => [back.props.href, back.props.children]), [['#/gym/log', 'The log']]);
  assert.deepEqual(findByClass(view.tree, 'gym-title').map(textOf), ['Free session']);
  assert.deepEqual(findByClass(view.tree, 'gym-past-card').map(textOf), ['No routines yetBuild one and this form arrives filled in.']);
  assert.deepEqual(named(view.tree, 'Button').map((button) => [button.props.href, button.props.children]), [['#/gym/routines/new', 'Build a routine']]);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 12:00–13:00']);
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save', true]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-units'), [], 'no rows, no column head');
});

test('a routine arrives filled: agreeing sets fold to a line and a rail, bodyweight reads its own way, an open line with no history waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  assert.deepEqual(named(view.tree, 'Back').map((back) => [back.props.href, back.props.children]), [['#/gym/backfill', 'Past workout']]);
  assert.deepEqual(findByClass(view.tree, 'gym-title').map(textOf), ['Push A']);
  assert.deepEqual(findByClass(view.tree, 'gym-past-units').map(textOf), ['kg × reps']);
  const drawn = movements(view.tree);
  assert.deepEqual(drawn.map(({ props, tree }) => [
    props.name, textOf(findByClass(tree, 'gym-past-scheme')[0]), props.open, props.focused, findByClass(tree, 'gym-past-rail-tick').length,
  ]), [
    ['Bench Press', '3 × 8 · 60', false, true, 3],
    ['Overhead Press', '3 × 8 · 32.5', false, false, 3],
    ['Chin-up', '3 × 6–8', true, false, 0],
    ['Face Pull', 'open · no last time', true, false, 0],
  ]);
  assert.deepEqual(rowsOf(drawn[2]).map((cell) => [cell.field, cell.value]), [
    ['load', 0], ['reps', 8], ['load', 0], ['reps', 7], ['load', 0], ['reps', 6],
  ]);
  assert.deepEqual(findByClass(drawn[3].tree, 'gym-past-add').map(textOf), ['+ Add set'], 'Add set is the open line’s only row');
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 9 sets', false]);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 12:00–13:00']);
  const [source] = named(view.tree, 'Source');
  assert.deepEqual(textOf(source.type(source.props)), 'Bench PressTarget3 × 8 · 60Last time · 19 Sep60 × 860 × 857.5 × 8Filled from the target. A blank load or rep count takes last time’s set.');
});

test('an edit carries down into the untouched sets below it, the carried numerals lift in turn, and the caption says so', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  movements(view.tree)[0].props.onOpen();
  let bench = movements(view.tree)[0];
  assert.equal(bench.props.open, true);
  rowsOf(bench)[0].onCommit(62.5);
  bench = movements(view.tree)[0];
  assert.deepEqual(rowsOf(bench).map((cell) => [cell.field, cell.value, cell.lift]), [
    ['load', 62.5, null], ['reps', 8, null],
    ['load', 62.5, { stamp: 1, delay: 0 }], ['reps', 8, null],
    ['load', 62.5, { stamp: 1, delay: 40 }], ['reps', 8, null],
  ]);
  assert.equal(rowsOf(bench)[0].stepKg, 2.5);
  rowsOf(bench)[5].onCommit(6);
  rowsOf(movements(view.tree)[0])[1].onCommit(7);
  bench = movements(view.tree)[0];
  assert.deepEqual(rowsOf(bench).map((cell) => cell.value), [62.5, 7, 62.5, 7, 62.5, 6]);
  assert.equal(textOf(findByClass(bench.tree, 'gym-past-scheme')[0]), '3 × 6–7 · 62.5');
  const [source] = named(view.tree, 'Source');
  assert.equal(textOf(source.type(source.props)).endsWith('An edit carries down to the sets below it you have not touched.'), true);
});

test('a set leaves by its ×, Add set copies the row above, and an emptied value keeps Save inert', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  const chin = () => movements(view.tree)[2];
  findByClass(chin().tree, 'gym-past-set-drop')[1].props.onClick();
  assert.deepEqual(rowsOf(chin()).map((cell) => cell.value), [0, 8, 0, 6]);
  findByClass(chin().tree, 'gym-past-add')[0].props.onClick();
  assert.deepEqual(rowsOf(chin()).map((cell) => cell.value), [0, 8, 0, 6, 0, 6]);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 9 sets');
  rowsOf(chin())[5].onCommit(null);
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 9 sets', true]);
});

test('a skipped movement leaves at once through the withheld window, and Undo puts it back where it stood', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const held = [];
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG, withhold: (entry) => held.push(entry) }));
  movements(view.tree)[1].props.onSkip();
  assert.deepEqual(movements(view.tree).map(({ props }) => props.name), ['Bench Press', 'Chin-up', 'Face Pull']);
  assert.deepEqual(held.map(({ kind, line, send }) => [kind, line, send]), [['entry', 'Overhead Press is out of this workout.', undefined]]);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 6 sets');
  held[0].undo();
  assert.deepEqual(movements(view.tree).map(({ props }) => props.name), ['Bench Press', 'Overhead Press', 'Chin-up', 'Face Pull']);
});

test('Save writes the whole workout in one command, reads Saved for 900ms, then opens the session with its Undo', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  // The log has a running workout on the phone: this door does not wait for it.
  const gym = await pushAAccount(t, [confirmed('session', 'sessionLive1', { startedAt: at(24, 17, 40) })]);
  const said = [];
  const running = { id: 'sessionLive1', startedAt: at(24, 17, 40) };
  const summaries = [running];
  const view = await form(t, 'routinePushA', roomLog({
    catalog: CATALOG,
    session: running,
    summaries,
    say: (text, options) => said.push([text, options?.action?.label]),
  }));
  findByClass(movements(view.tree)[3].tree, 'gym-past-add')[0].props.onClick();
  rowsOf(movements(view.tree)[3])[0].onCommit(20);
  rowsOf(movements(view.tree)[3])[1].onCommit(15);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 10 sets');
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);

  saveButton(view.tree).props.onClick();
  await settle();
  const [stored] = imported(gym);
  assert.match(stored.id, /^ses_[0-9a-f]{16}$/);
  const spread = (n) => at(24, 12) + Math.round((3_600_000 * n) / 11);
  assert.deepEqual(stored, {
    id: stored.id,
    startedAt: at(24, 12),
    finishedAt: at(24, 13),
    routineId: 'routinePushA',
    sets: [
      ['bench-press', 60, 8], ['bench-press', 60, 8], ['bench-press', 60, 8],
      ['overhead-press', 32.5, 8], ['overhead-press', 32.5, 8], ['overhead-press', 32.5, 8],
      ['chin-up', 0, 8], ['chin-up', 0, 7], ['chin-up', 0, 6],
      ['face-pull', 20, 15],
    ].map(([exerciseId, weightKg, reps], index) => ({
      id: `set_${stored.id.slice(4)}_${index + 1}`, exerciseId, weightKg, reps, completedAt: spread(index + 1), kind: 'working',
    })),
  });
  assert.deepEqual(gym.owed(), [`ready gym.importSession ${stored.id}`], 'one command, whole or not at all, and the routine is never written');
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Saved · 10 sets', true]);
  const { session, sets } = projectGym(gym.engine.observe('self/gym').getSnapshot().stored).session(stored.id);
  assert.deepEqual([session.startedAt, session.finishedAt, sets.length], [at(24, 12), at(24, 13), 10], 'the store holds the workout the moment it is saved');
  // The room reads the saved workout into the log; the note keeps reading the span it stored.
  summaries.unshift({ id: stored.id, startedAt: stored.startedAt, finishedAt: stored.finishedAt });
  view.redraw();
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 12:00–13:00']);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);
  assert.deepEqual(said, []);

  t.mock.timers.tick(900);
  assert.equal(window.location.hash, `#/gym/session/${stored.id}?from=%23%2Fgym%2Flog`);
  assert.deepEqual(said, [['Push A is in the log.', 'Undo']]);
});

test('a free session’s movement arrives with last time’s sets, and Save’s Undo opens the discard’s own window on the log', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, lastWorkout([['bench-press', [[60, 8]]]]));
  const said = [];
  const held = [];
  const view = await form(t, 'free', roomLog({
    catalog: CATALOG,
    say: (text, options) => said.push([text, options?.action]),
    holdDelete: (entry) => held.push(entry),
  }));
  assert.deepEqual(named(view.tree, 'Back').map((back) => [back.props.href, back.props.children]), [['#/gym/backfill', 'Past workout']]);
  assert.deepEqual(findByClass(view.tree, 'gym-title').map(textOf), ['Free session']);
  findByClass(view.tree, 'gym-past-add')[0].props.onClick();
  named(view.tree, 'MovementPicker')[0].props.onPick('bench-press');
  await settle();
  assert.deepEqual(named(view.tree, 'MovementPicker'), []);
  assert.deepEqual(movements(view.tree).map(({ props, tree }) => [props.name, textOf(findByClass(tree, 'gym-past-scheme')[0]), props.focused]), [
    ['Bench Press', '1 × 8 · 60', true],
  ]);
  const [source] = named(view.tree, 'Source');
  assert.equal(textOf(source.type(source.props)), 'Bench PressLast time · 19 Sep60 × 8A movement you add arrives with last time’s sets.');

  saveButton(view.tree).props.onClick();
  await settle();
  t.mock.timers.tick(900);
  const saved = window.location.hash.slice('#/gym/session/'.length).split('?')[0];
  assert.deepEqual(gym.owed(), [`ready gym.importSession ${saved}`]);
  assert.deepEqual(said.map(([text, action]) => [text, action.label]), [['Free session is in the log.', 'Undo']]);
  said[0][1].run();
  assert.equal(window.location.hash, '#/gym/log');
  assert.deepEqual(held.map(({ kind, id }) => [kind, id]), [['session', saved]]);
});

test('a time the lifter sets is checked against the log — the open session included — and refused in place with its two doors', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const earlier = { id: 'sessionPull1', startedAt: at(24, 15), finishedAt: at(24, 16, 10), plan: { routine: 'Pull A', entries: [] } };
  const running = { id: 'sessionLive1', startedAt: at(24, 17, 40) };
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG, summaries: [running, earlier], session: running }));
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 12:00–13:00']);

  findByClass(view.tree, 'gym-past-link')[0].props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-past-link'), [], 'the link gives way to the row it opened');
  const start = () => elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Start time');
  assert.equal(start().props.value, '12:00');
  assert.deepEqual(findByClass(view.tree, 'gym-chip').map((chip) => [textOf(chip), chip.props['aria-pressed']]), [
    ['Today', true], ['Yesterday', false], ['Other day', false], ['45 min', false], ['1 h', true], ['1 h 30', false],
  ]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);

  start().props.onChange({ target: { value: '15:30' } });
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 15:30–16:30']);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-body').map(textOf), [
    'Pull A · today · 15:00 – 16:10 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  ]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-open').map((link) => [link.props.href, textOf(link)]), [['#/gym/session/sessionPull1', 'Open that session ›']]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-fix').map(textOf), ['Change time']);
  assert.equal(saveButton(view.tree).props['aria-disabled'], true);

  start().props.onChange({ target: { value: '17:00' } });
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-body').map(textOf), [
    'Free session · today · 17:40 – now is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  ]);

  start().props.onChange({ target: { value: '17:30' } });
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === '45 min').props.onClick();
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === 'Yesterday').props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Yesterday · 17:30–18:15']);

  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === 'Today').props.onClick();
  start().props.onChange({ target: { value: '18:00' } });
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-title').map(textOf), ['These times cross a session already in the log.']);
  start().props.onChange({ target: { value: '17:00' } });
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === 'Yesterday').props.onClick();
  const other = elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Other day');
  assert.deepEqual([other.props.type, other.props.max], ['date', '2026-09-24']);
  other.props.onChange({ target: { value: '2026-09-22' } });
  assert.deepEqual(findByClass(view.tree, 'gym-chip').slice(0, 3).map((chip) => [textOf(chip), chip.props['aria-pressed']]), [
    ['Today', false], ['Yesterday', false], ['22 Sep', true],
  ]);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['22 Sep · 17:00–17:45']);
  other.props.onChange({ target: { value: '2026-09-25' } });
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['22 Sep · 17:00–17:45'], 'no day after today');
});

test('a lifter’s time that ends after now reads as running past now, and Save waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  findByClass(view.tree, 'gym-past-link')[0].props.onClick();
  elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Start time').props.onChange({ target: { value: '17:30' } });
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal').map(textOf), [
    'These times run past now.Thu 24 Sep · 17:30 for 1h 00m ends after now. Shorten it, or start it earlier.Change time',
  ]);
  assert.equal(saveButton(view.tree).props['aria-disabled'], true);
  elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Start time').props.onChange({ target: { value: '17:05' } });
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), [], 'ending exactly now is not ahead of it');
  assert.equal(saveButton(view.tree).props['aria-disabled'], false);
});

test('the store’s own overlap refusal — the log moved under the form — is drawn like the form’s, until the time moves', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  // The phone's workout reached the account; the room this form reads has not drawn it yet.
  const gym = await pushAAccount(t, [
    confirmed('session', 'sessionPhone', { startedAt: at(24, 11, 50), finishedAt: at(24, 12, 40), plan: { routine: 'Legs', entries: [] } }),
  ]);
  const said = [];
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-body').map(textOf), [
    'Legs · today · 11:50 – 12:40 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  ]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-open').map((link) => link.props.href), ['#/gym/session/sessionPhone']);
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 9 sets', true]);
  assert.deepEqual(said, []);
  findByClass(view.tree, 'gym-past-refusal-fix')[0].props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);
  assert.deepEqual(gym.owed(), [], 'the refused workout is not in the log, and changing the time writes nothing');
});

test('a press the browser could not keep is pressed again with the same request, ids and all, and lands once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  const gym = await pushAAccount(t);
  // Every press's command is read on its way into the replica; the first one's transaction then
  // fails in the browser, the way a full IndexedDB fails it.
  const pressed = [];
  let refusing = true;
  const commit = gym.engine.commit.bind(gym.engine);
  gym.engine.commit = (scope, build, options) => commit(scope, (views) => {
    const write = build(views);
    pressed.push(JSON.stringify(write.gesture.opts.cmd.args));
    return write;
  }, options);
  const transact = gym.engine.store.transact.bind(gym.engine.store);
  gym.engine.store.transact = (change, options = {}) => (refusing && !options.readonly
    ? transact((device) => { change(device); throw new DOMException('storage refused', 'QuotaExceededError'); }, options)
    : transact(change, options));
  const said = [];
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(said, ['That workout didn’t reach the log — this device couldn’t store it.']);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 9 sets');
  assert.deepEqual(gym.owed(), []);
  refusing = false;
  saveButton(view.tree).props.onClick();
  await settle();
  assert.equal(pressed.length, 2);
  assert.equal(pressed[1], pressed[0]);
  assert.deepEqual(gym.owed(), [`ready gym.importSession ${JSON.parse(pressed[0]).id}`]);
  assert.equal(textOf(saveButton(view.tree)), 'Saved · 9 sets');
});

test('two sets removed inside one collapse each take the set they name', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  window.matchMedia = () => ({ matches: false });
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  const chin = () => movements(view.tree)[2];
  findByClass(chin().tree, 'gym-past-set-drop')[0].props.onClick();
  findByClass(chin().tree, 'gym-past-set-drop')[1].props.onClick();
  assert.deepEqual(findByClass(chin().tree, 'gym-past-set').map((row) => row.props.className), [
    'gym-past-set is-leaving', 'gym-past-set is-leaving', 'gym-past-set',
  ]);
  t.mock.timers.tick(180);
  assert.deepEqual(rowsOf(chin()).map((cell) => cell.value), [0, 6]);
});

test('Saved does not pull the lifter back: a form already left goes nowhere, and one unmounted says nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await pushAAccount(t);
  const said = [];
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  window.location.hash = '#/gym/backfill/routinePushA';
  saveButton(view.tree).props.onClick();
  await settle();
  window.location.hash = '#/gym/notes';
  t.mock.timers.tick(900);
  assert.equal(window.location.hash, '#/gym/notes');
  assert.deepEqual(said, ['Push A is in the log.']);

  // The second form's room holds the first workout, so its default slot is a free one.
  const [first] = imported(gym);
  const second = await form(t, 'routinePushA', roomLog({
    catalog: CATALOG, summaries: [{ id: first.id, startedAt: first.startedAt, finishedAt: first.finishedAt }], say: (text) => said.push(`second: ${text}`),
  }));
  saveButton(second.tree).props.onClick();
  await settle();
  assert.equal(imported(gym).length, 2, 'the second workout landed too');
  second.unmount();
  t.mock.timers.tick(900);
  assert.deepEqual(said, ['Push A is in the log.']);
});

test('a day with no free slot opens the time row, focused, and the note asks for a start', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(24, 0, 10) });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  const start = () => elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Start time');
  assert.deepEqual([start().props.value, start().props.autoFocus], ['', true]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-link'), []);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Set a start time for this workout.']);
  assert.equal(saveButton(view.tree).props['aria-disabled'], true);
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === 'Yesterday').props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Yesterday · 12:00–13:00'], 'yesterday has its noon');
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === 'Today').props.onClick();
  start().props.onChange({ target: { value: '00:00' } });
  findByClass(view.tree, 'gym-chip').find((chip) => textOf(chip) === '45 min').props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-title').map(textOf), ['These times run past now.']);
  assert.equal(saveButton(view.tree).props['aria-disabled'], true);
});

test('a workout past the store’s two hundred sets says so, and Save waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await gymAccount(t, [confirmed('routine', 'routineBig01', {
    name: 'Big', position: 0,
    entries: Array.from({ length: 41 }, () => ({ exerciseId: 'bench-press', sets: Array.from({ length: 5 }, () => ({ reps: 5, weightKg: 20 })) })),
  })]);
  const view = await form(t, 'routineBig01', roomLog({ catalog: CATALOG }));
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 205 sets', true]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-limit').map(textOf), ['A workout holds up to 200 sets.']);
});
test('the routine’s ⋯ holds Log past above Delete, and it opens the filled form without the pick', async (t) => {
  browserWith();
  await gymAccount(t, [PUSH_A]);
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  const view = renderHook(t, () => RoutinesList({ log: roomLog() }));
  await settle();
  view.redraw();
  const [menu] = named(view.tree, 'Menu');
  assert.deepEqual(menu.props.items.map((item) => item.label), ['Log past', 'Delete']);
  menu.props.items[0].run();
  assert.equal(window.location.hash, '#/gym/backfill/routinePushA?from=routines');
});

test('a form opened from the routine’s ⋯ goes back to Routines; one opened from the pick goes back to it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const { Backfill } = await loadScreen('products/gym/backfill/Backfill.jsx');
  const backOf = async (from) => {
    const screen = Backfill({ target: 'routinePushA', from, log: roomLog({ catalog: CATALOG }) });
    const view = renderHook(t, () => screen.type(screen.props));
    await settle();
    view.redraw();
    const [workout] = named(view.tree, 'PastWorkout');
    return workout.props.back;
  };
  assert.deepEqual(await backOf('routines'), { href: '#/gym', label: 'Routines' });
  assert.deepEqual(await backOf('pick'), { href: '#/gym/backfill', label: 'Past workout' });
});

test('a cell focused while a carry lands reads the carried number: Enter confirms it and ↑ steps from it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  await pushAAccount(t);
  const view = await form(t, 'routinePushA', roomLog({ catalog: CATALOG }));
  const { EditableNumber } = await loadScreen('products/gym/backfill/EditableNumber.jsx');
  movements(view.tree)[0].props.onOpen();
  // Each cell hosts its own state and reads its props off the form as it stands on every render.
  const cellOf = (at) => renderHook(t, () => EditableNumber(rowsOf(movements(view.tree)[0])[at]));
  const first = cellOf(0);
  const second = cellOf(2);
  const alone = { closest: () => ({ querySelectorAll: () => [] }), blur: () => {} };
  const key = (name) => ({ key: name, shiftKey: false, preventDefault: () => {}, currentTarget: alone });
  const loads = () => rowsOf(movements(view.tree)[0]).filter((cell) => cell.field === 'load').map((cell) => cell.value);

  first.tree.props.onFocus({ currentTarget: {} });
  first.tree.props.onChange({ target: { value: '62.5' } });
  // Enter blurs the first cell and focuses the second inside one event, before the carry has drawn.
  first.tree.props.onBlur();
  second.tree.props.onFocus({ currentTarget: {} });
  first.redraw();
  second.redraw();
  assert.deepEqual(loads(), [62.5, 62.5, 62.5]);
  assert.equal(second.tree.props.value, '62.5', 'the focused cell reads the carry, not the number it was focused on');

  second.tree.props.onKeyDown(key('Enter'));
  second.redraw();
  assert.deepEqual(loads(), [62.5, 62.5, 62.5], 'Enter confirms the carried number and carries nothing back');

  second.tree.props.onFocus({ currentTarget: {} });
  second.tree.props.onKeyDown(key('ArrowUp'));
  second.redraw();
  assert.deepEqual(loads(), [62.5, 65, 65]);
  assert.equal(second.tree.props.value, '65');
});

test('the log’s door to a past workout is a plain link, open while a workout runs on the phone', async (t) => {
  browserWith();
  await gymAccount(t, [confirmed('session', 'sessionLive1', { startedAt: NOW })]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const running = { id: 'sessionLive1', startedAt: NOW };
  const view = renderHook(t, () => LogList({ log: roomLog({ session: running, summaries: [running] }) }));
  assert.deepEqual(findByClass(view.tree, 'gym-door-past').map((door) => [door.type, door.props.href, textOf(door)]), [
    ['a', '#/gym/backfill', 'Add past workout'],
    ['a', '#/gym/backfill', 'Add past workout'],
  ]);
});
