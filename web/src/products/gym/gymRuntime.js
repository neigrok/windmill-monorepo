import { Decision } from '../../platform/domain-kit/actions.js';
import { Draft } from '../../platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id } from '../../platform/domain-kit/entities.js';
import { Placement, Reader, Views } from '../../platform/domain-kit/reading.js';
import { Refused } from '../../platform/domain-kit/refusals.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { Instant, LocalDay, Moment } from '../../platform/domain-kit/time.js';
import { Valid } from '../../platform/domain-kit/validation.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { CommitError } from '../../platform/sync/client/commit.js';
import { registry } from '../../platform/sync/schema.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { Bodyweight, DeleteWeighIn, WeighIn, WeighInValue } from './domain/bodyweight.js';
import { Catalogue, CreateExercise, Exercise, ExerciseValue, RenameExercise, defaultStepKg } from './domain/catalogue.js';
import { GymRefusals } from './domain/gymRules.js';
import { DeleteNote, MoveNote, Note, NoteRules, NoteValue } from './domain/notes.js';
import { ChangePreferences, Preferences, PreferencesValue, restSettings } from './domain/preferences.js';
import { DeleteRoutine, PlanSnapshot, Routine, RoutineValue } from './domain/routines.js';
import { AcknowledgeRoutineRemoval, ApplyProposalKeepingReceipt, DismissProposal, Proposal,
  REMOVAL_RECEIPTS, removalReceipts } from './domain/proposals.js';
import { SeedExercises } from './domain/seedExercises.js';
import { proposalDocument, proposalsDocument, TrainingHistory } from './domain/trainingHistory.js';
import { GymRefusal, isStoreFailure } from './errors.js';
import { REFUSALS } from './bodyweight/bodyweight.js';
import { FULL_LINE } from './notes/notes.js';
import { NAME_IT_TO_SAVE_IT } from './routines.js';
import { fromDisplayUnit, weightUnit } from './units.js';

const SCOPE = 'self/gym';
const OPERATIONS = new Set(['routine-create', 'routine-save', 'exercise-create', 'exercise-rename',
  'preferences-save', 'note-save', 'note-reorder', 'bodyweight-save', 'set-correct', 'delete', 'undo',
  'session-import', 'session-correct', 'proposal-apply', 'proposal-dismiss', 'refusal']);
const OUTCOMES = new Set(['saved-local', 'unchanged', 'failed', 'held', 'undone', 'closed', 'refused']);
const shownRemovals = new WeakMap();

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

function withoutMalformedPlans(read) {
  let changed = false;
  const clean = (records) => new Map([...records].map(([key, record]) => {
    if (record.t !== 'session') return [key, record];
    try { PlanSnapshot.decode(Fields.record(record).json('plan')); return [key, record]; }
    catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      changed = true;
      const { plan, ...f } = record.f;
      return [key, { ...record, f }];
    }
  }));
  const drawn = clean(read.views.drawn); const stored = clean(read.views.stored);
  return changed ? new Reader(new Views(read.registry, { ...read.views, drawn, stored }), SCOPE, read.moment) : null;
}

function readGym(load, body, failure) {
  let read;
  try { return load((reader) => { read = reader; return body(reader); }); }
  catch (error) {
    if (!(error instanceof GymRefusal)) failure('projection');
    if (read && error instanceof DecodeError) {
      const repaired = withoutMalformedPlans(read);
      if (repaired) return body(repaired);
    }
    throw error;
  }
}

export function gymReadView(snapshot, { now = Date.now(), zone = deviceZone, failure = gymFailure } = {}) {
  return readGym((body) => body(new Reader(Views.ofRecords(registry, snapshot), SCOPE, new Moment(new Instant(now), zone))),
    (reader) => new TrainingHistory(reader), failure);
}

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
    if (violation.rule === 'note.title' && violation.reason.kind === 'blank') sentence = 'a note needs a title';
    if (violation.rule === 'note.title' && violation.reason.kind === 'tooLong') sentence = `a title runs to ${NoteRules.title.max} characters`;
    if (violation.rule === 'note.body' && violation.reason.kind === 'tooLong') sentence = `a note runs to ${NoteRules.body.max} bytes`;
    if (['exercise.name', 'exerciseName.name', 'routine.name'].includes(violation.rule)) {
      if (['blank', 'tooShort'].includes(violation.reason.kind)) sentence = violation.rule === 'routine.name' ? NAME_IT_TO_SAVE_IT : 'A movement needs a name.';
      if (violation.reason.kind === 'tooLong') sentence = 'A name runs to 60 characters.';
    }
    return new GymRefusal('invalid', { sentence });
  }
  if (refused.kind === 'future') return new GymRefusal('bad-instant', { sentence: REFUSALS.future });
  if (refused.kind === 'full' && refused.type === 'note') return new GymRefusal('cap', { sentence: FULL_LINE });
  if (refused.kind === 'proposalSuperseded') return new GymRefusal('proposal-superseded', { sentence: 'That proposal has been superseded.' });
  if (refused.kind === 'proposalSettled') return new GymRefusal('proposal-settled', { sentence: 'That proposal has already been settled.' });
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

// Command results and the snapshot commit together, before the engine retires the queued command.
export function gymProposalResult(replica, context, result) {
  const entry = replica.entries(SCOPE).find((entry) => entry.state === 'sent' && entry.n === result.n);
  if (entry?.intent.cmd?.name !== 'gym.applyProposal') return;
  const receipt = replica.deviceRows('gym')[REMOVAL_RECEIPTS]?.[entry.intent.cmd.args.proposalId];
  if (!receipt) return;
  if (result.s === 'ok') receipt.status = 'applied';
  if (result.s === 'refused' && !['clock-skew', 'base-unknown'].includes(result.code)) {
    receipt.status = 'refused'; receipt.code = result.code; receipt.detail = result.detail ?? null;
  }
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

export function notesDocument(read) {
  const notes = read.repository(Note);
  const stored = notes.all('stored');
  return notes.all('drawn').map((note) => ({ id: note.id.record, position: stored.findIndex((each) => each.id.equals(note.id)),
    ...note.fields(), ...(note.updatedAt === null ? {} : { updatedAt: note.updatedAt.ms }) }));
}

export function noteDraft(note) {
  if (note.draft) return note.draft;
  const id = new Id(note.id, Note);
  return note.fresh ? Draft.new(new NoteValue(id), Placement.bottom)
    : Draft.opening(new NoteValue(id, note.title, note.body));
}

export function createGymRuntime(engine, { event = gymStep, failure = gymFailure, zone = deviceZone } = {}) {
  const owner = engine.activeReplica();
  if (shownRemovals.get(engine)?.owner !== owner) shownRemovals.set(engine, { owner, proposals: new Map() });
  const shown = shownRemovals.get(engine).proposals;
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
  const read = (body) => readGym((loaded) => runner.read(SCOPE, loaded), body, failure);
  const saveRoutine = async (operation, draft) => {
    const saved = await runner.save(draft, GymRefusals);
    if (saved.result.kind === 'failed') throw saved.result.error;
    if (saved.result.kind === 'refused') throw gymRefusalError(saved.result.refusal);
    event(operation, saved.result.receipt ? 'saved-local' : 'unchanged');
    return routineDocument(saved.draft.current);
  };
  const removalDocument = (reader, receipt) => ({ ...proposalDocument(reader, receipt.proposal),
    removalOutcome: receipt.outcome, removalOwner: owner,
    ...(receipt.outcome === 'refused' ? { removalRefusal: gymRefusalError(GymRefusals.ofRefused(new Refused(
      receipt.code, receipt.proposal.id.ref, receipt.detail, 'notice'))).sentence } : {}) });
  const proposal = (reader, record) => {
    const receipt = removalReceipts(reader).find((receipt) => receipt.proposal.id.record === record);
    if (receipt) return removalDocument(reader, receipt);
    return proposalDocument(reader, reader.repository(Proposal).find(new Id(record, Proposal), 'drawn')) ?? shown.get(record) ?? null;
  };
  const decideProposal = (record, applying) => boundary(applying ? 'proposal-apply' : 'proposal-dismiss', async () => {
    const id = new Id(record, Proposal);
    const action = applying ? ApplyProposalKeepingReceipt(id) : DismissProposal(id);
    const outcome = await runner.run({ ...action,
      load: (reader) => ({ loaded: action.load(reader), current: proposal(reader, record) }),
      decide: ({ loaded, current }) => {
        const decided = action.decide(loaded);
        return decided.kind === 'unchanged' ? Decision.unchanged(current) : decided;
      },
    });
    if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
    event(applying ? 'proposal-apply' : 'proposal-dismiss', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
    const observed = read((reader) => proposal(reader, record));
    // An unchanged commit may precede publication; only the frozen creation time comes from the observation.
    return { proposal: outcome.kind === 'unchanged' && outcome.result
      ? { ...outcome.result, ...(observed?.createdAt === undefined ? {} : { createdAt: observed.createdAt }) } : observed };
  });
  return {
    read,
    proposals: async (filter) => read((reader) => proposalsDocument(reader, filter)),
    proposal: async (record) => read((reader) => proposal(reader, record)),
    applyProposal: (record) => decideProposal(record, true),
    dismissProposal: (record) => decideProposal(record, false),
    removalReceipts: async () => read((reader) => removalReceipts(reader).map((receipt) => removalDocument(reader, receipt))),
    removalReceiptShown: (record, replica, expectedOutcome = null) => boundary('proposal-apply', async () => {
      if (replica !== owner) return;
      const value = read((reader) => proposal(reader, record));
      if (!value?.removalOutcome || value.removalOutcome === 'pending'
        || (expectedOutcome !== null && value.removalOutcome !== expectedOutcome)) return;
      const previous = shown.get(record);
      shown.set(record, value);
      let acknowledged = false;
      try {
        const outcome = await runner.run(AcknowledgeRoutineRemoval(new Id(record, Proposal), value.removalOutcome));
        if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
        acknowledged = outcome.kind === 'committed';
        if (acknowledged) event('proposal-apply', 'closed');
      } finally {
        if (!acknowledged) { if (previous) shown.set(record, previous); else shown.delete(record); }
      }
    }),
    notes: async () => read(notesDocument),
    mintNote: () => { checkOwner(); return runner.mint(Note).record; },
    saveNote: (id, { title, body }, base) => boundary('note-save', async () => {
      const draft = (base instanceof Draft ? base : noteDraft(base ?? { id, fresh: true }))
        .edit((value) => new NoteValue(value.id, title, body, value.updatedAt));
      if (draft.id.record !== id) throw new Error('a note draft saves its own record');
      const saved = await runner.save(draft, GymRefusals);
      if (saved.result.kind === 'failed') throw saved.result.error;
      if (saved.result.kind === 'refused') throw gymRefusalError(saved.result.refusal);
      event('note-save', saved.result.receipt ? 'saved-local' : 'unchanged');
      return { ...read(notesDocument).find((note) => note.id === id), draft: saved.draft };
    }),
    moveNote: (id, below) => boundary('note-reorder', async () => {
      const outcome = await runner.run(MoveNote(new Id(id, Note), below === null ? null : new Id(below, Note)));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('note-reorder', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read(notesDocument);
    }),
    deleteNote: (id) => boundary('delete', async () => {
      const outcome = await runner.run(DeleteNote(new Id(id, Note)));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('delete', outcome.kind === 'committed' ? 'held' : 'unchanged');
      return outcome.kind === 'committed' ? outcome.receipt.gestureId : null;
    }),
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
