import { Draft } from '../../platform/domain-kit/drafts.js';
import { Fields, Id } from '../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { Instant, LocalDay, Moment } from '../../platform/domain-kit/time.js';
import { Valid } from '../../platform/domain-kit/validation.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { CommitError } from '../../platform/sync/client/commit.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { Bodyweight, DeleteWeighIn, WeighIn, WeighInValue } from './domain/bodyweight.js';
import { Catalogue, CreateExercise, Exercise, ExerciseValue, RenameExercise, defaultStepKg } from './domain/catalogue.js';
import { GymRefusals } from './domain/gymRules.js';
import { ChangePreferences, Preferences, PreferencesValue, restSettings } from './domain/preferences.js';
import { DeleteRoutine, Routine, RoutineValue } from './domain/routines.js';
import { SeedExercises } from './domain/seedExercises.js';
import { GymRefusal, isStoreFailure } from './errors.js';
import { REFUSALS } from './bodyweight/bodyweight.js';
import { NAME_IT_TO_SAVE_IT } from './routines.js';
import { fromDisplayUnit, weightUnit } from './units.js';

const SCOPE = 'self/gym';
const OPERATIONS = new Set(['routine-create', 'routine-save', 'exercise-create', 'exercise-rename',
  'preferences-save', 'note-save', 'note-reorder', 'bodyweight-save', 'set-correct', 'delete', 'undo',
  'session-import', 'session-correct', 'proposal-apply', 'proposal-dismiss', 'refusal']);
const OUTCOMES = new Set(['saved-local', 'unchanged', 'failed', 'held', 'undone', 'closed', 'refused']);

export function gymStep(operation, outcome) {
  if (!OPERATIONS.has(operation) || !OUTCOMES.has(outcome)) return;
  try { track('gym_action', { operation, outcome }); } catch { /* reporting cannot stop a save */ }
}

export function gymFailure(operation) {
  if (!OPERATIONS.has(operation) && operation !== 'projection') return;
  try { captureError('gym', `gym-${operation}`, '', '/gym'); } catch { /* reporting cannot stop a save */ }
}

export const deviceZone = { offsetSeconds: (instant) => -new Date(instant.ms).getTimezoneOffset() * 60 };
export const gymMoment = (now = Date.now()) => new Moment(new Instant(now), deviceZone);

// A projection's named zone uses the same Moment as a live device's zone.
export function namedZone(timeZone) {
  const format = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' });
  return { offsetSeconds: (instant) => {
    const name = format.formatToParts(instant.ms).find((part) => part.type === 'timeZoneName').value;
    const offset = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
    return offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3]) * 60) : 0;
  } };
}

export function gymRefusalError(refused) {
  if (refused.kind === 'invalid') {
    const violation = refused.violation;
    let sentence;
    if (violation.rule === 'weighin.day') sentence = violation.reason.custom === 'future' ? REFUSALS.future : 'could not read that date';
    if (violation.rule === 'weighin.kg') sentence = violation.reason.kind === 'notANumber' ? REFUSALS.notNumber : REFUSALS.bounds;
    if (['exercise.name', 'exerciseName.name', 'routine.name'].includes(violation.rule)) {
      if (['blank', 'tooShort'].includes(violation.reason.kind)) sentence = violation.rule === 'routine.name' ? NAME_IT_TO_SAVE_IT : 'A movement needs a name.';
      if (violation.reason.kind === 'tooLong') sentence = 'A name runs to 60 characters.';
    }
    return new GymRefusal('invalid', { sentence });
  }
  if (refused.kind === 'future') return new GymRefusal('bad-instant', { sentence: REFUSALS.future });
  const code = refused.refused?.code ?? ({ gone: 'record-dead', taken: 'id-taken', full: 'cap' }[refused.kind] ?? refused.kind);
  return new GymRefusal(code, code === 'stale' ? { sentence: 'This changed on another device. Read it again before saving.' } : {});
}

export function exerciseDocument(value) {
  return { id: value.id.record, ...value.fields(), custom: !SeedExercises.all.some((seed) => seed.id.equals(value.id)),
    ...(value.aliases.length ? { aliases: [...value.aliases] } : {}) };
}

export function routineValue(document) {
  return Routine.decode(Fields.values('routine', document.id, document));
}

export function routineDocument(value) {
  return { id: value.id.record, ...value.fields() };
}

export function routineFromWorkout({ id, ...workout }) {
  return routineDocument(RoutineValue.fromSession({ ...workout, id: new Id(id, Routine) }));
}

// Decimal syntax and units belong to the field; the domain validates the day and kilograms.
export function weighInKilograms(text, unit = weightUnit()) {
  const raw = (text ?? '').trim().replace(/,/g, '.');
  if ((raw.match(/\./g) ?? []).length > 1) return { refusal: REFUSALS.decimals };
  if (!/^\d*\.?\d*$/.test(raw) || !/\d/.test(raw)) return { refusal: REFUSALS.notNumber };
  return { weightKg: fromDisplayUnit(Number(raw), unit) };
}

export function weighInInput(text, date, moment = gymMoment(), unit = weightUnit()) {
  const parsed = weighInKilograms(text, unit);
  if (parsed.refusal) return parsed;
  try {
    const valid = new Valid(new WeighInValue(new Id(date, WeighIn), parsed.weightKg), moment);
    return { dateLocal: date, weightKg: valid.value.kg };
  } catch (error) {
    if (error instanceof Violation) return { refusal: gymRefusalError(GymRefusals.ofViolation(error)).sentence };
    throw error;
  }
}

export function preferencesDocument(read) {
  const id = new Id('prefs', Preferences);
  const value = read.repository(Preferences).find(id, 'drawn') ?? new PreferencesValue(id);
  const rest = restSettings(read);
  return { ...value.fields(), restSound: rest.sound, ...(rest.seconds === null ? {} : { restSeconds: rest.seconds }) };
}

export function bodyweightDocument(read, { from, to } = {}, weights = new Bodyweight(read)) {
  const repo = read.repository(WeighIn);
  const form = (entry) => ({ dateLocal: entry.day.text, weightKg: entry.kg,
    recordedAt: repo.find(Id.ofDay(entry.day, WeighIn), 'drawn')?.recordedAt?.ms ?? null });
  return { entries: weights.list(from ? LocalDay.parse(from) : null, to ? LocalDay.parse(to) : null).map(form),
    latest: weights.reading ? form(weights.reading.entry) : null };
}

export function createGymRuntime(engine, { event = gymStep, failure = gymFailure, zone = deviceZone } = {}) {
  const owner = engine.activeReplica();
  const port = new EngineReplica(engine);
  const checkOwner = (replica = engine.activeReplica()) => {
    if (replica !== owner) throw new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' });
  };
  const runner = new ActionRunner({
    commit: (scope, body) => port.commit(scope, (views) => {
      checkOwner(views.replica);
      return body(views);
    }),
    read: (scope) => { checkOwner(); return port.read(scope); },
    undo: (id) => port.undo(id),
    mintId: (type, taken) => port.mintId(type, taken),
    physNow: () => port.physNow(),
    dismissNotice: (id) => port.dismissNotice(id),
  }, engine.registry, zone);
  const boundary = async (operation, body) => {
    try { return await body(); }
    catch (thrown) {
      const error = thrown instanceof CommitError && thrown.kind === 'not-writable'
        ? new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' }) : thrown;
      event(operation, error instanceof GymRefusal ? 'refused' : 'failed');
      if (!(error instanceof GymRefusal) && !isStoreFailure(error)) failure(operation);
      throw error;
    }
  };
  const read = (body) => {
    try { return runner.read(SCOPE, body); }
    catch (error) { if (!(error instanceof GymRefusal)) failure('projection'); throw error; }
  };
  const saveRoutine = async (operation, draft) => {
    const saved = await runner.save(draft, GymRefusals);
    if (saved.result.kind === 'failed') throw saved.result.error;
    if (saved.result.kind === 'refused') throw gymRefusalError(saved.result.refusal);
    event(operation, saved.result.receipt ? 'saved-local' : 'unchanged');
    return routineDocument(saved.draft.current);
  };
  return {
    read,
    createRoutine: (document) => boundary('routine-create', () => {
      const value = routineValue(document);
      return saveRoutine('routine-create', Draft.new(new RoutineValue(value.id)).edit(() => value));
    }),
    replaceRoutine: (id, document, base) => boundary('routine-save', () => {
      if (!base || base.id !== id) throw new GymRefusal('stale');
      return saveRoutine('routine-save', Draft.opening(routineValue(base)).edit(() => routineValue({ ...document, id })));
    }),
    createExercise: (document) => boundary('exercise-create', async () => {
      const id = new Id(document.id, Exercise);
      const outcome = await runner.run(new CreateExercise(new ExerciseValue(id, document.name,
        document.pattern, document.equipment, document.stepKg === undefined ? defaultStepKg(document.equipment) : document.stepKg)));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('exercise-create', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => ({ ...exerciseDocument(new Catalogue(reader).find(id)), aliases: [] }));
    }),
    renameExercise: (record, name) => boundary('exercise-rename', async () => {
      const id = new Id(record, Exercise);
      const outcome = await runner.run(new RenameExercise(id, name));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('exercise-rename', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => exerciseDocument(new Catalogue(reader).find(id)));
    }),
    deleteRoutine: (record) => boundary('delete', async () => {
      const outcome = await runner.run(DeleteRoutine(new Id(record, Routine)));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('delete', outcome.kind === 'committed' ? 'held' : 'unchanged');
      return outcome.kind === 'committed' ? outcome.receipt.gestureId : null;
    }),
    bodyweight: async (bounds) => read((reader) => bodyweightDocument(reader, bounds)),
    preferences: async () => read(preferencesDocument),
    saveBodyweight: (date, { weightKg }) => boundary('bodyweight-save', async () => {
      const id = new Id(date, WeighIn);
      const draft = runner.openOrNew(WeighIn, id, new WeighInValue(id))
        .edit((value) => new WeighInValue(value.id, weightKg, value.recordedAt));
      const saved = await runner.save(draft, GymRefusals);
      if (saved.result.kind === 'failed') throw saved.result.error;
      if (saved.result.kind === 'refused') throw gymRefusalError(saved.result.refusal);
      event('bodyweight-save', saved.result.receipt ? 'saved-local' : 'unchanged');
      return { dateLocal: date, weightKg: saved.draft.current.kg, recordedAt: saved.draft.current.recordedAt.ms };
    }),
    savePreferences: (patch) => boundary('preferences-save', async () => {
      const outcome = await runner.run(ChangePreferences(patch));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('preferences-save', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return outcome.result.fields();
    }),
    deleteBodyweight: (date) => boundary('delete', async () => {
      const outcome = await runner.run(DeleteWeighIn(new Id(date, WeighIn)));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('delete', outcome.kind === 'committed' ? 'held' : 'unchanged');
      return outcome.kind === 'committed' ? outcome.receipt.gestureId : null;
    }),
  };
}
