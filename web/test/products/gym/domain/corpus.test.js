// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { SaveDraft } from '../../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { LocalDay } from '../../../../src/platform/domain-kit/time.js';
import { Valid } from '../../../../src/platform/domain-kit/validation.js';
import { Violation } from '../../../../src/platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Bodyweight, DeleteWeighIn, SaveWeighIn, WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { Catalogue, CreateExercise, EditExercise, Exercise, ExerciseValue, RenameExercise, defaultStepKg, loadingChoice, renamedAliases } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, GymRules, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { MoveNote, Note, SaveNoteCall } from '../../../../src/products/gym/domain/notes.js';
import { Preferences, PreferencesValue, SavePreferences, SaveRestSettings, restSettings } from '../../../../src/products/gym/domain/preferences.js';
import { ProposalDiff } from '../../../../src/products/gym/domain/proposalDiff.js';
import { ApplyProposal, DismissProposal, Proposal, ProposalState, ProposeRoutine, RoutineCreation, changesBetween } from '../../../../src/products/gym/domain/proposals.js';
import { DeleteRoutine, PlanSnapshot, ReorderRoutines, Routine, RoutineEntry, RoutineValue, SaveRoutine, SaveRoutinePlan, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { GymVolume, Session, SessionRules, SetRules, TrainingSet, VolumePart } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, CorrectedSet, CorrectSession, CorrectSet, DeleteSet, DiscardSession, FinishSession, ImportedSet, ImportSession, StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { TrainingHistory } from '../../../../src/products/gym/domain/trainingHistory.js';
import { GymEstimate, Prefill, ProgressRecords, Readout, RestTarget, TrainingLog } from '../../../../src/products/gym/domain/trainingReads.js';
import { GymUnits, WeightLadder } from '../../../../src/products/gym/domain/units.js';
import { PlanChanges, PlanOperations, ReviseWorkoutPlan } from '../../../../src/products/gym/domain/workoutPlan.js';
import { ApplyWorkoutProposal, DismissWorkoutProposal, ProposeWorkout, ReissueWorkoutProposal, WorkoutProposal, WorkoutProposalState } from '../../../../src/products/gym/domain/workoutProposals.js';
import { AdoptWorkout, SignedOutWorkout } from '../../../../src/products/gym/domain/workoutAdoption.js';
import { CoachRoutineImport, ImportCoachRoutineBatch } from '../../../../src/products/gym/domain/coachOnboarding.js';
import { DiscardSignedOutWorkout, RecoverStrandedSets, SaveRefusedStart, SetFix, WorkoutFix, WorkoutRecovery } from '../../../../src/products/gym/domain/workoutRecovery.js';
import { DomainNotice } from '../../../../src/platform/domain-kit/refusals.js';
import { AbilityCall, CoachMessage, CoachThread, Picture, ReadServed } from '../../../../src/products/gym/domain/coach/conversation.js';
import { BeginRound, DeleteConversation, EndTurn, ForgetRunningTurn, OpenTurn, RecoverMark, StreamTurnText, WithdrawTurn } from '../../../../src/products/gym/domain/coach/turn.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { Catalog } from '../../../../src/platform/domain-kit/abilities.js';
import { Collation } from '../../../../src/platform/domain-kit/collation.js';
import { AbilityRefusals } from '../../../../src/products/gym/domain/coach/conversation.js';
import { AbilityRequest, RunAbility, SERVER_RUN } from '../../../../src/products/gym/domain/coach/runAbility.js';
import { between } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { parseSeeded } from '../../../../../packages/api-contract/sync/reference/core/derive.js';
import { compareJcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { Contract, momentOf, savedForm, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */
/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */

const book = GymRules.book;
const corpus = new ProductCorpus(book, GymRules.spec);
const rulesFile = 'gym/domain/rules.json';
const valuesFile = 'gym/domain/values.json';
const ladderFile = 'gym-ladder.json';
/** @type {string[]} */
const pending = [];
// The replica executor claims catalog/3's corpora; catalog/2's are the iPhone's and the server's until they retire (gym
// Coach on the AI service §9), and the scripted turns are the server's turn wire. The web speaks neither, as Android does
// not: its Coach runs on the device over catalog/3.
const catalog = new Catalog(Contract.json('gym/catalog-3.json'));
const abilityFiles = Contract.files('gym/abilities-3');
/** @type {Record<string, string>} */
const notApplicable = {
  ...Object.fromEntries(Contract.files('gym').filter((path) => path === 'gym/catalog.json' || path.startsWith('gym/abilities/'))
    .map((path) => [path, 'catalog/2, which the web never speaks: its executor runs catalog/3 alone'])),
  ...Object.fromEntries(Contract.files('gym').filter((path) => path.startsWith('gym/turns/')).map((path) => [path, 'the server turn wire, which the web never speaks'])),
  ...Object.fromEntries(Contract.files('gym').filter((path) => path.startsWith('gym/coach/'))
    .map((path) => [path, 'the words Coach\'s model reads are no vectors: coach/profile.test.js reads them'])),
};

/**
 * @typedef {{ file: string, case: string, seat: 'bound' | 'anon', now: number, zone: string, given: { records: any[], appBaseUrl?: string },
 *   call: { name: string, input: any }, expect: any }} AbilityCase
 */

/** @param {string} path @returns {AbilityCase[]} */
function abilityCases(path) {
  const cases = /** @type {any[]} */ (Contract.json(path));
  return cases.map((each) => {
    assert.deepEqual(Object.keys(each).sort(), ['call', 'case', 'expect', 'given', 'now', 'seat', 'zone']);
    assert.equal(each.zone, 'UTC', `${path} · ${each.case}: a zone the runner does not place`);
    return { file: path, ...each };
  });
}

// gym Coach §3.5, INV-1, INV-2: the case's call through the executor over its records as its seat at its moment, beside a
// thread and a running Coach message of this replica's turn, answered in the corpus's form: the result that decision
// always writes, and what its gesture wrote less the Coach message, each `{t, id, life, f}`, an inserted record's order
// key resolved from its anchor as the engine resolves it.
/** @param {AbilityCase} each @returns {Json} */
function ability(each) {
  const stamp = `${each.now}:0:r_aaaaaaaaaaaa`;
  /** @param {string} t @param {string} id @param {number} seq @param {Record<string, Json>} fields */
  const row = (t, id, seq, fields) => ({ t, id, seq, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])) });
  // A minting call's id is the server gate's seeded id (G-7): the turn is its seed, and the calls before it the ordinal's
  // admitted predecessors, refused by their rule.
  const seeded = AbilityRequest.creates[each.call.name] === undefined ? null : parseSeeded(each.call.input.id);
  const turn = new Id(seeded?.seed ?? 'turnAAAAAAAAAAA1', CoachMessage);
  const before = Array.from({ length: (seeded?.n ?? 1) - 1 }, (_, index) => ({ callId: `prior-${index + 1}`, name: each.call.name, outcome: 'refused',
    created: [], read: { sessions: [], sets: [], weeks: [] } }));
  const conversation = [row('thread', 'thrdAAAAAAAAAAA1', 1_000_000, { title: 'How heavy today?' }),
    row('message', String(turn.record), 1_000_001, { threadId: 'thrdAAAAAAAAAAA1', role: 'coach', replica: 'rp_00000000000000000000000000000001', state: 'running',
      at: each.now, calls: before })];
  const vector = { file: each.file, name: each.case, input: { records: { drawn: [...each.given.records, ...conversation] }, now: each.now, offsetSeconds: 0, ids: [] }, expect: each.expect };
  const action = new RunAbility(new AbilityRequest('call-1', each.call.name, each.call.input), turn, each.seat, catalog, each.given.appBaseUrl ?? 'https://windmill.works');
  const decided = /** @type {any} */ (corpus.decision(action, vector, (outcome) => outcome.kind === 'result'
    ? { result: JSON.parse(new TextDecoder().decode(outcome.jcs)), sha256: outcome.sha256 } : { refused: outcome.code }, refusalForm)).decision;
  assert.ok(decided.write, `${each.file} · ${each.case}: the call was not recorded: ${jcs(decided)}`);
  /** @param {any} anchor */
  const lastKey = (anchor) => {
    if (anchor.below === null) return null;
    const below = each.given.records.find((record) => jcs(record.id) === jcs(anchor.below));
    assert.ok(below, `no given record ${anchor.below} to anchor below`);
    return below.f[anchor.field][0];
  };
  const writes = decided.write.gesture.changes.filter((/** @type {any} */ change) => change.t !== CoachMessage.type).map((/** @type {any} */ change) => ({
    t: change.t, id: change.id, life: change.op === 'delete' ? 'dead' : 'alive',
    f: { ...(change.f ?? {}), ...(change.anchor ? { [change.anchor.field]: between(lastKey(change.anchor), null) } : {}) } }))
    .sort(compareJcs);
  return { ...decided.write.result, writes };
}

// What the corpus says of a case on the web. A withheld ability and a share never reach the executor: G-1 refuses the one
// and the host calls the Share door for the other, so the executor refuses either that reaches it. Every other case is the
// corpus's own, since no `abilities-3/` input breaks its schema, and a refusal writes nothing.
/** @param {AbilityCase} each @returns {Json} */
function abilityExpected(each) {
  const offered = catalog.ability(each.call.name);
  if (offered === null || offered.agent === 'withheld' || SERVER_RUN.includes(each.call.name)) return { refused: AbilityRefusals.notOffered, writes: [] };
  return each.expect.refused === undefined ? each.expect : { refused: each.expect.refused, writes: [] };
}

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
    case 'GymEstimate': return GymEstimate.value(f.double('weightKg'), f.int('reps'), f.optionalDouble('rpe'));
    case 'GymEstimateScore': {
      const left = Fields.object(vector.input.input.left), right = Fields.object(vector.input.input.right);
      const a = GymEstimate.score(left.double('weightKg'), left.int('reps'), left.optionalDouble('rpe'));
      const b = GymEstimate.score(right.double('weightKg'), right.int('reps'), right.optionalDouble('rpe'));
      return a === null || b === null ? null : a.compare(b);
    }
    case 'GymVolume': return GymVolume.total(vector.input.input.parts.map((/** @type {any} */ value) => {
      const fields = Fields.object(value);
      return new VolumePart(fields.string('id'), fields.optionalDouble('weightKg'), fields.optionalInt('reps'), fields.optionalInt('loadCount'));
    }));
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
    case 'Prefill':
    case 'ExpectedLoads': {
      const last = log.lastTime(f.ref('exerciseId', Exercise));
      const today = f.optionalRef('todaySessionId', Session);
      const sets = today === null ? [] : log.setsFor(today).filter((set) => set.exerciseId.equals(last.exerciseId));
      const plan = f.optionalValue('planEntry', RoutineEntry.decode);
      if (vector.input.read === 'ExpectedLoads') return Prefill.expectedLoads(sets.length, plan, last);
      const value = Prefill.of(sets, plan, last);
      return { weightKg: value.weightKg, reps: value.reps };
    }
    case 'RestTarget': {
      const target = RestTarget.of(f.optionalValue('planEntry', RoutineEntry.decode), restSettings(read));
      return target === null ? null : { seconds: target.seconds, reached: target.isReached(f.int('sinceMs')) };
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
    case 'BodyweightReps': {
      const progress = log.progress.movement(f.ref('exerciseId', Exercise));
      const series = f.bool('window', false) ? progress.chartWindow(read.moment.now, read.moment.zone) : progress;
      const best = series.bodyweightReps;
      return { sessions: series.sessions.map((point) => ({ sessionId: point.id.json, mostReps: point.fact.mostReps.json,
        bodyweightReps: point.fact.bodyweightReps?.json ?? null })),
      best: best === null ? null : { sessionId: best.id.json, fact: best.fact.bodyweightReps?.json ?? null } };
    }
    case 'ProgressRecords': {
      const records = new ProgressRecords(log.progress);
      return { movements: Object.fromEntries(records.exercises.map((id) => [String(id.record), records.movement(id).map((record) =>
        ({ session: record.point.id.json, previous: record.previous.id.json, estimate: record.estimate, gain: record.gain }))])),
      sessions: records.sessions.map((id) => id.json) };
    }
    case 'Readout': {
      switch (f.string('operation')) {
        case 'weight': return Readout.weight(f.double('value'));
        case 'estimate': return Readout.estimate(f.double('value'));
        case 'target': return Readout.target(f.optionalList('sets', SetTarget.decode));
        case 'loadUnit': return Readout.loadUnit(f.optionalString('equipment'), f.int('loadCount'));
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

/** @param {any} json @returns {import('../../../../src/products/gym/domain/workoutPlan.js').PlanOperation} */
function planOperation(json) {
  const f = Fields.object(json);
  switch (f.string('op')) {
    case 'retarget': return PlanOperations.retarget(f.int('index'), f.int('set'), f.value('target', SetTarget.decode));
    case 'add_set': return PlanOperations.addSet(f.int('index'));
    case 'remove_set': return PlanOperations.removeSet(f.int('index'), f.int('set'));
    case 'swap': return PlanOperations.swap(f.int('index'), f.ref('exerciseId', Exercise));
    case 'add_movement': return PlanOperations.addMovement(f.ref('exerciseId', Exercise));
    case 'remove_movement': return PlanOperations.removeMovement(f.int('index'));
    case 'set_rest': return PlanOperations.setRest(f.int('index'), f.optionalInt('restSeconds'));
    default: throw new Error(`unknown plan operation ${json.op}`);
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
  [valuesFile]: (vector) => {
    const input = vector.input;
    if (!input.nonFinite) return corpus.value(vector);
    const fields = structuredClone(input.fields);
    const parts = input.nonFinite.path.split('.');
    let target = fields;
    for (const part of parts.slice(0, -1)) target = target[part];
    const named = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY };
    assert.ok(Object.hasOwn(named, input.nonFinite.value));
    target[parts.at(-1)] = named[/** @type {keyof typeof named} */ (input.nonFinite.value)];
    const type = book.entity(input.entity);
    assert.ok(type?.isWritable);
    const check = type.checks?.find((check) => check.field === parts[0]);
    assert.ok(check);
    try {
      const value = check.apply(type.decode(Fields.values(type.type, input.id, fields)), momentOf(input));
      return { fields: new Valid(value, momentOf(input)).value.fields() };
    } catch (error) {
      if (error instanceof Violation) return { violation: error.json };
      throw error;
    }
  },
  'gym/domain/training-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    if (vector.input.read) return corpus.read(vector, Session.scope, (read) => {
      switch (vector.input.read) {
        case 'TrainingLog': {
          const log = new TrainingLog(read);
          const id = f.ref('sessionId', Session);
          return { sessions: log.drawnSessions.map((value) => ({ id: value.id.json, fields: value.fields() })),
            sets: log.setsFor(id).map((value) => ({ id: value.id.json, fields: { ...value.fields(),
              ...(value.setNumber === null ? {} : { setNumber: value.setNumber }) } })),
            open: log.open?.id.json ?? null, liveHint: log.liveHint, volumeKg: log.volumeKg(id), topE1rm: log.topE1rm(id) };
        }
        case 'SessionRules': {
          const session = input.session ? Session.decode(Fields.values('session', input.session.id, input.session.fields)) : null;
          if (f.string('operation') === 'canStartAt') return SessionRules.canStartAt(f.instant('startedAt'), read.moment.now);
          assert.ok(session);
          switch (f.string('operation')) {
            case 'drawn': {
              const value = SessionRules.drawn(session, read.repository(TrainingSet).all('drawn'), read.moment.now);
              return { id: value.id.json, fields: value.fields() };
            }
            case 'crosses': return SessionRules.crosses(f.instant('startedAt'), f.instant('finishedAt'), session);
            case 'canFinishAt': return SessionRules.canFinishAt(session, read.repository(TrainingSet).all('stored'), f.instant('finishedAt'));
            default: throw new Error(`unclaimed session rule ${input.operation}`);
          }
        }
        case 'SetRules': return SetRules.nextNumber(read.repository(TrainingSet).all('stored'), f.ref('sessionId', Session), f.ref('exerciseId', Exercise));
        default: throw new Error(`unclaimed training action read ${vector.input.read}`);
      }
    });
    const recorded = vector.input.action.endsWith('.recorded');
    // `<Action>.recorded` is the action's replay of facts already recorded, never held to the load floor.
    /** @param {{ recorded: any }} action */
    const door = (action) => recorded ? action.recorded : action;
    switch (vector.input.action.replace(/\.recorded$/, '')) {
      case 'StartSession': return corpus.decision(StartSession({ id: f.ref('id', Session), routineId: f.optionalRef('routineId', Routine),
        startedAt: f.optionalInstant('startedAt') }), vector, (id) => id.json, refusalForm);
      case 'FinishSession': return corpus.decision(FinishSession({ id: f.ref('id', Session), finishedAt: f.optionalInstant('finishedAt') }), vector, () => null, refusalForm);
      case 'AppendSet': return corpus.decision(door(AppendSet(TrainingSet.decode(Fields.values('set', input.set.id, input.set.fields)))), vector, (id) => id.json, refusalForm);
      case 'CorrectSet': return corpus.decision(door(CorrectSet(TrainingSet.decode(Fields.values('set', input.set.id, input.set.fields)))), vector, () => null, refusalForm);
      case 'DiscardSession': return corpus.decision(DiscardSession(f.ref('id', Session)), vector, () => null, refusalForm);
      case 'DeleteSet': return corpus.decision(DeleteSet(f.ref('id', TrainingSet)), vector, () => null, refusalForm);
      case 'ImportSession': {
        const sets = input.sets.map((/** @type {any} */ raw) => {
          const s = Fields.object(raw);
          return new ImportedSet({ id: s.ref('id', TrainingSet), exerciseId: s.ref('exerciseId', Exercise), weightKg: s.double('weightKg'),
            reps: s.int('reps'), completedAt: s.instant('completedAt'), rpe: s.optionalDouble('rpe'),
            note: s.optionalString('note'), rpeNamed: Object.hasOwn(raw, 'rpe') });
        });
        return corpus.decision(door(ImportSession({ id: f.ref('id', Session), startedAt: f.instant('startedAt'), finishedAt: f.instant('finishedAt'),
          sets, routineId: f.optionalRef('routineId', Routine) })), vector, (id) => id.json, refusalForm);
      }
      case 'CorrectSession': {
        const sets = input.sets.map((/** @type {any} */ raw) => {
          const s = Fields.object(raw);
          return new CorrectedSet({ id: s.ref('id', TrainingSet), exerciseId: s.ref('exerciseId', Exercise), setNumber: s.int('setNumber'),
            weightKg: s.double('weightKg'), reps: s.int('reps'), completedAt: s.instant('completedAt'), rpe: s.optionalDouble('rpe'),
            note: s.optionalString('note'), rpeNamed: Object.hasOwn(raw, 'rpe') });
        });
        return corpus.decision(door(CorrectSession({ id: f.ref('sessionId', Session), requestId: f.string('requestId'), startedAt: f.instant('startedAt'),
          finishedAt: f.instant('finishedAt'), routineName: f.optionalString('routineName'), sets, preserveOtherSets: input.preserveOtherSets === true })),
        vector, () => null, refusalForm);
      }
      default: throw new Error(`unclaimed training action ${vector.input.action}`);
    }
  },
  'gym/domain/training-reads.json': (vector) => corpus.read(vector, Session.scope, (read) => trainingReadsForm(vector, read)),
  'gym/domain/workout-plan-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    if (vector.input.read) {
      return corpus.read(vector, Session.scope, (read) => vector.input.read === 'PlanChanges'
        ? PlanChanges.of(read, f.ref('sessionId', Session)).json : trainingReadsForm(vector, read));
    }
    assert.equal(vector.input.action, 'ReviseWorkoutPlan', 'unclaimed workout plan action');
    return corpus.decision(ReviseWorkoutPlan({ sessionId: f.ref('sessionId', Session), base: PlanSnapshot.decode(input.base),
      operations: input.operations.map(planOperation) }), vector, () => null, refusalForm);
  },
  'gym/domain/workout-proposals-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    if (vector.input.read) {
      assert.equal(vector.input.read, 'WorkoutOutOfDate', 'unclaimed workout proposal read');
      return corpus.read(vector, WorkoutProposal.scope, (read) => ({ outOfDate: WorkoutProposalState.of(read, f.ref('id', WorkoutProposal)).outOfDate }));
    }
    switch (vector.input.action) {
      case 'ProposeWorkout': return corpus.decision(ProposeWorkout({ id: f.ref('id', WorkoutProposal), sessionId: f.ref('sessionId', Session),
        entries: f.list('entries', RoutineEntry.decode), summary: f.string('summary', '') }), vector, (id) => id.json, refusalForm);
      case 'ApplyWorkoutProposal': return corpus.decision(ApplyWorkoutProposal(f.ref('id', WorkoutProposal)), vector, () => null, refusalForm);
      case 'DismissWorkoutProposal': return corpus.decision(DismissWorkoutProposal(f.ref('id', WorkoutProposal)), vector, () => null, refusalForm);
      default: throw new Error(`unclaimed workout proposal action ${vector.input.action}`);
    }
  },
  // The review and its reasons, the fix editor's live line, ownership of a notice, and the adoption, stranded-set and
  // discard decisions, each over the saved copies the scene lists under the device key.
  'gym/domain/recovery-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    /** @param {any} json */
    const notice = (json) => new DomainNotice(json, book.registry, GymRefusals);
    if (vector.input.read) return corpus.read(vector, Session.scope, (read) => {
      const saved = SignedOutWorkout.read(read), log = new TrainingLog(read), catalogue = new Catalogue(read);
      const rows = WorkoutRecovery.review(saved, (input.notices ?? []).map(notice), log, catalogue);
      switch (vector.input.read) {
        case 'WorkoutRecovery': return rows.map((row) => ({ id: row.id.json, reason: row.reason, retry: row.retry, noticeIds: [...row.noticeIds],
          strandedSets: row.strandedSets.map((set) => set.id.json), refusal: row.refusal === null ? null : refusalForm(row.refusal), canFix: row.canFix }));
        case 'owns': {
          const copy = saved.find((workout) => workout.session.id.equals(f.ref('id', Session)));
          assert.ok(copy, 'no saved copy under the case\'s id');
          return copy.owns(notice(input.notice));
        }
        case 'WorkoutFix': {
          const id = f.ref('id', Session);
          const recovery = rows.find((row) => row.id.equals(id));
          const copy = saved.find((workout) => workout.session.id.equals(id));
          assert.ok(recovery || copy, 'no saved copy under the case\'s id');
          let fix = recovery ? WorkoutFix.ofRecovery(recovery) : WorkoutFix.of(/** @type {SignedOutWorkout} */ (copy));
          if (input.startedAt !== undefined) fix = fix.with({ startedAt: f.instant('startedAt') });
          if (input.finishedAt !== undefined) fix = fix.with({ finishedAt: f.optionalInstant('finishedAt') });
          if (input.sets !== undefined) {
            fix = fix.with({ sets: input.sets.map((/** @type {any} */ { id: setId, ...fields }) =>
              SetFix.of(TrainingSet.decode(Fields.values('set', setId, { ...fields, sessionId: id.json })))) });
          }
          const refusal = fix.refusal(log.moment, log.drawnSessions, catalogue);
          return { landed: fix.landed, sets: fix.sets.map((set) => set.id.json), refusal: refusal === null ? null : refusalForm(refusal) };
        }
        default: throw new Error(`unclaimed recovery read ${vector.input.read}`);
      }
    });
    if (vector.input.action === 'ReissueWorkoutProposal') {
      const { id, ...fields } = input.proposal;
      return corpus.decision(ReissueWorkoutProposal(WorkoutProposal.decode(Fields.values('workoutProposal', id, fields))), vector, (proposal) => proposal.json, refusalForm);
    }
    const id = f.ref('id', Session);
    const revised = input.revised === undefined ? null : SignedOutWorkout.decode(input.revised);
    switch (vector.input.action) {
      case 'AdoptWorkout': return corpus.decision(AdoptWorkout(id, f.string('mode') === 'keep' ? 'keep' : 'restart', revised), vector, () => null, refusalForm);
      case 'RecoverStrandedSets': return corpus.decision(RecoverStrandedSets(id, f.string('placement') === 'intoWorkout' ? 'intoWorkout' : 'separately', revised),
        vector, () => null, refusalForm);
      case 'DiscardSignedOutWorkout': return corpus.decision(DiscardSignedOutWorkout(id), vector, () => null, refusalForm);
      default: throw new Error(`unclaimed recovery action ${vector.input.action}`);
    }
  },
  // A start that lost a race, its sets saved from its notice as a copy the review offers.
  'gym/domain/refused-start-actions.json': (vector) => {
    assert.equal(vector.input.action, 'SaveRefusedStart', 'unclaimed refused start action');
    const notice = new DomainNotice(/** @type {any} */ (vector.input.input).notice, book.registry, GymRefusals);
    return corpus.decision(SaveRefusedStart(notice), vector, () => null, refusalForm);
  },
  'gym/domain/coach-onboarding-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    assert.equal(vector.input.action, 'ImportCoachRoutineBatch', 'unclaimed onboarding action');
    const routines = f.list('routines', (routine) => new CoachRoutineImport(routine.ref('id', Routine), routine.string('name'), routine.list('entries', RoutineEntry.decode)));
    const movements = f.list('movements', (movement) => new ExerciseValue(movement.ref('id', Exercise), movement.string('name'), movement.string('pattern'),
      movement.string('equipment'), movement.double('stepKg'), [], movement.int('loadCount')));
    return corpus.decision(ImportCoachRoutineBatch({ replica: f.string('replica'), resultId: f.string('resultId'), fingerprint: f.string('fingerprint'),
      receiptKey: f.string('receiptKey'), routines, movements }), vector, (receipt) => receipt.json, refusalForm);
  },
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
      const value = Exercise.decode(Fields.values('exercise', input.exercise.id, input.exercise.fields));
      return corpus.decision(new CreateExercise(new ExerciseValue(value.id, value.name, value.pattern, value.equipment, value.stepKg,
        value.aliases, input.loadCount)), vector, (id) => id.json, refusalForm);
    }
    if (vector.input.action === 'EditExercise') {
      const form = input.base;
      const value = Exercise.decode(Fields.values('exercise', form.id, form.fields));
      const base = new ExerciseValue(value.id, value.name, value.pattern, value.equipment, value.stepKg, value.aliases, form.loadCount);
      return corpus.decision(new EditExercise(base, input.name, input.equipment, input.loadCount), vector, (value) => ({ exercise: exerciseForm(value), loadCount: value.loadCount }), refusalForm);
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
        case 'LoadingChoice': return loadingChoice(input.equipment, input.loadCount);
        case 'DefaultStepKg': return Object.fromEntries(['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other']
          .map((equipment) => [equipment, defaultStepKg(equipment)]));
        default: throw new Error(`unclaimed catalogue read ${vector.input.read}`);
      }
    }));
  },
  'gym/domain/routines-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'SaveRoutinePlan') {
      /** @param {any} form */
      const movement = (form) => {
        const value = Exercise.decode(Fields.values('exercise', form.id, form.fields));
        return new ExerciseValue(value.id, value.name, value.pattern, value.equipment, value.stepKg, value.aliases, form.loadCount);
      };
      const action = new SaveRoutinePlan(Routine.decode(Fields.values('routine', input.base.id, input.base.fields)),
        Routine.decode(Fields.values('routine', input.current.id, input.current.fields)), input.isNew,
        input.movements.map((/** @type {any} */ edit) => ({ base: edit.base ? movement(edit.base) : null, current: movement(edit.current) })));
      const result = corpus.decision(action, vector, (id) => id.json, refusalForm);
      if (result.decision.write) result.decision.write.gesture.local = [];
      return result;
    }
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
  'gym/domain/proposals-actions.json': (vector) => {
    const input = vector.input.input;
    const fields = Fields.object(input);
    switch (vector.input.action) {
      case 'ProposeRoutine': return corpus.decision(ProposeRoutine({ id: fields.ref('id', Proposal), routineId: fields.ref('routineId', Routine),
        name: fields.string('name', ''), entries: fields.list('entries', RoutineEntry.decode), summary: fields.string('summary', ''),
        removing: fields.bool('removing', false) }), vector, (id) => id.json, refusalForm);
      case 'ApplyProposal': return corpus.decision(ApplyProposal(fields.ref('id', Proposal)), vector, () => null, refusalForm);
      case 'DismissProposal': return corpus.decision(DismissProposal(fields.ref('id', Proposal)), vector, () => null, refusalForm);
      case 'Diff': return { changes: changesBetween(fields.list('base', RoutineEntry.decode), fields.list('proposed', RoutineEntry.decode)).map((change) => change.json) };
      case 'ChangeCount': {
        const proposal = Proposal.decode(Fields.values('proposal', input.proposal.id, input.proposal.fields));
        const base = Routine.decode(Fields.values('routine', input.base.id, input.base.fields));
        return { changeCount: proposal.countChanges(base) };
      }
      case 'ChangeBlocks': {
        const proposal = Proposal.decode(Fields.values('proposal', input.proposal.id, input.proposal.fields));
        const routine = input.routine ? Routine.decode(Fields.values('routine', input.routine.id, input.routine.fields)) : null;
        const each = (input.each ?? []).map((/** @type {string} */ id) => new Id(id, Exercise));
        const diff = ProposalDiff.ofRoutine(proposal, routine, GymUnits.reading(input.units), each);
        return { unchanged: diff.unchanged, blocks: diff.blocks.map((block) => ({
          kind: block.kind, exerciseId: block.exerciseId === null ? null : block.exerciseId.record,
          fields: block.fields.map((field) => ({ label: field.label, before: field.before, after: field.after, state: field.state })) })) };
      }
      case 'Metadata': {
        const value = Proposal.decode(Fields.values('proposal', input.id, input.fields));
        return { baseRevision: value.baseRevision, baseName: value.baseName, changeCount: value.changeCount,
          state: value.state, provenance: value.provenance };
      }
      case 'RoutineCreation': return { snapshot: RoutineCreation.decode(Fields.values('routineCreation', input.id, input.fields)).snapshot };
      case 'StateRefusal':
      case 'OutOfDate': {
        const routine = input.routine ? Routine.decode(Fields.values('routine', input.routine.id, input.routine.fields)) : null;
        const state = new ProposalState({
          proposal: input.proposal ? Proposal.decode(Fields.values('proposal', input.proposal.id, input.proposal.fields)) : null,
          routine, routineVisible: fields.bool('routineVisible', true), moment: momentOf(vector.input),
          confirmedRoutine: input.confirmedRoutine ? Routine.decode(Fields.values('routine', input.confirmedRoutine.id, input.confirmedRoutine.fields)) : routine });
        if (vector.input.action === 'OutOfDate') return { outOfDate: state.outOfDate };
        const refused = state.refusal(new Id('proposal1', Proposal), fields.bool('applying'));
        return { refusal: refused === null ? null : refusalForm(refused) };
      }
      case 'ValidateProposal': {
        try { return { fields: new Valid(Proposal.decode(Fields.values('proposal', input.id, input.fields)), momentOf(vector.input)).value.fields() }; }
        catch (error) {
          if (error instanceof Violation) return { violation: error.json };
          throw error;
        }
      }
      default: throw new Error(`unclaimed proposal action ${vector.input.action}`);
    }
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
      if (vector.input.read === 'RestSettings') {
        const rest = restSettings(read);
        return { seconds: rest.seconds, sound: rest.sound };
      }
      assert.equal(vector.input.read, 'Preferences', 'unclaimed preference read');
      const value = read.repository(Preferences).find(id, 'drawn') ?? new PreferencesValue(id);
      return { id: value.id.json, fields: value.fields() };
    });
  },
  'gym/domain/rest-settings-actions.json': (vector) => {
    assert.equal(vector.input.action, 'SaveRestSettings', 'unclaimed rest settings action');
    return corpus.decision(SaveRestSettings(vector.input.input), vector, savedForm, refusalForm);
  },
  'gym/domain/coach-conversation-actions.json': (vector) => {
    const input = vector.input.input;
    const f = Fields.object(input);
    switch (vector.input.action) {
      case 'OpenTurn': return corpus.decision(new OpenTurn({ thread: f.optionalRef('thread', CoachThread), question: f.string('question'),
        pictures: f.optionalList('pictures', Picture.decode) ?? [] }), vector, (turn) => ({ thread: turn.thread.json, lifter: turn.lifter.json, coach: turn.coach.json }), refusalForm);
      case 'EndTurn': return corpus.decision(new EndTurn(f.ref('message', CoachMessage), input.state, f.optionalString('text'), f.bool('truncated', false)),
        vector, () => null, refusalForm);
      case 'BeginRound': return corpus.decision(new BeginRound(f.ref('message', CoachMessage), f.string('callId'), f.int('bytesBefore')), vector, () => null, refusalForm);
      case 'StreamTurnText': return corpus.decision(new StreamTurnText(f.ref('message', CoachMessage), f.string('text')), vector, () => null, refusalForm);
      case 'RunAbility': return corpus.decision(new RunAbility(new AbilityRequest(input.call.callId, input.call.name, input.call.input), f.ref('message', CoachMessage),
        input.seat, catalog, 'https://windmill.works'), vector, (outcome) => outcome.kind === 'result'
        ? { result: JSON.parse(new TextDecoder().decode(outcome.jcs)), sha256: outcome.sha256 } : { refused: outcome.code }, refusalForm);
      case 'RecoverMark': return corpus.decision(new RecoverMark(), vector,
        (mark) => ({ turnId: mark.turnId, callId: mark.callId, textBytesBeforeRound: mark.textBytesBeforeRound }), refusalForm);
      case 'ForgetRunningTurn': return corpus.decision(new ForgetRunningTurn(f.ref('message', CoachMessage)), vector, () => null, refusalForm);
      case 'WithdrawTurn': return corpus.decision(new WithdrawTurn({ thread: f.ref('thread', CoachThread), lifter: f.ref('lifter', CoachMessage),
        coach: f.ref('coach', CoachMessage) }), vector, (pictures) => pictures, refusalForm);
      case 'DeleteConversation': return corpus.decision(new DeleteConversation(f.ref('thread', CoachThread)), vector, (pictures) => pictures, refusalForm);
      case 'AbilityCall.recorded': {
        const message = CoachMessage.decode(Fields.values('message', input.message.id, input.message.fields));
        const recorded = message.recorded(AbilityCall.decode(Fields.object(input.call)));
        return { recorded: recorded?.json ?? null, callsBytes: message.with({ calls: [...message.calls, ...(recorded ? [recorded] : [])] }).callsBytes };
      }
      case 'ReadServed.week': return { week: ReadServed.week(new Instant(f.int('at'))) };
      default: throw new Error(`unclaimed coach conversation action ${vector.input.action}`);
    }
  },
  'gym/rules/collation.json': (vector) => ({ result: { order: [...vector.input.names].sort(Collation.compare) } }),
  'gym/rules/bodyweight.json': (vector) => corpus.read(vector, WeighIn.scope, (read) => {
    assert.equal(vector.input.read, 'Bodyweight', 'unclaimed bodyweight read');
    return bodyweightForm(new Bodyweight(read), vector.input.input);
  }),
};

test('the gym corpus is closed: every file is claimed and nothing is pending', (t) => {
  const claimed = [rulesFile, ladderFile, 'gym/catalog-3.json', ...abilityFiles, ...Object.keys(handlers)].sort();
  const files = [...Contract.files('gym'), ladderFile].sort();
  const accounted = [...claimed, ...pending, ...Object.keys(notApplicable)];
  assert.equal(new Set(accounted).size, accounted.length, 'a file is claimed twice, still pending or marked as not applying');
  assert.deepEqual(accounted.sort(), files);
  assert.deepEqual(pending, [], 'the completed gym domain has no pending files');
  for (const path of [rulesFile, valuesFile, 'gym/domain/bodyweight-actions.json', 'gym/domain/preferences-actions.json', 'gym/rules/bodyweight.json']) assert.ok(claimed.includes(path), `W1 claim regressed: ${path}`);
  assert.ok(claimed.includes('gym/domain/notes-actions.json'), 'W2 notes claim regressed');
  assert.ok(claimed.includes('gym/domain/coach-conversation-actions.json'), 'Coach records claim regressed');
  for (const path of ['gym/catalog-3.json', 'gym/rules/collation.json', ...abilityFiles]) assert.ok(claimed.includes(path), `executor claim regressed: ${path}`);
  for (const path of ['gym/domain/catalogue-actions.json', 'gym/domain/routines-actions.json']) assert.ok(claimed.includes(path), `W3 claim regressed: ${path}`);
  for (const path of ['gym/domain/training-reads.json', 'gym/domain/units.json', ladderFile]) assert.ok(claimed.includes(path), `W5a claim regressed: ${path}`);
  assert.ok(claimed.includes('gym/domain/proposals-actions.json'), 'W4 proposals claim regressed');
  assert.ok(claimed.includes('gym/domain/training-actions.json'), 'W5b training actions claim regressed');
  for (const path of ['gym/domain/workout-plan-actions.json', 'gym/domain/workout-proposals-actions.json']) assert.ok(claimed.includes(path), `in-flight claim regressed: ${path}`);
  const ladder = /** @type {{weightCases: Json[], roundCases: Json[], repCases: Json[]}} */ (Contract.json(ladderFile));
  const count = Object.keys(handlers).reduce((total, path) => total + Contract.vectors(path).length, 0)
    + ladder.weightCases.length + ladder.roundCases.length + ladder.repCases.length;
  const cases = abilityFiles.flatMap(abilityCases);
  const shares = cases.filter((each) => SERVER_RUN.includes(each.call.name)).length;
  const withheld = cases.filter((each) => catalog.ability(each.call.name)?.agent === 'withheld').length;
  const refused = cases.filter((each) => each.expect.refused !== undefined).length - shares - withheld;
  t.diagnostic(`gym corpus: ${claimed.length}/${files.length} files, ${count} vectors, ${cases.length} ability cases (${cases.length - refused - shares - withheld} results `
    + `byte-equal, ${refused} refused alike, ${shares} shares and ${withheld} withheld refused not-offered), ${pending.length} pending files, ${Object.keys(notApplicable).length} not applying`);
});

test('gym-ladder.json runs byte for byte through the domain weight ladder', () => {
  const ladder = /** @type {{weightCases: any[], roundCases: any[], repCases: any[]}} */ (Contract.json(ladderFile));
  for (const { weight, ...expect } of ladder.weightCases) assert.equal(jcs(unitsForm({ operation: 'ladder', value: weight })), jcs(expect));
  for (const { value, ...expect } of ladder.roundCases) assert.equal(jcs(unitsForm({ operation: 'round', value })), jcs(expect));
  for (const { reps, ...expect } of ladder.repCases) assert.equal(jcs(unitsForm({ operation: 'reps', value: reps })), jcs(expect));
});

test('the complete ten-entity gym rule book equals the pinned bytes', () => RuleBookParity.check(book, rulesFile));

test('every gym LOCAL rule is exercised and every server code maps on both paths', () => {
  RuleBookCheck.check(book, GymRefusals, valuesFile, Contract.files('gym/domain').filter((path) => path.endsWith('-actions.json')));
});

test('every book entity agrees with the registry and every writable sample round trips', () => {
  const values = Contract.vectors(valuesFile);
  for (const type of book.entities) {
    // A session's fields are the server's but its plan, whose entries a revision bounds by the routine entry's rules.
    if (!type.isWritable || type === Session) { RegistryCheck.entity(type, null, book); continue; }
    const sample = values.find((vector) => vector.input.entity === type.type
      && (type.checks ?? []).every((check) => check.field === null || (vector.input.fields[check.field] ?? null) !== null));
    assert.ok(sample, `${type.type} has no entity sample setting every checked field`);
    RegistryCheck.entity(type, type.decode(Fields.values(type.type, sample.input.id, sample.input.fields)), book);
  }
});

// A minting call whose id no turn seeds is a case the server's gate never hands its tool host, so no seeding executor can
// replay it; it waits for its corpus to give it a seeded id.
/** @param {AbilityCase} each */
const unseeded = (each) => AbilityRequest.creates[each.call.name] !== undefined && parseSeeded(each.call.input.id) === null;
for (const each of abilityFiles.flatMap(abilityCases)) {
  test(`${each.file} · ${each.case}`, { skip: unseeded(each) && 'its id is no seeded id a turn mints' },
    () => assert.equal(jcs(ability(each)), jcs(abilityExpected(each))));
}

for (const [file, run] of Object.entries(handlers)) for (const vector of Contract.vectors(file)) {
  test(`${file} · ${vector.name}`, () => {
    assert.equal(jcs(run(vector)), jcs(vector.expect));
    assert.equal(jcs(run({ ...vector, input: withRecordsReversed(vector.input) })), jcs(vector.expect), 'reversed records');
  });
}
