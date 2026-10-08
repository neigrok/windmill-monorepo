import { useMemo } from 'react';
import { Decision } from '../../platform/domain-kit/actions.js';
import { Draft } from '../../platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id, sameJson } from '../../platform/domain-kit/entities.js';
import { Plan } from '../../platform/domain-kit/plans.js';
import { Placement, Reader, Views } from '../../platform/domain-kit/reading.js';
import { Refused } from '../../platform/domain-kit/refusals.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { Remove } from '../../platform/domain-kit/standardActions.js';
import { Instant, LocalDay, Moment } from '../../platform/domain-kit/time.js';
import { Valid } from '../../platform/domain-kit/validation.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { CommitError } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { registry } from '../../platform/sync/schema.js';
import { useSyncEngine, useSyncRecords } from '../../platform/sync/react.js';
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
import { proposalDocument, proposalsDocument, sessionDocument, setDocument, TrainingHistory } from './domain/trainingHistory.js';
import { Session, SessionRules, TrainingSet } from './domain/training.js';
import { CorrectedSet, CorrectSession, CorrectSet, DeleteSet, ImportedSet, ImportSession } from './domain/trainingActions.js';
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
const WORKOUT_DRAFTS = 'rack:workoutDrafts';

function sameWorkoutCommand(left, right) {
  if (!left || !right || left.name !== right.name) return false;
  if (left.name === 'gym.importSession') return left.args.id === right.args.id;
  return left.name === 'gym.correctSession' && left.args.sessionId === right.args.sessionId
    && left.args.requestId === right.args.requestId;
}

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

function reportUnreadablePlans(views, failure, checked = new WeakSet()) {
  let unreadable = false;
  for (const view of [views.drawn, views.stored]) for (const record of view.values()) {
    const register = record.f?.plan;
    if (record.t !== 'session' || register?.[0] == null || checked.has(register)) continue;
    checked.add(register);
    try { PlanSnapshot.decode(register[0]); }
    catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      unreadable = true;
    }
  }
  if (unreadable) failure('projection');
}

function readGym(load, body, failure, checked) {
  try { return load((reader) => { reportUnreadablePlans(reader.views, failure, checked); return body(reader); }); }
  catch (error) {
    if (!(error instanceof GymRefusal)) failure('projection');
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
  if (refused.kind === 'badInstant') return new GymRefusal('bad-instant', { sentence: 'These times run outside the workout.' });
  if (refused.kind === 'sessionOpen') return new GymRefusal('session-open', { sentence: 'that session is still running' });
  if (refused.kind === 'sessionOverlap') return new GymRefusal('session-overlap', {
    sentence: 'these times cross a session already in the log', overlapping: refused.refused.detail?.session ?? null,
  });
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

export function gymWorkoutResult(replica, context, result) {
  const entry = replica.entries(SCOPE).find((entry) => entry.state === 'sent' && entry.n === result.n);
  if (!entry?.intent.cmd) return;
  for (const receipt of Object.values(replica.deviceRows('gym')[WORKOUT_DRAFTS] ?? {})) {
    if (receipt.status !== 'pending' || !sameWorkoutCommand(receipt.command, entry.intent.cmd)) continue;
    if (result.s === 'ok') receipt.status = 'accepted';
    if (result.s === 'refused' && !['clock-skew', 'base-unknown'].includes(result.code)) {
      receipt.status = 'refused'; receipt.code = result.code; receipt.detail = result.detail ?? null;
    }
  }
}

export function gymCommandResult(replica, context, result) {
  gymProposalResult(replica, context, result);
  gymWorkoutResult(replica, context, result);
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

export function createGymApi(engine, { event = gymStep, failure = gymFailure, zone = deviceZone } = {}) {
  const owner = engine.activeReplica();
  if (shownRemovals.get(engine)?.owner !== owner) shownRemovals.set(engine, { owner, proposals: new Map() });
  const shown = shownRemovals.get(engine).proposals;
  const checkedPlans = new WeakSet();
  const port = new EngineReplica(engine);
  const checkOwner = (replica = engine.activeReplica()) => {
    if (replica !== owner) throw new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' });
  };
  const runner = new ActionRunner({
    commit: (scope, body) => port.commit(scope, (views) => {
      checkOwner(views.replica);
      reportUnreadablePlans(views, failure, checkedPlans);
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
  const read = (body) => readGym((loaded) => runner.read(SCOPE, loaded), body, failure, checkedPlans);
  const workoutSave = (key) => read((reader) => {
    const receipt = reader.device(WORKOUT_DRAFTS)?.[key];
    if (!receipt) return null;
    let result = receipt;
    if (receipt.status === 'pending') {
      const queued = reader.commands().find((entry) => sameWorkoutCommand(entry.command, receipt.command));
      if (queued?.isAdmitted) result = { ...receipt, status: 'accepted' };
      if (!queued) {
        const notice = engine.observe(SCOPE).getSnapshot().notices.findLast((notice) => sameWorkoutCommand(notice.content?.cmd, receipt.command)
          || notice.content?.dependents?.some((part) => sameWorkoutCommand(part.cmd, receipt.command)));
        if (notice) result = { ...receipt, status: 'refused', code: notice.code, detail: notice.detail ?? null };
      }
    }
    if (result.status !== 'refused') return { ...result, error: null };
    const error = gymRefusalError(GymRefusals.ofRefused(new Refused(result.code, { t: 'session', id: result.sessionId }, result.detail, 'notice')));
    if (result.code === 'session-overlap' && result.detail?.sessionId) {
      error.overlapping = new TrainingHistory(reader).session(result.detail.sessionId)?.session ?? { id: result.detail.sessionId };
    }
    if (result.code === 'invalid' || result.code === 'bad-instant') error.sentence = 'The log couldn’t accept this workout. Check its date, times and sets, then try again.';
    if (['unknown-record', 'record-dead'].includes(result.code)) error.sentence = 'This workout is no longer in the log. Your edits are still here.';
    return { ...result, error };
  });
  // A form checks the transaction's current log and keeps its exact draft beside the queued command.
  const savingWorkout = (action, input, record, { draftKey, draft } = {}) => ({ ...action,
    load: (reader) => {
      const sets = reader.repository(TrainingSet).all('stored');
      return { loaded: action.load(reader), sessions: reader.repository(Session).all('stored').map((session) => SessionRules.drawn(session, sets, reader.moment.now)),
        visible: reader.repository(Session).all('drawn'), now: reader.moment.now.ms,
        receipts: reader.device(WORKOUT_DRAFTS) ?? {}, commands: reader.commands() };
    },
    decide: ({ loaded, sessions, visible, now, receipts, commands }) => {
      const decided = action.decide(loaded);
      if (decided.kind !== 'write') return decided;
      const previous = draftKey ? receipts[draftKey] : null;
      if (previous?.status === 'pending' && commands.some((entry) => sameWorkoutCommand(entry.command, previous.command))) {
        if (sameJson(previous.command, decided.plan.command)) return Decision.unchanged(decided.result);
        throw new GymRefusal('save-pending', { sentence: 'A workout from this form is still waiting for the log. Wait for it before saving again.' });
      }
      if (record) {
        const current = visible.find((session) => session.id.record === record);
        if (!current) throw new GymRefusal('unknown-record', { sentence: 'This workout is no longer in the log. Your edits are still here.' });
        if (current.isOpen) throw new GymRefusal('session-open', { sentence: 'That workout is still running. Finish it before editing it.' });
      }
      if (input.finishedAt > now) throw new GymRefusal('bad-instant', { sentence: 'These times run past now.' });
      const overlapping = sessions.find((session) => session.id.record !== (record ?? input.id)
        && input.startedAt < Math.max(session.finishedAt?.ms ?? now, session.startedAt.ms + 1)
        && session.startedAt.ms < Math.max(input.finishedAt, input.startedAt + 1));
      if (overlapping) throw new GymRefusal('session-overlap', { sentence: 'These times cross a workout already in the log.',
        overlapping: sessionDocument(overlapping) });
      if (draftKey) decided.plan.device(WORKOUT_DRAFTS, { ...receipts, [draftKey]: { status: 'pending',
        sessionId: record ?? input.id, command: decided.plan.command, draft: structuredClone(draft) } });
      return decided;
    },
  });
  const remove = (action) => boundary('delete', async () => {
    const outcome = await runner.run(action);
    if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
    event('delete', outcome.kind === 'committed' ? 'held' : 'unchanged');
    return outcome.kind === 'committed' ? outcome.receipt.gestureId : null;
  });
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
    workoutSave,
    workoutSaves: () => read((reader) => Object.keys(reader.device(WORKOUT_DRAFTS) ?? {}).map((key) => ({ key, ...workoutSave(key) }))),
    clearWorkoutSave: (key, expectedCommand = null) => boundary('session-correct', async () => {
      await runner.run({ scope: SCOPE, refusals: GymRefusals,
        load: (reader) => ({ receipts: reader.device(WORKOUT_DRAFTS) ?? {}, commands: reader.commands() }),
        decide: ({ receipts, commands }) => {
          const current = receipts[key];
          if (!current || (expectedCommand && !sameJson(expectedCommand, current.command))
            || (current.status === 'pending' && commands.some((entry) => !entry.isAdmitted && sameWorkoutCommand(entry.command, current.command)))) return Decision.unchanged(null);
          const { [key]: removed, ...rest } = receipts;
          const plan = new Plan(); plan.device(WORKOUT_DRAFTS, Object.keys(rest).length ? rest : null);
          return Decision.write(plan, null);
        },
      });
    }),
    ...Object.fromEntries(['exercises', 'sessions', 'session', 'review', 'routines', 'routine',
      'history', 'progress', 'record', 'lastTime', 'lastSets', 'stats'].map((name) => [name, async (...args) => read((reader) => {
      const source = name === 'history' && args[0]?.timeZone
        ? new Reader(reader.views, SCOPE, new Moment(reader.moment.now, namedZone(args[0].timeZone))) : reader;
      const history = new TrainingHistory(source);
      const document = history[name](...args);
      return name === 'history' && args[0]?.projection === 'progress'
        ? { ...document, progress: history.progressIn(args[0]) } : document;
    })])),
    importSession: (input, draft) => boundary('session-import', async () => {
      const id = new Id(input.id, Session);
      const outcome = await runner.run(savingWorkout(ImportSession({ id, startedAt: new Instant(input.startedAt), finishedAt: new Instant(input.finishedAt),
        routineId: input.routineId == null ? null : new Id(input.routineId, Routine),
        sets: input.sets.map((set) => new ImportedSet({ ...set, id: new Id(set.id, TrainingSet), exerciseId: new Id(set.exerciseId, Exercise),
          completedAt: new Instant(set.completedAt), rpeNamed: Object.hasOwn(set, 'rpe') })) }), input, null, draft));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('session-import', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => new TrainingHistory(reader).session(input.id));
    }),
    correctSession: (record, input, draft) => boundary('session-correct', async () => {
      const outcome = await runner.run(savingWorkout(CorrectSession({ ...input, id: new Id(record, Session),
        startedAt: new Instant(input.startedAt), finishedAt: new Instant(input.finishedAt),
        sets: input.sets.map((set) => new CorrectedSet({ ...set, id: new Id(set.id, TrainingSet), exerciseId: new Id(set.exerciseId, Exercise),
          completedAt: new Instant(set.completedAt), rpeNamed: Object.hasOwn(set, 'rpe') })) }), input, record, draft));
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('session-correct', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => new TrainingHistory(reader).session(record));
    }),
    fixSet: (sessionId, record, fix) => boundary('set-correct', async () => {
      const id = new Id(record, TrainingSet);
      const outcome = await runner.run({ scope: SCOPE, refusals: GymRefusals,
        load: (reader) => {
          const current = reader.repository(TrainingSet).find(id, 'drawn');
          if (current === null || current.sessionId.record !== sessionId) return null;
          const value = TrainingSet.decode(Fields.values('set', record, { ...current.fields(), setNumber: current.setNumber, ...fix }));
          const action = CorrectSet(value);
          return { action, loaded: action.load(reader) };
        },
        decide: (loaded) => loaded === null
          ? Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted')))
          : loaded.action.decide(loaded.loaded),
      });
      if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
      event('set-correct', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => setDocument(reader.repository(TrainingSet).find(id, 'drawn')));
    }),
    holdDeath: (type, record) => {
      const entity = { note: Note, routine: Routine, weighin: WeighIn, session: Session, set: TrainingSet }[type];
      const id = new Id(record, entity);
      return remove(type === 'set' ? DeleteSet(id) : new Remove(id, GymRefusals));
    },
    undoDeath: (gestureId) => boundary('undo', async () => {
      checkOwner();
      const undone = await runner.undo(gestureId);
      event('delete', undone ? 'undone' : 'closed');
      return undone;
    }),
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
    deleteNote: (id) => remove(DeleteNote(new Id(id, Note))),
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
    deleteRoutine: (record) => remove(DeleteRoutine(new Id(record, Routine))),
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
    deleteBodyweight: (date) => remove(DeleteWeighIn(new Id(date, WeighIn))),
  };
}

export function useGymApi() {
  const engine = useSyncEngine();
  const records = useSyncRecords(SCOPE);
  const ready = records.firstPullComplete || records.drawn.length > 0;
  return useMemo(() => engine ? { ...createGymApi(engine), ready } : null, [engine, records.replica, ready]);
}

// A workout running on a phone keeps the mirror's sync close, until four idle hours close it.
export function gymLiveHint(engine, replica) {
  return gymReadView(engine.observe(SCOPE).getSnapshot(), {
    now: Date.now() + (replica?.meta?.serverOffsetMs ?? 0),
  }).liveHint();
}
