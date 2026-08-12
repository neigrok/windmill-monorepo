// The log's reading rules, pinned. Where the hash points and what each room is called, what a
// session is named when the plan arrives in either wire shape, and the first-performed order the
// detail view groups sets in — then §G16's four facts a row is scanned for and the week they are
// folded into, and §G17's reading of one session against the plan frozen at its start.
//
// Several of these have TWO SOURCES AND ONE RULE — the top set, the auto-close note, the tonnage,
// the working count — because a session in the LIST carries the store's own answer and a session
// read WHOLE carries its sets. Both sources are asserted here, side by side, for each of them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agoLabel, alsoReadsLabel, arrivedLabel, BACKFILL_HREF, clockOf, CLOSED_ITSELF_NOTE, closedOnItsOwn,
  dayLabel,
  durLabel, e1rmLabel, entryLabel, finishHref, finishIdOf, firstSessionLabel, fmt, fmtKg,
  groupByExercise,
  hasRecord, isFinished, isFirstSession, loadedLine, logWhenLabel, MOVEMENTS_HREF, movementIdOf,
  nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE, NOT_IN_PLAN, numberWord, onThisDevice, planFrozenLabel,
  planOf, planReadingOf, proposalHref, proposalIdOf,
  recordHref, routineHref, routineIdOf, routineMetaLabel, routineNameOf, ROUTINES_HREF, screenOf,
  sessionDetailMeta, sessionHref, sessionIdOf, sessionMetaLabel, setCountLabel, setLoadLabel,
  setNoteOf, sharedHref, sharedTokenOf, shortDayLabel, timeLabel, tonnageLabel, tonnageOf,
  topSetLabel, topSetOf, weekdayName, weeksOf, whenLabel, workingLabel, workingSetsOf,
} from '../../../src/products/gym/log.js';
import { KG, LB, spellWeightsIn } from '../../../src/products/gym/units.js';

test('sessionIdOf — a session hash yields its id, everything else yields nothing', () => {
  assert.equal(sessionIdOf('#/gym/session/ses_9f3a1c22'), 'ses_9f3a1c22');
  assert.equal(sessionIdOf('#/gym/session/ses_9f3a1c22/sets'), 'ses_9f3a1c22');
  assert.equal(sessionIdOf('#/gym'), null);
  assert.equal(sessionIdOf('#/gym/session/'), null);
  assert.equal(sessionIdOf('#/journal/2026-08-01'), null);
  assert.equal(sessionIdOf(''), null);
  assert.equal(sessionIdOf(undefined), null);
});

test('sessionHref — the link the log writes is the link the log reads back', () => {
  assert.equal(sessionHref('ses_9f3a1c22'), '#/gym/session/ses_9f3a1c22');
  assert.equal(sessionIdOf(sessionHref('ses_9f3a1c22')), 'ses_9f3a1c22');
});

test('routineNameOf — the plan reads the same whether it arrives parsed or as stored json', () => {
  assert.equal(routineNameOf({ plan: { routine: 'Upper A', entries: [] } }), 'Upper A');
  assert.equal(routineNameOf({ plan: '{"routine":"Upper A","entries":[]}' }), 'Upper A');
  assert.equal(routineNameOf({ plan: '{"entries":[]}' }), null);
  assert.equal(routineNameOf({ plan: { entries: [] } }), null);
  assert.equal(routineNameOf({ plan: 'not json at all' }), null);
  assert.equal(routineNameOf({ plan: '' }), null);
  assert.equal(routineNameOf({}), null);
});

test('routineNameOf — a routine the snapshot does not hold as a name is no routine', () => {
  assert.equal(routineNameOf({ plan: { routine: { name: 'Upper A' } } }), null);
  assert.equal(routineNameOf({ plan: { routine: ['Upper A'] } }), null);
  assert.equal(routineNameOf({ plan: { routine: 7 } }), null);
  assert.equal(routineNameOf({ plan: { routine: null } }), null);
  assert.equal(routineNameOf({ plan: { routine: '' } }), null);
});

test('nameOfMovement — the catalog names a movement, and its id stands in until the catalog answers', () => {
  const catalog = [{ id: 'back-squat', name: 'Back Squat' }, { id: 'face-pull', name: 'Face Pull' }];
  assert.equal(nameOfMovement(catalog, 'face-pull'), 'Face Pull');
  assert.equal(nameOfMovement(catalog, 'deadlift'), 'deadlift');
  assert.equal(nameOfMovement([], 'back-squat'), 'back-squat');
  assert.equal(nameOfMovement(null, 'back-squat'), 'back-squat');
  assert.equal(nameOfMovement(undefined, 'back-squat'), 'back-squat');
});

test('groupByExercise — first-performed order across exercises, server numbering within one', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const sets = [
    set('set_4', 'bench-press', 2, 1_900_000_400_000),
    set('set_1', 'back-squat', 1, 1_900_000_100_000),
    set('set_3', 'bench-press', 1, 1_900_000_300_000),
    set('set_2', 'back-squat', 2, 1_900_000_200_000),
  ];
  assert.deepEqual(groupByExercise(sets), [
    ['back-squat', [sets[1], sets[3]]],
    ['bench-press', [sets[2], sets[0]]],
  ]);
  assert.deepEqual(sets.map((each) => each.id), ['set_4', 'set_1', 'set_3', 'set_2']);
  assert.deepEqual(groupByExercise([]), []);
});

test('groupByExercise — a movement returned to later keeps its first-performed place', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const squat1 = set('set_1', 'back-squat', 1, 1_900_000_100_000);
  const bench = set('set_2', 'bench-press', 1, 1_900_000_200_000);
  const squat2 = set('set_3', 'back-squat', 2, 1_900_000_300_000);
  assert.deepEqual(groupByExercise([squat1, bench, squat2]), [
    ['back-squat', [squat1, squat2]],
    ['bench-press', [bench]],
  ]);
});

test('groupByExercise — a set the server has not numbered yet sorts last, then by completion', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const first = set('set_1', 'back-squat', 1, 1_900_000_100_000);
  const second = set('set_2', 'back-squat', 2, 1_900_000_200_000);
  const flushing = set('set_3', 'back-squat', undefined, 1_900_000_300_000);
  const alsoFlushing = set('set_4', 'back-squat', undefined, 1_900_000_250_000);
  assert.deepEqual(groupByExercise([flushing, second, alsoFlushing, first]), [
    ['back-squat', [first, second, alsoFlushing, flushing]],
  ]);
});

test('isFinished — an end instant of zero is still an end, absence is not', () => {
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: 1_900_003_600_000 }), true);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: 0 }), true);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: null }), false);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000 }), false);
});

test('durLabel and setCountLabel — the two numbers the log row says out loud', () => {
  assert.equal(durLabel(30 * 60_000), '30m');
  assert.equal(durLabel(59 * 60_000), '59m');
  assert.equal(durLabel(62 * 60_000), '1h 02m');
  assert.equal(durLabel(95 * 60_000), '1h 35m');
  assert.equal(durLabel(120 * 60_000), '2h 00m');
  assert.equal(durLabel(0), '1m');
  assert.equal(setCountLabel(0), '0 sets');
  assert.equal(setCountLabel(1), '1 set');
  assert.equal(setCountLabel(12), '12 sets');
});

// The day is the title above this line, so the meta never repeats it: when it ran, how long it
// took, how much is in it. An open session is not given an end time it does not have.
test('sessionMetaLabel — a session read whole, without printing its day twice', () => {
  const started = new Date(2025, 6, 22, 18, 12).getTime();
  const finished = new Date(2025, 6, 22, 19, 34).getTime();
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: finished }, 13),
    '18:12–19:34   ·   1h 22m   ·   13 sets',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: started + 600_000 }, 1),
    '18:12–18:22   ·   10m   ·   1 set',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: null }, 4),
    '18:12   ·   in progress   ·   4 sets',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: finished }, 0),
    '18:12–19:34   ·   1h 22m   ·   0 sets',
  );
});

test('screenOf — one grammar decides which of the ten rooms a hash names', () => {
  assert.equal(screenOf('#/gym'), 'today');
  assert.equal(screenOf('#/gym/'), 'today');
  assert.equal(screenOf('#/gym/log'), 'log');
  assert.equal(screenOf('#/gym/log?page=2'), 'log');
  assert.equal(screenOf('#/gym/session/ses_9f3a1c22'), 'session');
  assert.equal(screenOf('#/gym/finish/ses_9f3a1c22'), 'finish');
  assert.equal(screenOf('#/gym/backfill'), 'backfill');
  assert.equal(screenOf('#/gym/routines'), 'routines');
  assert.equal(screenOf('#/gym/routines/'), 'routines');
  assert.equal(screenOf('#/gym/routines?new=1'), 'routines');
  assert.equal(screenOf('#/gym/routines/rt_9f2c'), 'routine');
  assert.equal(screenOf('#/gym/proposals/prop_2f9c40a1'), 'proposal');
  assert.equal(screenOf(routineHref(NEW_ROUTINE_ID)), 'routine');
  assert.equal(screenOf(MOVEMENTS_HREF), 'record');
  assert.equal(screenOf(recordHref('back-squat')), 'record');
  // THE RETIRED TAB'S URL RESOLVES HERE, and this is the assertion that used to say '#/gym/stats'
  // was the statistics room. §H retires that room — there is no dashboard in this product — and
  // what replaces it is one movement's page, so a bookmark somebody kept lands one tap from the
  // number they opened it for rather than on Today with no explanation.
  assert.equal(screenOf('#/gym/stats'), 'record');
  assert.equal(screenOf('#/gym/stats?movement=bench-press'), 'record');
  assert.equal(screenOf(''), 'today');
  // A hash this build does not know is a link from a build that did, and Today is where a lifter
  // can get anywhere from — never a blank screen with a working URL in the bar.
  assert.equal(screenOf('#/gym/strength-tree'), 'today');
});

// THE ONE ROOM THAT IS NOT THE LIFTER'S. It has to be recognised before anything that could send a
// visitor at the sign-in door, because the token IS the credential and a coach has no account —
// GymApp answers this branch above the auth switch entirely, and this is the parse under it.
test('sharedTokenOf — the coach’s link carries a whole base64url token, and only that shape', () => {
  const token = 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0';
  assert.equal(screenOf(sharedHref(token)), 'shared');
  assert.equal(sharedTokenOf(sharedHref(token)), token);
  assert.equal(sharedHref(token), `#/gym/shared/${token}`);
  // The mint's alphabet, whole: 32 bytes of entropy, base64url, unpadded — so '-' and '_' are
  // ordinary characters in it and a parse that stopped at either would truncate the credential.
  assert.equal(sharedTokenOf('#/gym/shared/a-b_c'), 'a-b_c');
  assert.equal(sharedTokenOf('#/gym/shared/'), null);
  assert.equal(sharedTokenOf('#/gym/session/ses_9f3a1c22'), null);
  assert.equal(sharedTokenOf('#/gym'), null);
  assert.equal(sharedTokenOf(''), null);
  assert.equal(sharedTokenOf(undefined), null);
});

test('routineIdOf — the editor link the routines list writes is the link it reads back', () => {
  assert.equal(routineIdOf('#/gym/routines/rt_9f2c1a04'), 'rt_9f2c1a04');
  assert.equal(routineHref('rt_9f2c1a04'), '#/gym/routines/rt_9f2c1a04');
  assert.equal(routineIdOf(routineHref('rt_9f2c1a04')), 'rt_9f2c1a04');
  assert.equal(routineIdOf(ROUTINES_HREF), null);
  assert.equal(routineIdOf('#/gym/routines/'), null);
  assert.equal(routineIdOf('#/gym/session/ses_9f3a1c22'), null);
  assert.equal(routineIdOf(''), null);
  assert.equal(routineIdOf(undefined), null);
});

test('finishIdOf — the end of a session is a place, so a reload lands back on it', () => {
  assert.equal(finishIdOf('#/gym/finish/ses_9f3a1c22'), 'ses_9f3a1c22');
  assert.equal(finishHref('ses_9f3a1c22'), '#/gym/finish/ses_9f3a1c22');
  assert.equal(finishIdOf(finishHref('ses_9f3a1c22')), 'ses_9f3a1c22');
  assert.equal(finishIdOf(sessionHref('ses_9f3a1c22')), null);
  assert.equal(finishIdOf(BACKFILL_HREF), null);
  assert.equal(finishIdOf('#/gym/finish/'), null);
  assert.equal(finishIdOf(''), null);
  assert.equal(finishIdOf(undefined), null);
});

// A MOVEMENT'S RECORD IS A PLACE (§H), which is what makes its name a link wherever the name is
// drawn — a session's exercise header, a routine's row, the picker. The id in the URL is the
// catalog's own, and both shapes it comes in have to survive the parse: a slug for a movement that
// ships with the account, 'ex_<hex>' for one a lifter minted. A hyphen is an ordinary character in
// the first, so a parse that stopped at one would open the record of a movement called 'back'.
test('movementIdOf — the record link a name writes is the link the record reads back', () => {
  assert.equal(recordHref('back-squat'), '#/gym/movement/back-squat');
  assert.equal(movementIdOf(recordHref('back-squat')), 'back-squat');
  assert.equal(movementIdOf(recordHref('ex_31ab77c0')), 'ex_31ab77c0');
  // No movement named is the picker asking which one, and it is where the retired statistics URL
  // lands — so this is a hash that resolves without an id rather than one that fails to parse.
  assert.equal(MOVEMENTS_HREF, '#/gym/movement');
  assert.equal(movementIdOf(MOVEMENTS_HREF), null);
  assert.equal(movementIdOf('#/gym/movement/'), null);
  assert.equal(movementIdOf('#/gym/stats'), null);
  assert.equal(movementIdOf(sessionHref('ses_9f3a1c22')), null);
  assert.equal(movementIdOf(''), null);
  assert.equal(movementIdOf(undefined), null);
});

// ONE PROPOSAL, AS A PLACE (§D14). The id is minted by whoever WROTE the proposal — an agent over
// MCP — and the deep link in its receipt is this URL, so the parse takes the whole of the id shape
// the wire allows (`^[A-Za-z0-9_-]{8,64}$`) rather than the narrower one gym's own mints happen to
// produce. A parse that stopped at an underscore or a hyphen would open somebody's proposal by a
// prefix of its id, or fail to open it at all.
test('proposalIdOf — the deep link an agent’s receipt hands out is the link this app reads back', () => {
  assert.equal(proposalHref('prop_2f9c40a1'), '#/gym/proposals/prop_2f9c40a1');
  assert.equal(proposalIdOf(proposalHref('prop_2f9c40a1')), 'prop_2f9c40a1');
  assert.equal(proposalIdOf('#/gym/proposals/a-b_c9'), 'a-b_c9');
  assert.equal(screenOf(proposalHref('prop_2f9c40a1')), 'proposal');
  // The routines list is one word away and must never answer for a proposal, or the other way round.
  assert.equal(proposalIdOf(ROUTINES_HREF), null);
  assert.equal(proposalIdOf(routineHref('rt_9f2c1a04')), null);
  assert.equal(routineIdOf(proposalHref('prop_2f9c40a1')), null);
  assert.equal(proposalIdOf('#/gym/proposals'), null);
  assert.equal(proposalIdOf('#/gym/proposals/'), null);
  assert.equal(proposalIdOf(''), null);
  assert.equal(proposalIdOf(undefined), null);
});

// The one id a mint can never produce, so the blank editor survives a reload without asking the
// store for a routine nobody has saved.
test('NEW_ROUTINE_ID — a routine being written for the first time stands at the editor URL', () => {
  assert.equal(routineIdOf(routineHref(NEW_ROUTINE_ID)), NEW_ROUTINE_ID);
  assert.notEqual(NEW_ROUTINE_ID.slice(0, 3), 'rt_');
});

// The target reads the same in the editor, on Today's card and on the finish screen's offer. A
// weight it does not ask for is "whatever you did last time" and prints nothing — and neither does
// a load of zero, which is the absence of one rather than a number.
// A REP target it does not ask for is canon screen 6's `3 × max`, a movement taken to whatever it
// gives that day — spelled by omission on the wire, exactly like the load.
test('entryLabel — what a routine asks a movement for, and the two targets it may decline to set', () => {
  assert.equal(entryLabel({ exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }), '5 × 5 · 82.5');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8, targetWeightKg: 0 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'pull-up', targetSets: 4, targetReps: 6, targetWeightKg: -20 }), '4 × 6 · −20');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3 }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: null }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'dip', targetSets: 3, targetWeightKg: 20 }), '3 × max · 20');
});

// "Your first session" is a claim about the LIST, and one other finished session refutes it.
test('isFirstSession — the session being asked about never counts as its own predecessor', () => {
  const session = (id, finishedAt) => ({ id, startedAt: 1, finishedAt });
  assert.equal(isFirstSession([session('ses_1', 2)], 'ses_1'), true);
  assert.equal(isFirstSession([], 'ses_1'), true);
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_0', 2)], 'ses_1'), false);
  // An open session is not a session that happened yet — a backfill door left ajar must not make
  // the first workout somebody ever logged read as their second.
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_2', null)], 'ses_1'), true);
});

test('weekdayName — the day a session happened, as the opening value in the name field', () => {
  assert.equal(weekdayName(new Date(2026, 7, 4, 18, 12).getTime()), 'Tuesday');
  assert.equal(weekdayName(new Date(2026, 7, 9, 7, 40).getTime()), 'Sunday');
});

// The row says the same fact the list is sorted by, so it never has to explain its own order.
test('routineMetaLabel — what a routine holds, and when it was last used', () => {
  const now = new Date(2026, 7, 4, 9, 41).getTime();
  const entries = (count) => Array.from({ length: count }, (each, index) => ({ position: index + 1 }));
  assert.equal(
    routineMetaLabel({ entries: entries(6), lastTrainedAt: now - 5 * 86_400_000 }, now),
    '6 exercises · trained 5 days ago',
  );
  assert.equal(
    routineMetaLabel({ entries: entries(1), lastTrainedAt: now - 86_400_000 }, now),
    '1 exercise · trained yesterday',
  );
  assert.equal(routineMetaLabel({ entries: entries(4), lastTrainedAt: now }, now), '4 exercises · trained today');
  assert.equal(routineMetaLabel({ entries: entries(5) }, now), '5 exercises · never trained');
  assert.equal(routineMetaLabel({ entries: [] }, now), '0 exercises · never trained');
});

// ONE WORD FOR WHAT COUNTS, and every surface that counts anything reads it: the plan counter, the
// carry-forward, the top set and the routine composed from a session. A drop and a failure count
// toward nothing, exactly as the domain's record rules read them — the logger's own counter filtered
// only warmups, so a drop advanced "set 4 of 5" while counting toward no record anywhere else.
test('workingSetsOf — only a working set counts, and the other three kinds count toward nothing', () => {
  const set = (exerciseId, weightKg, reps, kind) => ({ exerciseId, weightKg, reps, kind, completedAt: 0 });
  const sets = [
    set('back-squat', 60, 5, 'warmup'),
    set('back-squat', 100, 5, 'working'),
    set('back-squat', 90, 3, 'drop'),
    set('back-squat', 100, 1, 'failure'),
    set('bench-press', 80, 5, 'working'),
  ];
  assert.deepEqual(workingSetsOf(sets), [sets[1], sets[4]]);
  assert.deepEqual(workingSetsOf(sets, 'back-squat'), [sets[1]]);
  assert.deepEqual(workingSetsOf(sets, 'bench-press'), [sets[4]]);
  assert.deepEqual(workingSetsOf(sets, 'deadlift'), []);
  assert.deepEqual(workingSetsOf([sets[0], sets[2], sets[3]]), []);
});

// Never volume: four light sets must not beat three heavy ones, here or anywhere else in gym.
test('topSetOf — the heaviest working set, from the sets or from the summary that carries it', () => {
  const set = (weightKg, reps, kind) => ({ exerciseId: 'back-squat', weightKg, reps, kind, completedAt: 0 });
  const label = (sets) => topSetLabel(topSetOf({ id: 'ses_1' }, sets));
  assert.equal(label([set(100, 5, 'working'), set(102.5, 5, 'working'), set(100, 8, 'working')]), '102.5 × 5');
  assert.equal(label([set(60, 5, 'warmup'), set(120, 1, 'warmup'), set(100, 5, 'working')]), '100 × 5');
  assert.equal(label([set(100, 5, 'working'), set(140, 3, 'drop'), set(140, 1, 'failure')]), '100 × 5');
  // A tie on the load goes to the set that got more reps out of it.
  assert.equal(label([set(100, 5, 'working'), set(100, 8, 'working')]), '100 × 8');
  assert.equal(label([set(0, 12, 'working'), set(-20, 8, 'working')]), '0 × 12');
  assert.equal(label([set(60, 10, 'warmup')]), '—');
  assert.equal(label([]), '—');

  // A row in the LIST carries no sets, so the store hands it the same pick under `topSet` — the
  // column G8 draws had nothing behind it until the summary carried one, and a top set derived
  // from a set COUNT would have been a number nobody lifted.
  const row = { id: 'ses_1', setCount: 14, topSet: { weightKg: 102.5, reps: 5 } };
  assert.deepEqual(topSetOf(row), { weightKg: 102.5, reps: 5 });
  assert.equal(topSetLabel(topSetOf(row)), '102.5 × 5');
  // A session holding no working set has no top set at all — omitted on the wire, and nothing here.
  assert.equal(topSetOf({ id: 'ses_1', setCount: 2 }), null);
  assert.equal(topSetLabel(topSetOf({ id: 'ses_1', setCount: 2 })), '—');
  assert.equal(topSetLabel(null), '—');
});

// The wire carries no flag for the four-hour close, so the fingerprint is the end instant itself.
test('closedOnItsOwn — an end nobody pressed is one stamped at the last thing that happened', () => {
  const startedAt = 1_900_000_000_000;
  const sets = [
    { id: 'set_1', weightKg: 100, reps: 5, completedAt: startedAt + 600_000 },
    { id: 'set_2', weightKg: 100, reps: 5, completedAt: startedAt + 900_000 },
  ];
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }, sets), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_001 }, sets), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 3_600_000 }, sets), false);
  // A session that never got a set ended when it began.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt }, []), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000 }, []), false);
  // Still running is not closed at all, whoever would have closed it.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: null }, sets), false);
  assert.equal(CLOSED_ITSELF_NOTE, 'closed on its own — no set for four hours');

  // A row in the LIST carries no sets either, so the store answers the same question under
  // `closedItself` — the note G8 draws on the row had nothing behind it until it did.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000, closedItself: true }), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000, closedItself: false }), false);
  // With neither the flag nor the sets there is nothing to read it off, and silence is the answer.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }), false);
});

// THE SESSION CLOCK IS DERIVED. It is a function of (now − startedAt) and of nothing else, which is
// why the number below survives a locked phone: a counter would have stopped with the beats.
test('clockOf — the clock is computed from the start instant, never accumulated', () => {
  const startedAt = 1_900_000_000_000;
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(9_000), '0:09');
  assert.equal(clockOf(24 * 60_000 + 18_000), '24:18');
  assert.equal(clockOf(60 * 60_000), '1:00:00');
  assert.equal(clockOf(3_600_000 + 2 * 60_000 + 7_000), '1:02:07');
  assert.equal(clockOf(-5_000), '0:00');

  // Three beats, then the phone locks for an hour. A counter shows what it managed to add up;
  // the log shows what actually elapsed.
  let counted = 0;
  for (let beat = 0; beat < 3; beat += 1) counted += 500;
  const wokeAt = startedAt + 3_600_000 + 1_500;
  assert.equal(clockOf(counted), '0:01');
  assert.equal(clockOf(wokeAt - startedAt), '1:00:01');
});

test('fmt — trailing zeros stripped, a real minus, and a negative load is an ordinary number', () => {
  assert.equal(fmt(102.5), '102.5');
  assert.equal(fmt(100), '100');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(-20), '−20');
  assert.equal(fmt(-2.25), '−2.25');
  assert.equal(fmt(102.505), '102.51');
  assert.equal(fmt(-20).charCodeAt(0), 0x2212);
});

// UNITS HAPPEN INSIDE fmt AND NOWHERE ELSE (units.js), which is what makes one account reading in
// pounds a one-line change rather than twenty. Everything else on this surface — a set's line, a
// week's tonnage, a record's sentence — comes through it, so all of them move together and none of
// them can be forgotten.
test('fmt spells the account’s unit, and fmtKg spells the one the store holds', (t) => {
  t.after(() => spellWeightsIn(KG));
  spellWeightsIn(LB);

  assert.equal(fmt(102.5), '226');
  assert.equal(fmt(100), '220.5');
  assert.equal(fmt(-20), '−44.1');
  assert.equal(fmt(0), '0');
  // The field seams — a backfill line, a correction, a routine target, the keypad's own message —
  // are typed into and land in the log as they stand, so they say the kilogram whatever the account
  // reads in, and each of them prints `kg` beside it.
  assert.equal(fmtKg(102.5), '102.5');
  assert.equal(fmtKg(-20), '−20');
  assert.equal(fmtKg(1.25), '1.25');

  // The labels built on fmt follow it without being told.
  assert.equal(setLoadLabel({ weightKg: 102.5, reps: 5 }), '226 × 5');
  assert.equal(topSetLabel({ weightKg: 100, reps: 3 }), '220.5 × 3');
  assert.equal(entryLabel({ targetSets: 5, targetReps: 5, targetWeightKg: 102.5 }), '5 × 5 · 226');
});

// AND WHERE THE TWO SPELLINGS MEET ON ONE SCREEN, THE PRODUCT SAYS SO. A kilogram field over its
// own converted reading — the target sheet on the routine's rows, the correction sheet on the
// session's — is two numerals for one weight, and a lifter has no way to know they are one. In
// kilograms there is nothing to reconcile and the line is not drawn at all.
test('a kilogram field over a pounds reading says what the other numeral is', (t) => {
  t.after(() => spellWeightsIn(KG));

  assert.equal(alsoReadsLabel(100), null);
  assert.equal(alsoReadsLabel(null), null);

  spellWeightsIn(LB);
  assert.equal(alsoReadsLabel(100), 'reads 220.5 lb in your log');
  assert.equal(alsoReadsLabel(102.5), 'reads 226 lb in your log');
  assert.equal(alsoReadsLabel(-20), 'reads −44.1 lb in your log');
  // A target a routine declines to set is not a weight, so there is nothing to read it as.
  assert.equal(alsoReadsLabel(null), null);
  assert.equal(alsoReadsLabel(undefined), null);
});

// A TONNE IS THE SCALE WORD A METRIC READER HAS and a pound reader has none, so the same physical
// threshold prints thousands of pounds rather than a unit they never use. The threshold is the MASS
// and not the numeral, so both readings change scale on the same week.
test('the scale of a week follows the reading, and switches at the same mass either way', (t) => {
  t.after(() => spellWeightsIn(KG));
  spellWeightsIn(LB);

  assert.equal(tonnageLabel(999), '2202.4 lb');
  assert.equal(tonnageLabel(1000), '2.2k lb');
  assert.equal(tonnageLabel(14_200), '31.3k lb');
  assert.equal(tonnageLabel(0), null);
  assert.equal(tonnageLabel(null), null);
});

test('dayLabel, timeLabel and agoLabel — the labels a lifter judges relevance by', () => {
  const wednesday = new Date(2026, 6, 22, 18, 12).getTime();
  assert.equal(dayLabel(wednesday), 'Wed 22 Jul');
  assert.equal(dayLabel(new Date(2026, 0, 4, 9, 5).getTime()), 'Sun 4 Jan');
  assert.equal(timeLabel(wednesday), '18:12');
  assert.equal(timeLabel(new Date(2026, 6, 22, 9, 5).getTime()), '09:05');
  assert.equal(agoLabel(wednesday, wednesday), 'today');
  assert.equal(agoLabel(wednesday, wednesday + 86_400_000), 'yesterday');
  assert.equal(agoLabel(wednesday, wednesday + 4 * 86_400_000), '4 days ago');
  assert.equal(agoLabel(wednesday, wednesday - 86_400_000), 'today');
});

// WHEN A PROPOSAL ARRIVED — canon §D14's `Sun 21:14`, which is the weekday and the hour because a
// lifter reading a diff on Monday morning remembers the Sunday evening they asked for it. The
// weekday alone repeats every seven days, so past a week it takes the full date instead: a card
// that waited a fortnight saying `Sun` would let the reader supply the wrong Sunday, which is the
// one thing a timestamp exists to stop.
test('arrivedLabel — the weekday and the hour, until a weekday stops naming one day', () => {
  const sunday = new Date(2026, 7, 2, 21, 14).getTime();
  assert.equal(arrivedLabel(sunday, sunday), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 10 * 60 * 60 * 1000), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 5 * 86_400_000), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 6 * 86_400_000), 'Sun 2 Aug · 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 30 * 86_400_000), 'Sun 2 Aug · 21:14');
  assert.equal(whenLabel(sunday), 'Sun 2 Aug · 21:14');
});

// ONE TABLE OF SMALL NUMBERS FOR THE PRODUCT — "two short" under a set and "All four or none" under
// a proposal read the same table, because two of them would disagree the first day either grew.
// Past ten the word stops being one a lifter would say and the numeral is what is left.
test('numberWord — a small count spelled, and a large one left as a numeral', () => {
  assert.equal(numberWord(1), 'one');
  assert.equal(numberWord(4), 'four');
  assert.equal(numberWord(10), 'ten');
  assert.equal(numberWord(11), '11');
  assert.equal(numberWord(0), 'zero');
});

// ONE VOCABULARY, TWO LENGTHS, AND EVERY DATE IN IT IS LOCAL. There used to be a UTC spelling here
// as well, for the one instant on the statistics surface nobody trained in — the start of a
// `date_trunc('week', … AT TIME ZONE 'UTC')` bucket, a Monday midnight that reads as Sunday evening
// west of Greenwich. That surface is retired with §H's record page, so the UTC reading has no
// producer left and went with it; what the record page needs instead is the SHORT one, because a
// column of twelve weekday prefixes is noise where a column of twelve dates is a chart's axis.
test('shortDayLabel — a day named by its date alone, in the zone the session happened in', () => {
  const wednesday = new Date(2026, 6, 22, 18, 12).getTime();
  assert.equal(shortDayLabel(wednesday), '22 Jul');
  assert.equal(dayLabel(wednesday), 'Wed 22 Jul');
  assert.equal(shortDayLabel(new Date(2026, 0, 1, 0, 0).getTime()), '1 Jan');
  assert.equal(shortDayLabel(new Date(2026, 11, 31, 23, 59).getTime()), '31 Dec');
});

// "Yesterday" is a claim about the CALENDAR. Rounding elapsed hours told a lifter who trained at
// 07:00 that they had trained yesterday by 21:00 the same day — and the routines row prints no date
// beside it for anybody to correct against.
test('agoLabel — the day is counted from midnight, not from a rounded number of hours', () => {
  const morning = new Date(2026, 6, 22, 7, 0).getTime();
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 21, 0).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 23, 59).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 23, 0, 1).getTime()), 'yesterday');
  // And the other way: eleven hours can already be yesterday, when a midnight sits between them.
  const lateNight = new Date(2026, 6, 22, 23, 0).getTime();
  assert.equal(agoLabel(lateNight, new Date(2026, 6, 23, 10, 0).getTime()), 'yesterday');
  assert.equal(agoLabel(new Date(2026, 6, 18, 23, 0).getTime(), new Date(2026, 6, 22, 6, 0).getTime()), '4 days ago');
});

// One phrase for a session nobody planned, wherever it is named: the row, the detail, the review
// subtitle, the overlap panel and the mirror's head. It is the design board's own (§G16's row, the
// between-sets header, the first session), which is why "Ad-hoc" and then the bare "No routine"
// were each retired for the same session.
test('NO_ROUTINE — the one phrase for a session with no routine', () => {
  assert.equal(NO_ROUTINE, 'Session · no routine');
});

test('planOf — the frozen snapshot, parsed once for every surface that reads it', () => {
  const plan = { routine: 'Squat day', entries: [{ exerciseId: 'back-squat', sets: 5, reps: 5, weightKg: 102.5 }] };
  assert.deepEqual(planOf({ plan }), plan);
  assert.deepEqual(planOf({ plan: JSON.stringify(plan) }), plan);
  assert.equal(planOf({ plan: 'not json at all' }), null);
  assert.equal(planOf({ plan: null }), null);
  assert.equal(planOf({}), null);
  assert.equal(planOf(null), null);
});

// ── §G16 · the log ────────────────────────────────────────────────────────────────────────────

// The bottom of the log is a date rather than an empty box, and it is the one place in gym a year
// is printed: everywhere else is a day inside the last few months, where a year is noise.
test('firstSessionLabel — the bottom of the log is the day it started', () => {
  assert.equal(firstSessionLabel(new Date(2026, 4, 6, 7, 30).getTime()), 'first session · 6 May 2026');
  assert.equal(firstSessionLabel(new Date(2024, 11, 31, 23, 59).getTime()), 'first session · 31 Dec 2024');
  assert.equal(firstSessionLabel(new Date(2025, 0, 1, 0, 0).getTime()), 'first session · 1 Jan 2025');
});

// A session from today is named by its clock — the day is the one thing every row would otherwise
// share — and every older one by its day. A session nobody has ended says so, because the numbers
// beside it are what has been logged so far and not what the session will hold.
test('logWhenLabel — today is a time, everything older is a day, and an open session says so', () => {
  const now = new Date(2026, 7, 10, 20, 15).getTime();
  const today = new Date(2026, 7, 10, 18, 44).getTime();
  const friday = new Date(2026, 7, 7, 9, 5).getTime();
  assert.equal(logWhenLabel({ startedAt: today, finishedAt: today + 3_600_000 }, now), 'today · 18:44');
  assert.equal(logWhenLabel({ startedAt: friday, finishedAt: friday + 3_600_000 }, now), 'Fri 7 Aug');
  assert.equal(logWhenLabel({ startedAt: today, finishedAt: null }, now), 'today · 18:44 · in progress');
  assert.equal(logWhenLabel({ startedAt: friday, finishedAt: null }, now), 'Fri 7 Aug · in progress');
  // Midnight decides the day, not elapsed hours — the same rule agoLabel is written to.
  assert.equal(
    logWhenLabel({ startedAt: today, finishedAt: today + 60_000 }, new Date(2026, 7, 11, 0, 30).getTime()),
    'Mon 10 Aug',
  );
});

// The count is of WORKING sets, and the estimate is the domain's — the web computes no e1RM, so an
// absent one draws nothing rather than a dash a lifter could mistake for a reading.
test('workingLabel and e1rmLabel — the two facts the wire hands a row', () => {
  assert.equal(workingLabel(11), '11 working');
  assert.equal(workingLabel(1), '1 working');
  assert.equal(workingLabel(0), '0 working');
  assert.equal(e1rmLabel(122.5), 'e1RM 122.5');
  assert.equal(e1rmLabel(84), 'e1RM 84');
  assert.equal(e1rmLabel(null), null);
  assert.equal(e1rmLabel(undefined), null);
});

// TWO SOURCES, ONE RULE, exactly as the top set has: the list carries the store's own aggregation
// and a session read whole carries its sets. An assisted set contributes zero — a band took load
// OFF the bar — and so does bodyweight, and only working sets count at all.
test('tonnageOf — the store’s sum on a row, the same sum from the sets on a session', () => {
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 5400 }), 5400);
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 0 }), 0);
  assert.equal(tonnageOf({ id: 'ses_1' }), null);
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', 100, 5), set('working', 80, 10)]), 1300);
  // The warmup is not in it, and neither is the failure or the drop set beside it.
  assert.equal(
    tonnageOf({ id: 'ses_1' }, [set('warmup', 40, 8), set('working', 100, 5), set('drop', 60, 8), set('failure', 100, 1)]),
    500,
  );
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', -20, 9), set('working', 0, 12)]), 0);
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', -20, 9), set('working', 60, 5)]), 300);
  assert.equal(tonnageOf({ id: 'ses_1' }, []), 0);
  // The wire wins where it spoke: the summary carries no sets to be re-read from.
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 5400 }, [set('working', 100, 5)]), 5400);
});

// A chin-up-and-dips week did not move zero kilograms — we simply have nothing true to say about
// its scale, and absence beats a false zero. Under a TONNE the figure is spelled in kilograms,
// because one decimal of a tonne cannot hold a small number: `0.1 t` for 51 kg is not a rounding,
// it is double, and a divider doubling a beginner's week is the same false number a zero would be.
test('tonnageLabel — a zero says nothing at all, and no figure is ever spelled at a scale that doubles it', () => {
  assert.equal(tonnageLabel(14_200), '14.2 t');
  assert.equal(tonnageLabel(5400), '5.4 t');
  assert.equal(tonnageLabel(1200), '1.2 t');
  assert.equal(tonnageLabel(18_949), '18.9 t');
  // The threshold is the tonne itself, so there is one of them to know and it is where the decimal
  // starts being worth a hundred kilograms.
  assert.equal(tonnageLabel(1000), '1.0 t');
  assert.equal(tonnageLabel(999), '999 kg');
  assert.equal(tonnageLabel(825), '825 kg');
  assert.equal(tonnageLabel(51), '51 kg');
  assert.equal(tonnageLabel(50), '50 kg');
  assert.equal(tonnageLabel(49.5), '49.5 kg');
  assert.equal(tonnageLabel(12), '12 kg');
  assert.equal(tonnageLabel(0), null);
  assert.equal(tonnageLabel(null), null);
  assert.equal(tonnageLabel(undefined), null);
});

// The head of the log counts what is IN HAND: the log carries no total, so "loaded" is not
// decoration on the sentence — it is what makes it true while there is more.
test('loadedLine — the head says how much of the log is on the screen', () => {
  assert.equal(loadedLine(41, 12), '41 sessions · 12 weeks loaded');
  assert.equal(loadedLine(1, 1), '1 session · 1 week loaded');
  assert.equal(loadedLine(2, 1), '2 sessions · 1 week loaded');
});

// The ring is the phones' state and the web's impossibility: nothing this surface reads can be in
// it, so the row can say it and never invents one.
test('onThisDevice — only a session that says so is saved on this device only', () => {
  assert.equal(onThisDevice({ id: 'ses_1', onThisDevice: true }), true);
  assert.equal(onThisDevice({ id: 'ses_1', onThisDevice: false }), false);
  assert.equal(onThisDevice({ id: 'ses_1' }), false);
  assert.equal(onThisDevice(null), false);
});

// THE GOLD DOT IS THE STORE'S ANSWER, and it is always sent — so a row that does not carry the word
// wears nothing rather than claiming the session earned nothing, which is the difference between a
// dot this surface never draws wrongly and a dot it guesses at. The field is `false` on ~190 rows
// in 200 and that false is a real answer, not an omission.
test('hasRecord — only a session the store says holds a record wears the dot', () => {
  assert.equal(hasRecord({ id: 'ses_1', record: true }), true);
  assert.equal(hasRecord({ id: 'ses_1', record: false }), false);
  assert.equal(hasRecord({ id: 'ses_1' }), false);
  assert.equal(hasRecord(null), false);
});

// WEEKS ARE A FOLD OVER THE PAGE IN HAND. They start Monday, in the lifter's own zone, and the
// OLDEST loaded one keeps its tonnage to itself: `Load older` can still add sessions to it, so its
// sum is a floor rather than a fact. Once the log has reached its end nothing more can land in it.
test('weeksOf — Monday to Monday, newest first, and the oldest week withholds its tonnage', () => {
  const row = (id, at, tonnageKg) => ({ id, startedAt: at.getTime(), tonnageKg });
  const summaries = [
    row('ses_5', new Date(2026, 7, 10, 18, 44), 5400),
    row('ses_4', new Date(2026, 7, 7, 9, 5), 6100),
    row('ses_3', new Date(2026, 7, 5, 18, 0), 9800),
    row('ses_2', new Date(2026, 7, 3, 7, 30), 1200),
    row('ses_1', new Date(2026, 7, 1, 11, 0), 5000),
  ];
  const weeks = weeksOf(summaries);
  assert.deepEqual(weeks.map((week) => week.label), ['week of 10 aug', 'week of 3 aug', 'week of 27 jul']);
  assert.deepEqual(weeks.map((week) => week.tonnage), ['5.4 t', '17.1 t', null]);
  assert.deepEqual(weeks.map((week) => week.sessions.map((session) => session.id)), [
    ['ses_5'], ['ses_4', 'ses_3', 'ses_2'], ['ses_1'],
  ]);
  assert.deepEqual(weeks.map((week) => week.startedAt), [
    new Date(2026, 7, 10).getTime(), new Date(2026, 7, 3).getTime(), new Date(2026, 6, 27).getTime(),
  ]);
  // The bottom of the log reached: nothing can be added to the oldest week, so it is whole.
  assert.deepEqual(weeksOf(summaries, { complete: true }).map((week) => week.tonnage), ['5.4 t', '17.1 t', '5.0 t']);
  assert.deepEqual(weeksOf([]), []);
});

test('weeksOf — a week nobody can sum, and a week that adds up to nothing, both say nothing', () => {
  const row = (id, at, tonnageKg) => ({ id, startedAt: at.getTime(), tonnageKg });
  // A deployment that does not aggregate tonnage yet: summing the rest would understate the week.
  const partly = [
    row('ses_3', new Date(2026, 7, 10, 18, 44), 5400),
    { id: 'ses_2', startedAt: new Date(2026, 7, 12, 7, 0).getTime() },
    row('ses_1', new Date(2026, 7, 4, 18, 0), 3000),
  ];
  assert.deepEqual(weeksOf(partly, { complete: true }).map((week) => week.tonnage), [null, '3.0 t']);
  // A week of chin-ups and dips moved no external load, and prints nothing where the tonnage goes.
  const bodyweight = [
    row('ses_2', new Date(2026, 7, 12, 7, 0), 0),
    row('ses_1', new Date(2026, 7, 10, 7, 0), 0),
  ];
  assert.deepEqual(weeksOf(bodyweight, { complete: true }).map((week) => week.tonnage), [null]);
});

// A ZONE WHOSE CLOCKS JUMP AT LOCAL MIDNIGHT HAS NO MIDNIGHT THAT DAY, and this fold compares
// instants for equality rather than differencing them (agoLabel does the other thing, safely).
// `setHours(0, …)` landed on 01:00 on the transition day and `setDate` carried that hour back to
// the Monday, so one training week folded into TWO dividers — each carrying a tonnage the week
// never moved, over a head that said two weeks were loaded. Chile, Lebanon, Cuba and Paraguay all
// transition at midnight; noon exists everywhere on every day, which is why the arithmetic runs
// there and the Monday is rebuilt from the calendar date it lands on.
test('weeksOf — one training week is one divider in a zone whose clocks jump at midnight', () => {
  const zone = process.env.TZ;
  try {
    // Chile, 2026-09-06: 00:00 → 01:00. Monday 31 Aug through the Sunday the clocks moved.
    process.env.TZ = 'America/Santiago';
    const chile = weeksOf([
      { id: 'ses_4', startedAt: new Date(2026, 8, 6, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_3', startedAt: new Date(2026, 8, 5, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_2', startedAt: new Date(2026, 8, 2, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 7, 31, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(chile.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 31 aug', '4.0 t', 4],
    ]);

    // Lebanon, 2026-03-29: the same jump, and the transition day is the Sunday that CLOSES a week.
    process.env.TZ = 'Asia/Beirut';
    const lebanon = weeksOf([
      { id: 'ses_2', startedAt: new Date(2026, 2, 29, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 2, 23, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(lebanon.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 23 mar', '2.0 t', 2],
    ]);

    // And a zone that jumps at 02:00 like everybody else still reads the same.
    process.env.TZ = 'Europe/Berlin';
    const berlin = weeksOf([
      { id: 'ses_2', startedAt: new Date(2026, 2, 29, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 2, 23, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(berlin.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 23 mar', '2.0 t', 2],
    ]);
  } finally {
    if (zone == null) delete process.env.TZ; else process.env.TZ = zone;
  }
});

// A week is a run of ADJACENT rows, because the log arrives in one order the server guarantees.
test('weeksOf — a session that crosses midnight into Monday starts the new week, not the old one', () => {
  const summaries = [
    { id: 'ses_2', startedAt: new Date(2026, 7, 10, 0, 20).getTime(), tonnageKg: 1000 },
    { id: 'ses_1', startedAt: new Date(2026, 7, 9, 23, 40).getTime(), tonnageKg: 2000 },
  ];
  const weeks = weeksOf(summaries, { complete: true });
  assert.deepEqual(weeks.map((week) => [week.label, week.tonnage]), [
    ['week of 10 aug', '1.0 t'], ['week of 3 aug', '2.0 t'],
  ]);
});

// ── §G17 · session detail ─────────────────────────────────────────────────────────────────────

// The routine is the title above this line, so it is never printed twice. An open session is given
// no length it does not have, and a session that moved no external load prints no tonnage.
test('sessionDetailMeta — the day, the length, and the two facts the header is measured in', () => {
  const startedAt = new Date(2026, 7, 10, 18, 2).getTime();
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });
  const sets = [set('warmup', 40, 8), set('working', 82.5, 5), set('working', 82.5, 5)];
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 58 * 60_000 }, sets),
    'Mon 10 Aug · 58m · 2 working · 825 kg',
  );
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: null }, sets),
    'Mon 10 Aug · in progress · 2 working · 825 kg',
  );
  // The design's own header, at the scale a tonne is a caption of.
  const wholeSession = [set('warmup', 40, 8), ...Array.from({ length: 11 }, () => set('working', 98, 5))];
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 58 * 60_000 }, wholeSession),
    'Mon 10 Aug · 58m · 11 working · 5.4 t',
  );
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 3_600_000 }, [set('working', 0, 9), set('working', 0, 7)]),
    'Mon 10 Aug · 1h 00m · 2 working',
  );
  assert.equal(sessionDetailMeta({ startedAt, finishedAt: startedAt + 600_000 }, []), 'Mon 10 Aug · 10m · 0 working');
});

// The instant is the session's START, because that is when the plan was frozen — and the chip is
// what says out loud that a routine retargeted since cannot rewrite what the log says about it.
test('planFrozenLabel — the snapshot is named by the moment it was taken', () => {
  const startedAt = new Date(2026, 7, 10, 18, 2).getTime();
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 }] };
  assert.equal(planFrozenLabel({ startedAt, plan }), 'plan snapshot · frozen 18:02');
  assert.equal(planFrozenLabel({ startedAt, plan: JSON.stringify(plan) }), 'plan snapshot · frozen 18:02');
  assert.equal(planFrozenLabel({ startedAt }), null);
  assert.equal(planFrozenLabel({ startedAt, plan: 'not json at all' }), null);
});

// WHAT THE PLAN SAID ABOUT ONE MOVEMENT, off the frozen snapshot — whose entries name their fields
// the way the domain does (`sets` · `reps` · `weightKg`) — and spelled by the one function that
// spells every target in this product.
test('planReadingOf — the target, the movement nobody planned, and the plan that names one twice', () => {
  const session = {
    startedAt: 1_900_000_000_000,
    plan: {
      routine: 'Push A',
      entries: [
        { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 },
        { exerciseId: 'overhead-press', sets: 5, reps: 5 },
      ],
    },
  };
  assert.deepEqual(planReadingOf(session, 'bench-press'), {
    kind: 'planned',
    line: 'plan 5 × 5 · 82.5',
    entry: { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 },
  });
  // A target the routine declines to set is "whatever you did last time", and prints no weight.
  assert.equal(planReadingOf(session, 'overhead-press').line, 'plan 5 × 5');
  assert.deepEqual(planReadingOf(session, 'chin-up'), { kind: 'added', line: NOT_IN_PLAN, entry: null });
  assert.equal(NOT_IN_PLAN, 'not in the plan');

  // ⚠ A plan may name one movement twice — the heavy line and the back-off line — and a PlanEntry
  // carries no id, so nothing can tell which of the two a logged set was performed against.
  const twice = {
    startedAt: 1_900_000_000_000,
    plan: {
      routine: 'Squat day',
      entries: [
        { exerciseId: 'back-squat', sets: 3, reps: 3, weightKg: 140 },
        { exerciseId: 'back-squat', sets: 3, reps: 8, weightKg: 100 },
      ],
    },
  };
  assert.deepEqual(planReadingOf(twice, 'back-squat'), { kind: 'ambiguous', line: null, entry: null });

  // A session nobody planned has no comparison to draw, and never says a movement was "added".
  assert.deepEqual(planReadingOf({ startedAt: 1 }, 'bench-press'), { kind: 'unplanned', line: null, entry: null });

  // The snapshot is frozen jsonb the server echoes back verbatim, so a list of entries is only a
  // convention — the same reason a routine name is checked for being a string. A plan nothing can be
  // read out of draws no comparison; it does NOT claim every movement was added, and it never throws
  // the screen away. (`plan.entries` on a bare array is `Array.prototype.entries`, which `?? []`
  // does not catch and `.filter` is not.)
  const unreadable = { kind: 'unplanned', line: null, entry: null };
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A', entries: {} } }, 'bench-press'), unreadable);
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A' } }, 'bench-press'), unreadable);
  assert.deepEqual(planReadingOf({ plan: [{ exerciseId: 'bench-press', sets: 5 }] }, 'bench-press'), unreadable);
  // An EMPTY list is a different fact, and it does mean every movement was added today.
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A', entries: [] } }, 'bench-press'), {
    kind: 'added', line: NOT_IN_PLAN, entry: null,
  });
});

// Dim is what the plan said, bright is what you did, and a miss gets one line and no scolding —
// which is why a lighter bar earns no note at all: the plan was agreed to, not a score to fall
// below. Short is only short when the bar did not go up, exactly as review.js reads the same
// comparison: heavier for fewer is a different session, not a smaller one.
test('setNoteOf — one word per set, and never a grade', () => {
  const planned = planReadingOf({
    plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 }] },
  }, 'bench-press');
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });

  assert.equal(setNoteOf(set('working', 82.5, 5), planned, false), 'on plan');
  assert.equal(setNoteOf(set('working', 82.5, 3), planned, false), 'two short');
  assert.equal(setNoteOf(set('working', 82.5, 4), planned, false), 'one short');
  assert.equal(setNoteOf(set('working', 85, 5), planned, false), '+2.5 over plan');
  assert.equal(setNoteOf(set('working', 100, 5), planned, false), '+17.5 over plan');
  // Heavier for fewer is a different session rather than a smaller one.
  assert.equal(setNoteOf(set('working', 85, 3), planned, false), '+2.5 over plan');
  // A lighter bar is not annotated at all.
  assert.equal(setNoteOf(set('working', 70, 5), planned, false), null);
  assert.equal(setNoteOf(set('working', 70, 3), planned, false), 'two short');
  // Past ten the word stops being one a lifter would say.
  assert.equal(setNoteOf(set('working', 82.5, 0), { ...planned, entry: { ...planned.entry, reps: 12 } }, false), '12 short');

  // A set the plan never asked for says only its own kind, whatever the plan says about the lift.
  assert.equal(setNoteOf(set('warmup', 40, 8), planned, true), 'warmup');
  assert.equal(setNoteOf(set('drop', 60, 8), planned, false), 'drop');
  assert.equal(setNoteOf(set('failure', 82.5, 1), planned, false), 'failure');

  // The movement is in the session and not in the plan: said once, on the first set of it.
  const added = planReadingOf({ plan: { routine: 'Push A', entries: [] } }, 'chin-up');
  assert.equal(setNoteOf(set('working', 0, 9), added, true), 'added today');
  assert.equal(setNoteOf(set('working', 0, 7), added, false), null);

  // Ambiguous and unplanned both annotate nothing rather than guessing.
  assert.equal(setNoteOf(set('working', 140, 3), { kind: 'ambiguous', line: null, entry: null }, true), null);
  assert.equal(setNoteOf(set('working', 140, 3), { kind: 'unplanned', line: null, entry: null }, true), null);

  // A plan with no rep target is canon screen 6's `3 × max`: there is no count to fall short of,
  // and with no weight named either there is nothing to be over or on.
  const toMax = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3 }] },
  }, 'chin-up');
  assert.equal(toMax.line, 'plan 3 × max');
  assert.equal(setNoteOf(set('working', 0, 9), toMax, true), null);
  assert.equal(setNoteOf(set('working', 5, 9), toMax, true), null);

  // ZERO IS THE OTHER SPELLING OF "NO TARGET", and the note must read it the way the header above
  // the sets does — the exercise line prints `plan 3 × 9` for both, so a set beside it may not
  // claim the lifter went 5 kg over a weight the plan never named. Gym writes that spelling itself:
  // a routine kept from a session of chin-ups carries `targetWeightKg: 0` (routines.js).
  const bodyweight = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3, reps: 9, weightKg: 0 }] },
  }, 'chin-up');
  assert.equal(bodyweight.line, 'plan 3 × 9');
  assert.equal(setNoteOf(set('working', 0, 9), bodyweight, true), null);
  assert.equal(setNoteOf(set('working', 5, 9), bodyweight, true), null);
  assert.equal(setNoteOf(set('working', 0, 7), bodyweight, false), 'two short');

  // A band-assisted target IS a target: a negative load is a real point on this number line.
  const assisted = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3, reps: 6, weightKg: -20 }] },
  }, 'chin-up');
  assert.equal(assisted.line, 'plan 3 × 6 · −20');
  assert.equal(setNoteOf(set('working', -20, 6), assisted, true), 'on plan');
  assert.equal(setNoteOf(set('working', -10, 6), assisted, true), '+10 over plan');
});

// Zero is not a load, it is the absence of one — so a set logged at nothing is the movement done at
// bodyweight, and a band-assisted −20 prints its load, being a real point on this number line.
test('setLoadLabel — what a set was, in the one spelling a weight has here', () => {
  assert.equal(setLoadLabel({ weightKg: 82.5, reps: 5 }), '82.5 × 5');
  assert.equal(setLoadLabel({ weightKg: 0, reps: 9 }), 'bodyweight × 9');
  assert.equal(setLoadLabel({ weightKg: -20, reps: 9 }), '−20 × 9');
  assert.equal(setLoadLabel({ weightKg: 100, reps: 1 }), '100 × 1');
});
