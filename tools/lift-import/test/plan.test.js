import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ImportRefusal,
  distinctExerciseNames,
  matchExercise,
  buildCatalogIndex,
  normalizeName,
  planSessions,
  readExport,
  resolveNames,
  wellFormedId,
  windmillId,
} from '../plan.js';

const CATALOG = [
  { id: 'bench-press', name: 'Bench Press' },
  { id: 'incline-bench-press', name: 'Incline Bench Press' },
  { id: 'back-squat', name: 'Back Squat' },
  { id: 'pull-up', name: 'Pull Up' },
  { id: 'farmers-carry', name: 'Farmers Carry' },
  { id: 'standing-calf-raise', name: 'Standing Calf Raise' },
  { id: 'seated-calf-raise', name: 'Seated Calf Raise' },
];

const uuidA = 'A1B2C3D4-E5F6-4788-9ABC-DEF012345678';
const uuidB = '11111111-2222-4333-8444-555555555555';
const uuidC = 'FFFFFFFF-EEEE-4DDD-8CCC-BBBBBBBBBBBB';

function liftSession(overrides = {}) {
  return {
    id: uuidA,
    name: 'Upper A',
    templateId: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_003_600_000,
    sets: [set()],
    ...overrides,
  };
}

function set(overrides = {}) {
  return {
    id: uuidB,
    exerciseName: 'Bench Press',
    setNumber: 1,
    weight: 82.5,
    reps: 8,
    completedAt: 1_700_000_600_000,
    ...overrides,
  };
}

function planOf(sessions, names = { 'Bench Press': 'bench-press' }) {
  const document = { app: 'lift', version: 1, exportedAt: 1, sessions };
  return planSessions(document, new Map(Object.entries(names)));
}

describe('normalization', () => {
  it('folds Lift\'s three-lifts-forever case variants onto one key', () => {
    const keys = ['Bench Press', 'Bench press', 'bench press', '  BENCH   PRESS  ', 'Bench-Press']
      .map(normalizeName);
    deepStrictEqual(keys, ['bench press', 'bench press', 'bench press', 'bench press', 'bench press']);
  });

  it('folds punctuation and plurals', () => {
    strictEqual(normalizeName("Farmer's Carry"), 'farmer carry');
    strictEqual(normalizeName('Farmers Carry'), 'farmer carry');
    strictEqual(normalizeName('Push Ups'), 'push up');
    strictEqual(normalizeName('Skull Crushers'), 'skull crusher');
    strictEqual(normalizeName('Flies'), 'fly');
    strictEqual(normalizeName('Bench Presses'), 'bench press');
    strictEqual(normalizeName('Press'), 'press');
    strictEqual(normalizeName(''), '');
  });
});

describe('matching', () => {
  const index = buildCatalogIndex(CATALOG);

  it('resolves an exact fold to one id', () => {
    deepStrictEqual(matchExercise('bench   press', index), {
      status: 'resolved',
      exerciseId: 'bench-press',
      candidates: [{ id: 'bench-press', name: 'Bench Press' }],
    });
  });

  it('refuses to pick when two catalog movements carry the same name', () => {
    const collided = buildCatalogIndex([
      ...CATALOG,
      { id: 'my-bench-press', name: 'bench press' },
    ]);
    const match = matchExercise('Bench Press', collided);
    strictEqual(match.status, 'ambiguous');
    strictEqual(match.exerciseId, null);
    deepStrictEqual(match.candidates, [
      { id: 'bench-press', name: 'Bench Press' },
      { id: 'my-bench-press', name: 'bench press' },
    ]);
  });

  it('refuses to pick when nothing matches, and says what it considered', () => {
    const match = matchExercise('Calf Raises', index);
    strictEqual(match.status, 'unresolved');
    strictEqual(match.exerciseId, null);
    deepStrictEqual(match.candidates, [
      { id: 'seated-calf-raise', name: 'Seated Calf Raise' },
      { id: 'standing-calf-raise', name: 'Standing Calf Raise' },
    ]);
  });

  it('has no candidates for a name with no shared word', () => {
    deepStrictEqual(matchExercise('Zercher Carry Machine', index).candidates, [
      { id: 'farmers-carry', name: 'Farmers Carry' },
    ]);
    deepStrictEqual(matchExercise('Zottman', index).candidates, []);
  });
});

describe('resolveNames', () => {
  it('folds every case variant onto one id and resolves nothing else', () => {
    const { resolved, unresolved } = resolveNames(
      ['Bench Press', 'Bench press', 'bench press', 'Calf Raises'], CATALOG);
    deepStrictEqual([...resolved.entries()], [
      ['Bench Press', 'bench-press'],
      ['Bench press', 'bench-press'],
      ['bench press', 'bench-press'],
    ]);
    strictEqual(unresolved.length, 1);
    strictEqual(unresolved[0].name, 'Calf Raises');
    strictEqual(unresolved[0].reason, 'no catalog movement carries this name');
  });

  it('honors a human mapping, and refuses one the catalog cannot hold', () => {
    const { resolved, unresolved } = resolveNames(
      ['Calf Raises', 'Wobbly Thing'], CATALOG,
      { 'Calf Raises': 'standing-calf-raise', 'Wobbly Thing': 'not-a-movement' });
    deepStrictEqual([...resolved.entries()], [['Calf Raises', 'standing-calf-raise']]);
    strictEqual(unresolved.length, 1);
    strictEqual(unresolved[0].name, 'Wobbly Thing');
    strictEqual(unresolved[0].reason, 'the mapping points at "not-a-movement", which the catalog does not hold');
  });
});

describe('id derivation', () => {
  it('is the Lift uuid, lowercased and stripped, under a prefix', () => {
    strictEqual(windmillId('ses_', uuidA), 'ses_a1b2c3d4e5f647889abcdef012345678');
    strictEqual(windmillId('set_', uuidA), 'set_a1b2c3d4e5f647889abcdef012345678');
  });

  it('gives the same id for every spelling of the same uuid', () => {
    strictEqual(windmillId('ses_', uuidA), windmillId('ses_', uuidA.toLowerCase()));
    strictEqual(windmillId('ses_', uuidA), windmillId('ses_', uuidA.replace(/-/g, '')));
  });

  it('satisfies the server\'s id rule', () => {
    const id = windmillId('ses_', uuidA);
    strictEqual(id.length, 36);
    ok(wellFormedId(id));
    ok(wellFormedId(windmillId('set_', uuidC)));
    strictEqual(wellFormedId('ses_short'.slice(0, 7)), false);
    strictEqual(wellFormedId('ses_bad.id.with.dots'), false);
  });

  it('refuses anything that is not a uuid', () => {
    throws(() => windmillId('ses_', 'not-a-uuid'), ImportRefusal);
    throws(() => windmillId('ses_', ''), ImportRefusal);
    throws(() => windmillId('ses_', null), ImportRefusal);
  });
});

describe('the export envelope', () => {
  it('reads a v1 lift export', () => {
    const document = readExport(JSON.stringify({ app: 'lift', version: 1, exportedAt: 7, sessions: [] }));
    deepStrictEqual(document, { app: 'lift', version: 1, exportedAt: 7, sessions: [] });
  });

  it('refuses another app, another version, and a missing sessions array', () => {
    throws(() => readExport('{"app":"strava","version":1,"sessions":[]}'), ImportRefusal);
    throws(() => readExport('{"app":"lift","version":2,"sessions":[]}'), ImportRefusal);
    throws(() => readExport('{"app":"lift","version":1}'), ImportRefusal);
    throws(() => readExport('not json'), ImportRefusal);
  });

  it('collects the distinct names a fold has to cover', () => {
    deepStrictEqual(distinctExerciseNames({
      sessions: [
        { sets: [set(), set({ exerciseName: 'Bench press' })] },
        { sets: [set({ exerciseName: 'Back Squat' })] },
        { sets: [] },
      ],
    }), ['Back Squat', 'Bench Press', 'Bench press']);
  });
});

describe('the bands the store enforces', () => {
  it('keeps a negative weight — band-assisted work logs on one number line', () => {
    const plan = planOf([liftSession({ sets: [set({ weight: -22.5 })] })]);
    strictEqual(plan.counts.setsPlanned, 1);
    strictEqual(plan.sessions[0].sets[0].weightKg, -22.5);
  });

  it('refuses reps outside 1..500', () => {
    const plan = planOf([liftSession({
      sets: [set({ id: uuidB, reps: 0 }), set({ id: uuidC, reps: 501 }),
             set({ id: '22222222-3333-4444-8555-666666666666', reps: 7.5 })],
    })]);
    strictEqual(plan.counts.setsSkippedRepsOutOfBand, 3);
    strictEqual(plan.counts.setsPlanned, 0);
    strictEqual(plan.counts.sessionsSkippedEverySetRefused, 1);
  });

  it('refuses weight outside -500..500', () => {
    const plan = planOf([liftSession({
      sets: [set({ id: uuidB, weight: -500.01 }), set({ id: uuidC, weight: 900 })],
    })]);
    strictEqual(plan.counts.setsSkippedWeightOutOfBand, 2);
    strictEqual(plan.counts.setsPlanned, 0);
  });

  it('refuses an instant of zero or past the end of time', () => {
    const plan = planOf([liftSession({
      sets: [set({ id: uuidB, completedAt: 0 }), set({ id: uuidC, completedAt: 253402300799001 })],
    })]);
    strictEqual(plan.counts.setsSkippedInstantOutOfBand, 2);
    strictEqual(plan.counts.setsPlanned, 0);
  });

  it('refuses a session whose start is not an instant, and counts the sets it takes down', () => {
    const plan = planOf([liftSession({ startedAt: 0 })]);
    deepStrictEqual(plan.sessions, []);
    strictEqual(plan.counts.sessionsSkippedUnreadable, 1);
    strictEqual(plan.counts.setsTotal, 1);
    strictEqual(plan.counts.setsPlanned, 0);
  });

  it('counts a weight the numeric(6,2) column will round', () => {
    const plan = planOf([liftSession({ sets: [set({ weight: 82.567 })] })]);
    strictEqual(plan.counts.setsWeightRounded, 1);
    strictEqual(plan.counts.setsPlanned, 1);
  });
});

describe('the session rules', () => {
  it('skips a setless session — an accidental Finish is not history', () => {
    const plan = planOf([liftSession({ sets: [] })]);
    deepStrictEqual(plan.sessions, []);
    strictEqual(plan.counts.sessionsTotal, 1);
    strictEqual(plan.counts.sessionsSkippedNoSets, 1);
    strictEqual(plan.counts.sessionsSkippedEverySetRefused, 0);
    deepStrictEqual(plan.skips, [{
      scope: 'session',
      label: 'Upper A (A1B2C3D4-E5F6-4788-9ABC-DEF012345678)',
      reason: 'no sets — an accidental Finish, not a workout',
    }]);
  });

  it('closes an abandoned session at its last set', () => {
    const plan = planOf([liftSession({
      finishedAt: null,
      sets: [set({ id: uuidB, completedAt: 1_700_000_600_000 }),
             set({ id: uuidC, completedAt: 1_700_002_600_000 })],
    })]);
    strictEqual(plan.sessions.length, 1);
    strictEqual(plan.sessions[0].finishedAt, 1_700_002_600_000);
    strictEqual(plan.sessions[0].finishedFrom, 'lastSet');
    strictEqual(plan.counts.sessionsFinishedFromLastSet, 1);
    strictEqual(plan.counts.sessionsFinishRepaired, 0);
  });

  it('closes an abandoned session at its start when every set predates it', () => {
    const plan = planOf([liftSession({ finishedAt: null, sets: [set({ completedAt: 1_699_000_000_000 })] })]);
    strictEqual(plan.sessions[0].finishedAt, 1_700_000_000_000);
    strictEqual(plan.sessions[0].finishedFrom, 'lastSet');
  });

  it('repairs a finish that runs backwards against the start', () => {
    const plan = planOf([liftSession({ finishedAt: 1_699_000_000_000 })]);
    strictEqual(plan.sessions[0].finishedAt, 1_700_000_600_000);
    strictEqual(plan.sessions[0].finishedFrom, 'repaired');
    strictEqual(plan.counts.sessionsFinishRepaired, 1);
    strictEqual(plan.skips.length, 1);
  });

  it('keeps a finish the session could have had', () => {
    const plan = planOf([liftSession()]);
    strictEqual(plan.sessions[0].finishedAt, 1_700_003_600_000);
    strictEqual(plan.sessions[0].finishedFrom, 'export');
    strictEqual(plan.counts.sessionsFinishedFromLastSet, 0);
    strictEqual(plan.counts.sessionsFinishRepaired, 0);
  });

  it('orders sets by completedAt, whatever order the export used', () => {
    const plan = planOf([liftSession({
      sets: [set({ id: uuidC, completedAt: 1_700_002_600_000 }),
             set({ id: uuidB, completedAt: 1_700_000_600_000 })],
    })]);
    deepStrictEqual(plan.sessions[0].sets.map((one) => one.completedAt),
      [1_700_000_600_000, 1_700_002_600_000]);
  });

  it('derives the ids the write path will use', () => {
    const plan = planOf([liftSession()]);
    strictEqual(plan.sessions[0].id, 'ses_a1b2c3d4e5f647889abcdef012345678');
    deepStrictEqual(plan.sessions[0].sets, [{
      id: 'set_11111111222243338444555555555555',
      exerciseId: 'bench-press',
      weightKg: 82.5,
      reps: 8,
      completedAt: 1_700_000_600_000,
    }]);
  });

  it('drops a repeated id rather than letting a replay overwrite the first row', () => {
    const plan = planOf([
      liftSession(),
      liftSession({ name: 'Upper A again' }),
    ]);
    strictEqual(plan.sessions.length, 1);
    strictEqual(plan.counts.sessionsSkippedDuplicateId, 1);

    const twice = planOf([liftSession({ sets: [set(), set({ weight: 90 })] })]);
    strictEqual(twice.sessions[0].sets.length, 1);
    strictEqual(twice.counts.setsSkippedDuplicateId, 1);
  });

  it('drops a set naming a movement no fold resolved', () => {
    const plan = planOf([liftSession({ sets: [set({ exerciseName: 'Calf Raises' })] })]);
    strictEqual(plan.counts.setsSkippedUnresolvedName, 1);
    strictEqual(plan.counts.sessionsSkippedEverySetRefused, 1);
    deepStrictEqual(plan.sessions, []);
  });

  it('counts every set of the export exactly once, refused or planned', () => {
    const plan = planOf([
      liftSession(),
      liftSession({ id: uuidC, sets: [] }),
      liftSession({ id: '33333333-4444-4555-8666-777777777777', startedAt: 0, sets: [set({ id: uuidC })] }),
    ]);
    strictEqual(plan.counts.setsTotal, 2);
    strictEqual(plan.counts.setsPlanned, 1);
    strictEqual(plan.counts.sessionsTotal, 3);
    strictEqual(plan.counts.sessionsPlanned, 1);
  });
});
