// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { SaveDraft } from '../../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { LocalDay } from '../../../../src/platform/domain-kit/time.js';
import { jcs } from '../../../../src/platform/sync/core/jcs.js';
import { Bodyweight, DeleteWeighIn, SaveWeighIn, WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { Catalogue, CreateExercise, Exercise, RenameExercise, defaultStepKg, renamedAliases } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, GymRules, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { MoveNote, Note, SaveNoteCall } from '../../../../src/products/gym/domain/notes.js';
import { Preferences, PreferencesValue, SavePreferences, restSettings } from '../../../../src/products/gym/domain/preferences.js';
import { DeleteRoutine, PlanSnapshot, ReorderRoutines, Routine, RoutineEntry, RoutineValue, SaveRoutine, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session } from '../../../../src/products/gym/domain/training.js';
import { TrainingHistory } from '../../../../src/products/gym/domain/trainingHistory.js';
import { GymEstimate, Prefill, Readout, TrainingLog } from '../../../../src/products/gym/domain/trainingReads.js';
import { GymUnits, WeightLadder } from '../../../../src/products/gym/domain/units.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { Contract, savedForm, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */
/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */

const book = GymRules.book;
const corpus = new ProductCorpus(book, GymRules.spec);
const rulesFile = 'gym/domain/rules.json';
const valuesFile = 'gym/domain/values.json';
const ladderFile = 'gym-ladder.json';
const pending = [
  'gym/domain/proposals-actions.json',
  'gym/domain/training-actions.json',
];

/** @param {{ day: LocalDay, kg: number }} value */
const entryForm = (value) => ({ day: value.day.text, kg: value.kg });

/** @param {import('../../../../src/products/gym/domain/catalogue.js').ExerciseValue} value */
const exerciseForm = (value) => ({ id: value.id.json, fields: value.fields(), aliases: [...value.aliases] });

/** @param {() => Json} body @returns {Json} */
function decoded(body) {
  try { return body(); }
  catch (error) {
    if (error instanceof DecodeError) return { decodeError: { type: error.type, field: error.field, reason: error.reason } };
    throw error;
  }
}

/** @param {Bodyweight} value @param {any} input @returns {Json} */
function bodyweightForm(value, input) {
  /** @param {'recent' | 'all'} window */
  const chart = (window) => {
    const drawn = value.chart(window);
    return { dots: drawn.dots.map(entryForm), gaps: drawn.gaps.map((gap) => ({ after: gap.after.text, before: gap.before.text })) };
  };
  return {
    stance: value.stance, today: value.today.text,
    reading: value.reading === null ? null : { entry: entryForm(value.reading.entry), daysAgo: value.reading.daysAgo },
    recent: chart('recent'), all: chart('all'),
    list: value.list(input?.from ? LocalDay.parse(input.from) : null, input?.to ? LocalDay.parse(input.to) : null).map(entryForm),
  };
}

/** @param {Vector} vector @param {import('../../../../src/platform/domain-kit/reading.js').Reader} read @returns {Json} */
function trainingReadsForm(vector, read) {
  const f = Fields.object(vector.input.input);
  const log = new TrainingLog(read);
  switch (vector.input.read) {
    case 'GymEstimate': return GymEstimate.value(f.double('weightKg'), f.int('reps'), f.string('kind', 'working'), f.optionalDouble('rpe'));
    case 'TrainingLog': {
      const id = f.ref('sessionId', Session);
      return { drawnSessions: log.drawnSessions.map((session) => session.id.json), open: log.open?.id.json ?? null,
        liveHint: log.liveHint, sets: log.setsFor(id).map((set) => set.id.json), volumeKg: log.volumeKg(id), topE1rm: log.topE1rm(id) };
    }
    case 'SessionReadout': {
      const value = log.readout(f.ref('sessionId', Session));
      return value === null ? null : { sessionId: value.sessionId.json, name: value.name, durationMs: value.durationMs,
        workingSetCount: value.workingSetCount, movementCount: value.movementCount, volumeKg: value.volumeKg, topE1rm: value.topE1rm };
    }
    case 'LastTime': {
      const value = log.lastTime(f.ref('exerciseId', Exercise));
      return { sessionId: value.session?.id.json ?? null, routine: value.routine, sets: value.sets.map((set) => set.id.json), isFirstTime: value.isFirstTime };
    }
    case 'Prefill': {
      const last = log.lastTime(f.ref('exerciseId', Exercise));
      const today = f.optionalRef('todaySessionId', Session);
      const sets = today === null ? [] : log.setsFor(today).filter((set) => set.exerciseId.equals(last.exerciseId));
      const value = Prefill.of(sets, f.optionalValue('planEntry', RoutineEntry.decode), last);
      return { weightKg: value.weightKg, reps: value.reps };
    }
    case 'StatsProgress': return log.progress.json;
    case 'ProgressCompleteness': return { isComplete: log.progress.isComplete };
    case 'Consistency': return log.progress.consistency(read.moment.now, read.moment.zone);
    case 'MovementProgress': {
      const progress = log.progress.movement(f.ref('exerciseId', Exercise));
      const series = f.bool('window', false) ? progress.chartWindow(read.moment.now, read.moment.zone) : progress;
      return { sessions: series.sessions.map((point) => point.id.json), estimates: series.estimates.map((point) => point.id.json),
        latest: series.latest?.id.json ?? null, best: series.best?.id.json ?? null, heaviest: series.heaviest?.id.json ?? null,
        mostReps: series.mostReps?.id.json ?? null, records: series.records.map((point) => point.id.json),
        hasChart: series.hasChart(read.moment.zone), gaps: series.gaps(read.moment.zone).map((gap) => ({ before: gap.before.id.json, after: gap.after.id.json })) };
    }
    case 'Readout': {
      switch (f.string('operation')) {
        case 'estimate': return Readout.estimate(f.double('value'));
        case 'target': return Readout.target(f.optionalList('sets', SetTarget.decode));
        case 'ladder': return Readout.ladder(f.list('sets', SetTarget.decode));
        case 'tonnes': return Readout.tonnes(f.double('value'));
        case 'duration': return Readout.duration(f.instant('value').ms);
        case 'briefDay': return Readout.briefDay(f.instant('value'), read.moment.now, read.moment.zone);
        case 'ago': return Readout.ago(f.instant('value'), read.moment.now, read.moment.zone);
        default: throw new Error('unclaimed readout operation');
      }
    }
    case 'TrainingHistory': {
      const history = new TrainingHistory(read);
      const method = f.string('method');
      const body = /** @type {Record<string, (...args: any[]) => Json>} */ (/** @type {unknown} */ (history))[method];
      assert.equal(typeof body, 'function', `unclaimed history read ${method}`);
      assert.ok(body);
      return body.apply(history, vector.input.input.args);
    }
    default: throw new Error(`unclaimed training read ${vector.input.read}`);
  }
}

/** @param {any} input @returns {Json} */
function unitsForm(input) {
  const value = input.value;
  const units = GymUnits.reading(input.units);
  switch (input.operation) {
    case 'ladder': return { labels: [...WeightLadder.labels(value)], down: WeightLadder.bump(value, -1), downBig: WeightLadder.bump(value, -1, true),
      up: WeightLadder.bump(value, 1), upBig: WeightLadder.bump(value, 1, true) };
    case 'round': return { rounded: WeightLadder.round(value) };
    case 'grid': return { rounded: WeightLadder.onGrid(value) };
    case 'reps': return { down: WeightLadder.bumpReps(value, -1), up: WeightLadder.bumpReps(value, 1) };
    case 'display': return { value: units.display(value) };
    case 'input': return { value: units.kilograms(value) };
    case 'estimate': return { text: Readout.estimate(value, units) };
    case 'weight': return { text: Readout.weight(value, units) };
    default: throw new Error(`unclaimed units operation ${input.operation}`);
  }
}

/** @type {Record<string, (vector: Vector) => unknown>} */
const handlers = {
  [valuesFile]: (vector) => corpus.value(vector),
  'gym/domain/training-reads.json': (vector) => corpus.read(vector, Session.scope, (read) => trainingReadsForm(vector, read)),
  'gym/domain/units.json': (vector) => unitsForm(vector.input),
  'gym/domain/notes-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'MoveNote') {
      const below = input.below === null ? null : new Id(input.below, Note);
      return corpus.decision(MoveNote(new Id(input.id, Note), below), vector, () => null, refusalForm);
    }
    assert.equal(vector.input.action, 'SaveNoteCall', 'unclaimed notes action');
    const value = input.note;
    return corpus.decision(new SaveNoteCall(Note.decode(Fields.values('note', value.id, value.fields))), vector, (id) => id.json, refusalForm);
  },
  'gym/domain/catalogue-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'CreateExercise') {
      const value = input.exercise;
      return corpus.decision(new CreateExercise(Exercise.decode(Fields.values('exercise', value.id, value.fields))), vector,
        (id) => id.json, refusalForm);
    }
    if (vector.input.action === 'RenameExercise') {
      return corpus.decision(new RenameExercise(new Id(input.id, Exercise), input.name), vector, () => null, refusalForm);
    }
    assert.equal(vector.input.action, undefined, 'unclaimed catalogue action');
    return decoded(() => corpus.read(vector, Exercise.scope, (read) => {
      switch (vector.input.read) {
        case 'SeedExercises': return SeedExercises.all.map(exerciseForm);
        case 'Catalogue': {
          const catalogue = new Catalogue(read);
          const found = input.id === undefined ? null : catalogue.find(new Id(input.id, Exercise));
          return (input.id === undefined ? catalogue.search(input.query ?? '') : found ? [found] : []).map(exerciseForm);
        }
        case 'RenamedAliases': return [...renamedAliases(input.previous, input.next, input.aliases)];
        case 'DefaultStepKg': return Object.fromEntries(['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell']
          .map((equipment) => [equipment, defaultStepKg(equipment)]));
        default: throw new Error(`unclaimed catalogue read ${vector.input.read}`);
      }
    }));
  },
  'gym/domain/routines-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'SaveRoutine' || vector.input.action === 'CreateRoutine') {
      const value = Routine.decode(Fields.values('routine', input.routine.id, input.routine.fields));
      return vector.input.action === 'CreateRoutine'
        ? corpus.decision(SaveDraft.creating(value, GymRefusals), vector, savedForm, refusalForm)
        : corpus.save(SaveRoutine, vector, new RoutineValue(value.id), () => value, savedForm, refusalForm);
    }
    if (vector.input.action === 'ReorderRoutines') return corpus.decision(ReorderRoutines(input.order.map((/** @type {string} */ id) => new Id(id, Routine))), vector, () => null, refusalForm);
    if (vector.input.action === 'DeleteRoutine') return corpus.decision(DeleteRoutine(new Id(input.id, Routine)), vector, () => null, refusalForm);
    assert.equal(vector.input.action, undefined, 'unclaimed routine action');
    return decoded(() => corpus.read(vector, Routine.scope, (read) => {
      switch (vector.input.read) {
        case 'Routines': return RoutineValue.ordered(read.repository(Routine).all('drawn'))
          .map((value) => ({ id: value.id.json, fields: value.fields() }));
        case 'RoutineMetadata': {
          const value = read.repository(Routine).find(new Id(input.id, Routine), 'drawn');
          assert.ok(value);
          return { revision: value.revision, createdEntries: value.createdEntries, createdDoor: value.createdDoor, fields: value.fields() };
        }
        case 'SessionPlan': return PlanSnapshot.decode(input.plan)?.json ?? null;
        default: throw new Error(`unclaimed routine read ${vector.input.read}`);
      }
    }));
  },
  'gym/domain/bodyweight-actions.json': (vector) => {
    const input = vector.input.input;
    const id = new Id(input.day, WeighIn);
    if (vector.input.action === 'DeleteWeighIn') return corpus.decision(DeleteWeighIn(id), vector, () => null, refusalForm);
    assert.equal(vector.input.action, 'SaveWeighIn', 'unclaimed bodyweight action');
    return corpus.save(SaveWeighIn, vector, new WeighInValue(id),
      (value) => new WeighInValue(value.id, input.kg ?? null, value.recordedAt),
      (saved) => ({ id: id.json, fields: { ...saved.values } }), refusalForm);
  },
  'gym/domain/preferences-actions.json': (vector) => {
    const id = new Id('prefs', Preferences);
    if (vector.input.action) {
      assert.equal(vector.input.action, 'SavePreferences', 'unclaimed preference action');
      const value = vector.input.input.preferences;
      return corpus.save(SavePreferences, vector, new PreferencesValue(id),
        () => Preferences.decode(Fields.values('prefs', value.id, value.fields)), savedForm, refusalForm);
    }
    return corpus.read(vector, Preferences.scope, (read) => {
      if (vector.input.read === 'RestSettings') return restSettings(read);
      assert.equal(vector.input.read, 'Preferences', 'unclaimed preference read');
      const value = read.repository(Preferences).find(id, 'drawn') ?? new PreferencesValue(id);
      return { id: value.id.json, fields: value.fields() };
    });
  },
  'gym/rules/bodyweight.json': (vector) => corpus.read(vector, WeighIn.scope, (read) => {
    assert.equal(vector.input.read, 'Bodyweight', 'unclaimed bodyweight read');
    return bodyweightForm(new Bodyweight(read), vector.input.input);
  }),
};

test('the gym corpus is closed: each file is claimed or explicitly pending', (t) => {
  const claimed = [rulesFile, ladderFile, ...Object.keys(handlers)].sort();
  const files = [...Contract.files('gym'), ladderFile].sort();
  assert.equal(new Set([...claimed, ...pending]).size, claimed.length + pending.length, 'a file is claimed twice or still pending');
  assert.deepEqual([...claimed, ...pending].sort(), files);
  assert.ok(pending.length <= 2, 'the W5a pending set can only shrink');
  for (const path of [rulesFile, valuesFile, 'gym/domain/bodyweight-actions.json', 'gym/domain/preferences-actions.json', 'gym/rules/bodyweight.json']) assert.ok(claimed.includes(path), `W1 claim regressed: ${path}`);
  assert.ok(claimed.includes('gym/domain/notes-actions.json'), 'W2 notes claim regressed');
  for (const path of ['gym/domain/catalogue-actions.json', 'gym/domain/routines-actions.json']) assert.ok(claimed.includes(path), `W3 claim regressed: ${path}`);
  for (const path of ['gym/domain/training-reads.json', 'gym/domain/units.json', ladderFile]) assert.ok(claimed.includes(path), `W5a claim regressed: ${path}`);
  const ladder = /** @type {{weightCases: Json[], roundCases: Json[], repCases: Json[]}} */ (Contract.json(ladderFile));
  const count = Object.keys(handlers).reduce((total, path) => total + Contract.vectors(path).length, 0)
    + ladder.weightCases.length + ladder.roundCases.length + ladder.repCases.length;
  t.diagnostic(`gym corpus: ${claimed.length}/${files.length} files, ${count} vectors, ${pending.length} pending files`);
});

test('gym-ladder.json runs byte for byte through the domain weight ladder', () => {
  const ladder = /** @type {{weightCases: any[], roundCases: any[], repCases: any[]}} */ (Contract.json(ladderFile));
  for (const { weight, ...expect } of ladder.weightCases) assert.equal(jcs(unitsForm({ operation: 'ladder', value: weight })), jcs(expect));
  for (const { value, ...expect } of ladder.roundCases) assert.equal(jcs(unitsForm({ operation: 'round', value })), jcs(expect));
  for (const { reps, ...expect } of ladder.repCases) assert.equal(jcs(unitsForm({ operation: 'reps', value: reps })), jcs(expect));
});

test('the complete nine-entity gym rule book equals the pinned bytes', () => RuleBookParity.check(book, rulesFile));

test('every gym LOCAL rule is exercised and every server code maps on both paths', () => {
  RuleBookCheck.check(book, GymRefusals, valuesFile, Contract.files('gym/domain').filter((path) => path.endsWith('-actions.json')));
});

test('every book entity agrees with the registry and every writable sample round trips', () => {
  const values = Contract.vectors(valuesFile);
  for (const type of book.entities) {
    if (!type.isWritable) { RegistryCheck.entity(type, null, book); continue; }
    const sample = values.find((vector) => vector.input.entity === type.type);
    assert.ok(sample, `${type.type} has no entity sample`);
    RegistryCheck.entity(type, type.decode(Fields.values(type.type, sample.input.id, sample.input.fields)), book);
  }
});

for (const [file, run] of Object.entries(handlers)) for (const vector of Contract.vectors(file)) {
  test(`${file} · ${vector.name}`, () => {
    assert.equal(jcs(run(vector)), jcs(vector.expect));
    assert.equal(jcs(run({ ...vector, input: withRecordsReversed(vector.input) })), jcs(vector.expect), 'reversed records');
  });
}
