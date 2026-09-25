import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const NOW = at(24, 18, 5);

const CATALOG = [
  { id: 'bench-press', name: 'Bench Press', stepKg: 2.5 },
  { id: 'overhead-press', name: 'Overhead Press', stepKg: 1.25 },
  { id: 'chin-up', name: 'Chin-up', stepKg: 2.5 },
  { id: 'face-pull', name: 'Face Pull', stepKg: 2.5 },
];

const PUSH_A = {
  id: 'rt_push',
  name: 'Push A',
  position: 0,
  lastTrainedAt: at(22, 18),
  entries: [
    { position: 0, exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }] },
    { position: 1, exerciseId: 'overhead-press', sets: [{ reps: 8, weightKg: 32.5 }, { reps: 8, weightKg: 32.5 }, { reps: 8, weightKg: 32.5 }] },
    { position: 2, exerciseId: 'chin-up', sets: [{ reps: 8 }, { reps: 7 }, { reps: 6 }] },
    { position: 3, exerciseId: 'face-pull' },
  ],
};

const lastOf = (exerciseId, sets) => ({
  exerciseId,
  ...(sets ? { session: { id: 'ses_old', startedAt: at(19, 18) }, sets: sets.map(([weightKg, reps]) => ({ weightKg, reps, kind: 'working' })) } : {}),
});

// The store on the wire, answering from a table of `METHOD /path` → reply or (body) => reply.
function store(routes) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body ? `${method} ${path} ${options.body}` : `${method} ${path}`);
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    const { status = 200, reply = {} } = typeof route === 'function' ? route(body) : route;
    return { ok: status < 300, status, headers: { get: () => null }, json: async () => reply };
  };
  return calls;
}

const pushARoutes = (extra = {}) => ({
  'GET /routines/rt_push': { reply: PUSH_A },
  'GET /last?exercise=bench-press': { reply: lastOf('bench-press', [[60, 8], [60, 8], [57.5, 8]]) },
  'GET /last?exercise=overhead-press': { reply: lastOf('overhead-press', [[30, 8], [30, 8], [30, 8]]) },
  'GET /last?exercise=chin-up': { reply: lastOf('chin-up', [[0, 8], [0, 7], [0, 6]]) },
  'GET /last?exercise=face-pull': { reply: lastOf('face-pull') },
  ...extra,
});

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
  store({
    'GET /routines': {
      reply: {
        routines: [
          { id: 'rt_legs', name: 'Legs', position: 2, lastTrainedAt: at(18, 9), entries: [{ exerciseId: 'a', sets: [{}, {}, {}, {}] }, { exerciseId: 'b', sets: [{}, {}, {}, {}] }, { exerciseId: 'c', sets: [{}, {}, {}, {}] }] },
          PUSH_A,
          { id: 'rt_upper', name: 'Upper B', position: 3, entries: [{ exerciseId: 'a' }, { exerciseId: 'b' }] },
          { id: 'rt_gone', name: 'Gone', position: 1, entries: [] },
        ],
      },
    },
  });
  const outer = await route(t, null, roomLog({ held: [{ key: 'routine:rt_gone', kind: 'routine', id: 'rt_gone', settling: false }] }));
  assert.deepEqual(findByClass(outer.tree, 'gym-index-row').map((row) => [
    row.props.href, textOf(findByClass(row, 'gym-index-name')[0]), textOf(findByClass(row, 'gym-index-when')[0]), textOf(findByClass(row, 'gym-index-facts')[0]),
  ]), [
    ['#/gym/backfill/rt_push', 'Push A', '22 Sep', '4 movements · 9 sets'],
    ['#/gym/backfill/rt_legs', 'Legs', '18 Sep', '3 movements · 12 sets'],
    ['#/gym/backfill/rt_upper', 'Upper B', 'Never trained', '2 movements'],
  ]);
  assert.deepEqual(findByClass(outer.tree, 'gym-index-free').map((link) => [link.props.href, textOf(link)]), [['#/gym/backfill/free', '+ Free session']]);
  assert.deepEqual(named(outer.tree, 'Back').map((back) => [back.props.href, back.props.children]), [['#/gym/log', 'The log']]);
  assert.deepEqual(findByClass(outer.tree, 'gym-title').map(textOf), ['Add a past workout']);
});

test('an account with no routines skips the pick: the free session, and a card that says where a routine comes from', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  store({ 'GET /routines': { reply: { routines: [] } } });
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
  const calls = store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
  assert.deepEqual(calls, [
    'GET /routines/rt_push',
    'GET /last?exercise=bench-press',
    'GET /last?exercise=overhead-press',
    'GET /last?exercise=chin-up',
    'GET /last?exercise=face-pull',
  ]);
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
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  store(pushARoutes());
  const held = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, withhold: (entry) => held.push(entry) }));
  movements(view.tree)[1].props.onSkip();
  assert.deepEqual(movements(view.tree).map(({ props }) => props.name), ['Bench Press', 'Chin-up', 'Face Pull']);
  assert.deepEqual(held.map(({ kind, line, send }) => [kind, line, send]), [['entry', 'Overhead Press is out of this workout.', undefined]]);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 6 sets');
  held[0].undo();
  assert.deepEqual(movements(view.tree).map(({ props }) => props.name), ['Bench Press', 'Overhead Press', 'Chin-up', 'Face Pull']);
});

test('Save writes the whole workout in one request, reads Saved for 900ms, then opens the session with its Undo', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  let stored = null;
  const calls = store(pushARoutes({
    'POST /sessions/import': (body) => {
      stored = body;
      return { status: 201, reply: { session: { id: body.id, startedAt: body.startedAt, finishedAt: body.finishedAt }, sets: [] } };
    },
  }));
  const said = [];
  let reloads = 0;
  // The log has a running workout on the phone: this door does not wait for it.
  const running = { id: 'ses_live', startedAt: at(24, 17, 40) };
  const summaries = [running];
  const view = await form(t, 'rt_push', roomLog({
    catalog: CATALOG,
    session: running,
    summaries,
    say: (text, options) => said.push([text, options?.action?.label]),
    reloadLog: async () => { reloads += 1; },
  }));
  findByClass(movements(view.tree)[3].tree, 'gym-past-add')[0].props.onClick();
  rowsOf(movements(view.tree)[3])[0].onCommit(20);
  rowsOf(movements(view.tree)[3])[1].onCommit(15);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 10 sets');
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);

  saveButton(view.tree).props.onClick();
  await settle();
  assert.match(stored.id, /^ses_[0-9a-f]{16}$/);
  const spread = (n) => at(24, 12) + Math.round((3_600_000 * n) / 11);
  assert.deepEqual(stored, {
    id: stored.id,
    startedAt: at(24, 12),
    finishedAt: at(24, 13),
    routineId: 'rt_push',
    sets: [
      ['bench-press', 60, 8], ['bench-press', 60, 8], ['bench-press', 60, 8],
      ['overhead-press', 32.5, 8], ['overhead-press', 32.5, 8], ['overhead-press', 32.5, 8],
      ['chin-up', 0, 8], ['chin-up', 0, 7], ['chin-up', 0, 6],
      ['face-pull', 20, 15],
    ].map(([exerciseId, weightKg, reps], index) => ({
      id: `set_${stored.id.slice(4)}_${index + 1}`, exerciseId, weightKg, reps, completedAt: spread(index + 1), kind: 'working',
    })),
  });
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'one request, whole or not at all');
  assert.equal(calls.some((call) => /routines\/rt_push /.test(call) && !call.startsWith('GET')), false, 'the routine is never written');
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Saved · 10 sets', true]);
  assert.equal(reloads, 1);
  // The reload brings the saved workout into the log; the note keeps reading the span it stored.
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
  store({
    'GET /last?exercise=bench-press': { reply: lastOf('bench-press', [[60, 8]]) },
    'POST /sessions/import': (body) => ({ status: 201, reply: { session: { id: body.id }, sets: [] } }),
  });
  const said = [];
  const held = [];
  const view = await form(t, 'free', roomLog({
    catalog: CATALOG,
    say: (text, options) => said.push([text, options?.action]),
    withhold: (entry) => held.push(entry),
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
  assert.deepEqual(said.map(([text, action]) => [text, action.label]), [['Free session is in the log.', 'Undo']]);
  said[0][1].run();
  assert.equal(window.location.hash, '#/gym/log');
  assert.deepEqual(held.map(({ kind, id, line }) => [kind, id, line]), [['session', saved, 'Session deleted.']]);
});

test('a time the lifter sets is checked against the log — the open session included — and refused in place with its two doors', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  store(pushARoutes());
  const earlier = { id: 'ses_1', startedAt: at(24, 15), finishedAt: at(24, 16, 10), plan: { routine: 'Pull A', entries: [] } };
  const running = { id: 'ses_live', startedAt: at(24, 17, 40) };
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, summaries: [running, earlier], session: running }));
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
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-open').map((link) => [link.props.href, textOf(link)]), [['#/gym/session/ses_1', 'Open that session ›']]);
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
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  const crossed = { id: 'ses_phone', startedAt: at(24, 11, 50), finishedAt: at(24, 12, 40), plan: { routine: 'Legs', entries: [] } };
  const calls = store(pushARoutes({
    'POST /sessions/import': { status: 409, reply: { code: 'session-overlap', error: 'these times cross a session already in the log', sessionId: 'ses_phone', session: crossed } },
  }));
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-body').map(textOf), [
    'Legs · today · 11:50 – 12:40 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  ]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal-open').map((link) => link.props.href), ['#/gym/session/ses_phone']);
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 9 sets', true]);
  assert.deepEqual(said, []);
  findByClass(view.tree, 'gym-past-refusal-fix')[0].props.onClick();
  assert.deepEqual(findByClass(view.tree, 'gym-past-refusal'), []);
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
});

test('a press that did not land sends the same request again, ids and all, so the store answers it with the row it holds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  let answer = { status: 503, reply: { error: 'the log is not answering' } };
  const sent = [];
  store(pushARoutes({ 'POST /sessions/import': (body) => { sent.push(JSON.stringify(body)); return answer; } }));
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(said, ['That workout didn’t reach the log — the log didn’t answer. Try again when you have signal.']);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 9 sets');
  answer = { status: 200, reply: { session: {}, sets: [] } };
  saveButton(view.tree).props.onClick();
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0]);
});

// The store honouring its own contract: an exact replay answers the stored row, a different workout
// under a spent id is `session-id-taken`, and the first reply can be lost after the row landed.
function honestStore({ loseFirstReply = false } = {}) {
  const stored = new Map();
  const posts = [];
  let lost = loseFirstReply;
  const routes = pushARoutes({
    'POST /sessions/import': (body) => {
      posts.push(JSON.stringify(body));
      const prior = stored.get(body.id);
      if (prior) {
        if (JSON.stringify(prior) === JSON.stringify(body)) return { status: 200, reply: { session: prior, sets: [] } };
        return { status: 409, reply: { code: 'session-id-taken', error: 'that session id is taken' } };
      }
      stored.set(body.id, body);
      if (lost) {
        lost = false;
        return { status: 503, reply: { error: 'the reply was lost' } };
      }
      return { status: 201, reply: { session: body, sets: [] } };
    },
  });
  store(new Proxy(routes, {
    get: (table, key) => {
      const match = /^GET \/sessions\/(ses_[0-9a-f]+)$/.exec(key);
      if (!match) return table[key];
      const session = stored.get(match[1]);
      return session ? { reply: { session, sets: session.sets } } : { status: 404, reply: {} };
    },
  }));
  return { stored, posts };
}

test('a save whose reply was lost, pressed again unchanged, sends the same bytes and lands once', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const server = honestStore({ loseFirstReply: true });
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(said, ['That workout didn’t reach the log — the log didn’t answer. Try again when you have signal.']);
  t.mock.timers.tick(60_000);
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual([server.posts.length, server.posts[1] === server.posts[0], server.stored.size], [2, true, 1]);
  assert.equal(textOf(saveButton(view.tree)), 'Saved · 9 sets');
});

test('a save whose reply was lost, then a time moved and saved again, lands once and says the first save stood', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const server = honestStore({ loseFirstReply: true });
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text, options) => said.push([text, options?.action?.label ?? null]) }));
  saveButton(view.tree).props.onClick();
  await settle();
  findByClass(view.tree, 'gym-past-link')[0].props.onClick();
  elementsOf(view.tree).find((each) => each.props?.['aria-label'] === 'Start time').props.onChange({ target: { value: '14:00' } });
  saveButton(view.tree).props.onClick();
  await settle();
  assert.equal(server.stored.size, 1, 'one session, not two');
  const [first] = server.stored.values();
  assert.deepEqual([first.startedAt, first.finishedAt], [at(24, 12), at(24, 13)]);
  assert.deepEqual(findByClass(view.tree, 'gym-save-note').map(textOf), ['Today · 12:00–13:00'], 'the note reads what the store holds');
  assert.equal(textOf(saveButton(view.tree)), 'Saved · 9 sets');
  t.mock.timers.tick(900);
  assert.equal(window.location.hash, `#/gym/session/${first.id}?from=%23%2Fgym%2Flog`);
  assert.deepEqual(said.slice(1), [['Push A was already in the log — the changes made after that save were not written.', 'Undo']]);
});

test('a spent id the account does not hold is not a landing: the form says so and keeps the workout', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  const calls = store(pushARoutes({
    'POST /sessions/import': { status: 409, reply: { code: 'session-deleted', error: 'that workout was discarded' } },
  }));
  global.fetch = ((inner) => async (url, options) => (/\/sessions\/ses_[0-9a-f]+$/.test(url)
    ? { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }
    : inner(url, options)))(global.fetch);
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  saveButton(view.tree).props.onClick();
  await settle();
  assert.deepEqual(said, ['This workout was saved and then discarded, so this form can’t save it again. Open Add past workout to log it afresh.']);
  assert.equal(textOf(saveButton(view.tree)), 'Save · 9 sets');
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'no second send under a fresh id');
});

test('two sets removed inside one collapse each take the set they name', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  window.matchMedia = () => ({ matches: false });
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  store(pushARoutes({ 'POST /sessions/import': (body) => ({ status: 201, reply: { session: body, sets: [] } }) }));
  const said = [];
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(text) }));
  window.location.hash = '#/gym/backfill/rt_push';
  saveButton(view.tree).props.onClick();
  await settle();
  window.location.hash = '#/gym/notes';
  t.mock.timers.tick(900);
  assert.equal(window.location.hash, '#/gym/notes');
  assert.deepEqual(said, ['Push A is in the log.']);

  const second = await form(t, 'rt_push', roomLog({ catalog: CATALOG, say: (text) => said.push(`second: ${text}`) }));
  saveButton(second.tree).props.onClick();
  await settle();
  second.unmount();
  t.mock.timers.tick(900);
  assert.deepEqual(said, ['Push A is in the log.']);
});

test('one last time that did not answer leaves the form standing: that movement keeps its target', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  store(pushARoutes({ 'GET /last?exercise=overhead-press': { status: 503, reply: { error: 'busy' } } }));
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
  assert.deepEqual(movements(view.tree).map(({ props, tree }) => [props.name, textOf(findByClass(tree, 'gym-past-scheme')[0])]), [
    ['Bench Press', '3 × 8 · 60'], ['Overhead Press', '3 × 8 · 32.5'], ['Chin-up', '3 × 6–8'], ['Face Pull', 'open · no last time'],
  ]);
});

test('a day with no free slot opens the time row, focused, and the note asks for a start', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(24, 0, 10) });
  browserWith();
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  const routine = {
    id: 'rt_big', name: 'Big', position: 0,
    entries: Array.from({ length: 41 }, (_, at) => ({ exerciseId: 'bench-press', sets: Array.from({ length: 5 }, () => ({ reps: 5, weightKg: 20 })) })).map((entry, position) => ({ ...entry, position })),
  };
  store({ 'GET /routines/rt_big': { reply: routine }, 'GET /last?exercise=bench-press': { reply: lastOf('bench-press') } });
  const view = await form(t, 'rt_big', roomLog({ catalog: CATALOG }));
  assert.deepEqual([textOf(saveButton(view.tree)), saveButton(view.tree).props['aria-disabled']], ['Save · 205 sets', true]);
  assert.deepEqual(findByClass(view.tree, 'gym-past-limit').map(textOf), ['A workout holds up to 200 sets.']);
});
test('the routine’s ⋯ holds Log past above Delete, and it opens the filled form without the pick', async (t) => {
  browserWith();
  store({ 'GET /routines': { reply: { routines: [PUSH_A] } } });
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  const view = renderHook(t, () => RoutinesList({ log: roomLog(), onSignIn: () => {} }));
  await settle();
  view.redraw();
  const [menu] = named(view.tree, 'Menu');
  assert.deepEqual(menu.props.items.map((item) => item.label), ['Log past', 'Delete']);
  menu.props.items[0].run();
  assert.equal(window.location.hash, '#/gym/backfill/rt_push?from=routines');
});

test('a form opened from the routine’s ⋯ goes back to Routines; one opened from the pick goes back to it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  browserWith();
  store(pushARoutes());
  const { Backfill } = await loadScreen('products/gym/backfill/Backfill.jsx');
  const backOf = async (from) => {
    const screen = Backfill({ target: 'rt_push', from, log: roomLog({ catalog: CATALOG }) });
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
  store(pushARoutes());
  const view = await form(t, 'rt_push', roomLog({ catalog: CATALOG }));
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
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const running = { id: 'ses_live', startedAt: NOW };
  const view = renderHook(t, () => LogList({ log: roomLog({ session: running, summaries: [running] }), onSignIn: () => {} }));
  assert.deepEqual(findByClass(view.tree, 'gym-door-past').map((door) => [door.type, door.props.href, textOf(door)]), [
    ['a', '#/gym/backfill', 'Add past workout'],
    ['a', '#/gym/backfill', 'Add past workout'],
  ]);
});
