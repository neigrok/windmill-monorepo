import { useMemo } from 'react';
import { Decision } from '../../platform/domain-kit/actions.js';
import { ActDecision, scopedAct } from '../../platform/domain-kit/acts.js';
import { Draft } from '../../platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id, sameJson } from '../../platform/domain-kit/entities.js';
import { Plan } from '../../platform/domain-kit/plans.js';
import { Placement, Reader, Views } from '../../platform/domain-kit/reading.js';
import { DomainNotice, Refused } from '../../platform/domain-kit/refusals.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { Remove } from '../../platform/domain-kit/standardActions.js';
import { Instant, LocalDay, Moment } from '../../platform/domain-kit/time.js';
import { Valid } from '../../platform/domain-kit/validation.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { CommitError } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { ReplicaChanged } from '../../platform/sync/engine.js';
import { registry } from '../../platform/sync/schema.js';
import { useSyncRecords, useSyncReplica } from '../../platform/sync/react.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { countBucket } from '../../telemetry/countBucket.js';
import { Bodyweight, DeleteWeighIn, WeighIn, WeighInValue } from './domain/bodyweight.js';
import { Catalogue, CreateExercise, Exercise, ExerciseValue, RenameExercise, defaultStepKg } from './domain/catalogue.js';
import { GymRefusals, RoutineRules } from './domain/gymRules.js';
import { DeleteNote, MoveNote, Note, NoteRules, NoteValue } from './domain/notes.js';
import { ChangePreferences, Preferences, PreferencesValue, restSettings } from './domain/preferences.js';
import { DeleteRoutine, PlanSnapshot, Routine, RoutineValue, SetTarget } from './domain/routines.js';
import { AcknowledgeRoutineRemoval, ApplyProposalKeepingReceipt, DismissProposal, Proposal, ProposalState,
  REMOVAL_RECEIPTS, removalReceipts } from './domain/proposals.js';
import { exerciseDocument, proposalDocument, proposalsDocument, sessionDocument, setDocument, TrainingHistory } from './domain/trainingHistory.js';
import { Session, SessionRules, SetRules, TrainingSet } from './domain/training.js';
import { AppendSet, CorrectedSet, CorrectSession, CorrectSet, DeleteSet, ImportedSet, ImportSession } from './domain/trainingActions.js';
import { AdoptWorkout, ReconcileAdoptedWorkouts, SignedOutWorkout } from './domain/workoutAdoption.js';
import { DiscardSignedOutWorkout, RecoverStrandedSets, SaveRefusedStart, WorkoutFix, WorkoutRecovery } from './domain/workoutRecovery.js';
import { ReissueWorkoutProposal } from './domain/workoutProposals.js';
import { TrainingLog } from './domain/trainingReads.js';
import { PlanOperations } from './domain/workoutPlan.js';
import { FinishWorkout, LogRackSet, ReviseWorkout, SettleRack, StartWorkout, TurnRack } from './domain/workoutRack.js';
import { GymRefusal, isStoreFailure } from './errors.js';
import { REFUSALS } from './bodyweight/bodyweight.js';
import { fixLoadFloorLine } from './fix.js';
import { agoLabel, daysAgo, NO_ROUTINE, shortDayLabel } from './log.js';
import { t } from './i18n/entry/index.js';
import { FULL_LINE } from './notes/notes.js';
import { loadFloorLine, NAME_IT_TO_SAVE_IT } from './routines.js';
import { fromDisplayUnit, weightUnit } from './units.js';

const SCOPE = 'self/gym';
const OPERATIONS = new Set(['routine-create', 'routine-save', 'exercise-create', 'exercise-rename',
  'preferences-save', 'note-save', 'note-reorder', 'bodyweight-save', 'set-correct', 'delete', 'undo',
  'session-import', 'session-correct', 'proposal-apply', 'proposal-dismiss', 'workout-adopt', 'workout-recover', 'refusal',
  'workout-start', 'rack-settle', 'rack-turn', 'set-log', 'plan-revise', 'workout-finish', 'pop-out']);
const OUTCOMES = new Set(['saved-local', 'unchanged', 'failed', 'held', 'undone', 'closed', 'refused']);
// What refused a write: the replica moved under the room, or the gym's rules, this device's or the server's.
const REFUSED_BY = new Set(['not-writable', 'domain']);
const shownRemovals = new WeakMap();
const WORKOUT_DRAFTS = 'rack:workoutDrafts';

function sameWorkoutCommand(left, right) {
  if (!left || !right || left.name !== right.name) return false;
  if (left.name === 'gym.importSession') return left.args.id === right.args.id;
  return left.name === 'gym.correctSession' && left.args.sessionId === right.args.sessionId
    && left.args.requestId === right.args.requestId;
}

// A refused step names what refused it, and no other step names anything.
export function gymStep(operation, outcome, code = null) {
  if (!OPERATIONS.has(operation) || !OUTCOMES.has(outcome) || (outcome === 'refused') !== REFUSED_BY.has(code)) return;
  try { track('gym_action', code === null ? { operation, outcome } : { operation, outcome, code }); } catch { /* reporting cannot stop a save */ }
}

// How a copy's recovery ended (web-device-parity §10): `saved` when a start that lost a race keeps its sets, `kept`, `retried`
// or `discarded` as the person answered the copy, `refused` or `failed` when the answer did not land, each with the reason
// the copy waited for, a bounded label of the review's.
const RECOVERY_OUTCOMES = new Set(['saved', 'kept', 'retried', 'discarded', 'refused', 'failed']);
const RECOVERY_REASONS = new Set(['session-open', 'session-overlap', 'id-taken', 'bad-instant', 'too-many-sets', 'invalid-set',
  'unknown-exercise', 'session-finished', 'unsent', 'other']);
export function gymRecovery(outcome, reason) {
  if (!RECOVERY_OUTCOMES.has(outcome) || !RECOVERY_REASONS.has(reason)) return;
  try { track('gym_recovery', { outcome, reason }); } catch { /* reporting cannot stop a recovery */ }
}

// A workout's steps, told under the iPhone's event names (web-device-parity §10), each property one of a closed set of
// labels: never a name or an id of a workout, a routine or a movement, and never a value.
const WORKOUT_LABELS = Object.freeze({
  screen: ['workout'],
  outcome: ['ok', 'refused', 'failed'],
  code: ['not-writable', 'domain'],
  reason: ['stale'],
  door: ['routine', 'empty', 'workout', 'bar'],
  action: ['retarget', 'add_set', 'remove_set', 'swap', 'add_movement', 'remove_movement', 'rest', 'hide', 'open'],
  field: ['weight', 'reps'],
});
const WORKOUT_STEPS = new Set(['gym_session_started', 'gym_set_logged', 'gym_session_finished', 'gym_workout_plan_changed',
  'gym_workout_adjusted', 'gym_workout_movement_chosen', 'gym_rest_target_reached', 'gym_hidden_workout', 'gym_workout_popped_out',
  'gym_receipt_plan_saved']);
export function workoutStep(name, props) {
  if (!WORKOUT_STEPS.has(name) || Object.entries(props).some(([key, value]) => !WORKOUT_LABELS[key]?.includes(value))) return;
  try { track(name, props); } catch { /* reporting cannot stop a workout */ }
}

// A failure goes to Sentry under its static operation with the error's stack frames, never its message.
export function gymFailure(operation, error) {
  if (!OPERATIONS.has(operation) && operation !== 'projection') return;
  try { captureError('gym', `gym-${operation}`, error?.stack ?? '', '/gym'); } catch { /* reporting cannot stop a save */ }
}

export const deviceZone = { offsetSeconds: (instant) => -new Date(instant.ms).getTimezoneOffset() * 60 };
export const gymMoment = (now = Date.now()) => new Moment(new Instant(now), deviceZone);

function reportUnreadablePlans(views, failure, checked = new WeakSet()) {
  let unreadable = null;
  for (const view of [views.drawn, views.stored]) for (const record of view.values()) {
    const register = record.f?.plan;
    if (record.t !== 'session' || register?.[0] == null || checked.has(register)) continue;
    checked.add(register);
    try { PlanSnapshot.decode(register[0]); }
    catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      unreadable ??= error;
    }
  }
  if (unreadable) failure('projection', unreadable);
}

function readGym(load, body, failure, checked) {
  try { return load((reader) => { reportUnreadablePlans(reader.views, failure, checked); return body(reader); }); }
  catch (error) {
    if (!(error instanceof GymRefusal)) failure('projection', error);
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

// `kept` is the stored load a refused fix leaves in place, where the call site knows it; a past workout or a session
// correction names the floor alone.
export function gymRefusalError(refused, { kept = null } = {}) {
  if (refused.kind === 'invalid') {
    const violation = refused.violation;
    if (violation.rule === SetRules.loadFloor) {
      const floor = violation.reason.min;
      return new GymRefusal('load-floor', { sentence: kept === null ? loadFloorLine(floor) : fixLoadFloorLine(floor, kept) });
    }
    if (violation.rule === RoutineRules.loadFloor) return new GymRefusal('load-floor', { sentence: loadFloorLine(violation.reason.min) });
    let sentence;
    if (violation.rule === 'weighin.day') sentence = violation.reason.custom === 'future' ? REFUSALS.future : t('gym.runtime.unreadableDate');
    if (violation.rule === 'weighin.kg') sentence = violation.reason.kind === 'notANumber' ? REFUSALS.notNumber : REFUSALS.bounds;
    if (violation.rule === 'note.title' && violation.reason.kind === 'blank') sentence = t('gym.runtime.noteNeedsTitle');
    if (violation.rule === 'note.title' && violation.reason.kind === 'tooLong') sentence = t('gym.runtime.noteTitleTooLong', { max: NoteRules.title.max });
    if (violation.rule === 'note.body' && violation.reason.kind === 'tooLong') sentence = t('gym.runtime.noteBodyTooLong', { max: NoteRules.body.max });
    if (['exercise.name', 'exerciseName.name', 'routine.name'].includes(violation.rule)) {
      if (['blank', 'tooShort'].includes(violation.reason.kind)) sentence = violation.rule === 'routine.name' ? NAME_IT_TO_SAVE_IT : t('gym.runtime.movementNeedsName');
      if (violation.reason.kind === 'tooLong') sentence = t('gym.runtime.nameTooLong');
    }
    return new GymRefusal('invalid', { sentence });
  }
  if (refused.kind === 'future') return new GymRefusal('bad-instant', { sentence: REFUSALS.future });
  if (refused.kind === 'badInstant') return new GymRefusal('bad-instant', { sentence: t('gym.runtime.outsideWorkout') });
  if (refused.kind === 'sessionOpen') return new GymRefusal('session-open', { sentence: t('gym.runtime.sessionRunning') });
  if (refused.kind === 'sessionOverlap') return new GymRefusal('session-overlap', {
    sentence: t('gym.runtime.sessionOverlap'), overlapping: refused.refused.detail?.session ?? null,
  });
  if (refused.kind === 'full' && refused.type === 'note') return new GymRefusal('cap', { sentence: FULL_LINE });
  if (refused.kind === 'proposalSuperseded') return new GymRefusal('proposal-superseded', { sentence: t('gym.runtime.proposalSuperseded') });
  if (refused.kind === 'proposalSettled') return new GymRefusal('proposal-settled', { sentence: t('gym.runtime.proposalSettled') });
  const code = refused.refused?.code ?? ({ gone: 'record-dead', taken: 'id-taken', full: 'cap' }[refused.kind] ?? refused.kind);
  return new GymRefusal(code, code === 'stale' ? { sentence: t('gym.runtime.stale') } : {});
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

// A sign-in or a sign-out moved the engine off the replica the API stands on, before a write or while it waited (the
// engine's `ReplicaChanged`); nothing in it asks a person to sign in.
const notWritable = () => new GymRefusal('not-writable', { sentence: t('gym.runtime.notWritable') });

// The API stands on the engine's binding as it is made: the replica's storage and its account, which a re-identify keeps.
// A sign-in or a sign-out changes it, the anon replica bound in place included, and every read and write then is refused.
export function createGymApi(engine, { event = gymStep, recovered = gymRecovery, told = workoutStep, failure = gymFailure, zone = deviceZone } = {}) {
  const owner = engine.activeBinding();
  if (shownRemovals.get(engine)?.owner !== owner) shownRemovals.set(engine, { owner, proposals: new Map() });
  const shown = shownRemovals.get(engine).proposals;
  const checkedPlans = new WeakSet();
  const port = new EngineReplica(engine);
  const checkOwner = (binding) => {
    if (binding !== owner) throw notWritable();
  };
  const runner = new ActionRunner({
    commit: (scope, body) => port.commit(scope, (views) => {
      checkOwner(views.binding);
      reportUnreadablePlans(views, failure, checkedPlans);
      return body(views);
    }),
    commitAct: (prepare, segment) => port.commitAct(prepare, segment, { binding: owner }),
    read: (scope) => {
      const views = port.read(scope);
      checkOwner(views.binding);
      return views;
    },
    cancelHeld: (id) => port.cancelHeld(id),
    mintId: (type, taken) => port.mintId(type, taken),
    opaqueID: () => port.opaqueID(),
    physNow: () => port.physNow(),
    dismissNotice: (id) => port.dismissNotice(id),
  }, engine.registry, zone);
  const boundary = async (operation, body) => {
    try { return await body(); }
    catch (thrown) {
      const moved = thrown instanceof ReplicaChanged || (thrown instanceof CommitError && thrown.kind === 'not-writable');
      const error = moved ? notWritable() : thrown;
      if (error instanceof GymRefusal) event(operation, 'refused', error.code === 'not-writable' ? 'not-writable' : 'domain');
      else event(operation, 'failed');
      if (!(error instanceof GymRefusal) && !isStoreFailure(error)) failure(operation, error);
      throw error;
    }
  };
  // A workout's write tells its step, once per label, with how it ended: `body` answers whether a step happened. A refusal
  // is told with what refused it and, when the workout moved under it, `stale`; an unexpected failure also goes to Sentry.
  const workoutWrite = async (operation, { step = null, labels = [{}] } = {}, body) => {
    const tell = (props) => { if (step) for (const label of labels) told(step, { ...label, ...props }); };
    try {
      const { happened, result } = await body();
      if (happened) tell({ outcome: 'ok' });
      return result;
    } catch (thrown) {
      const moved = thrown instanceof ReplicaChanged || (thrown instanceof CommitError && thrown.kind === 'not-writable');
      const error = moved ? notWritable() : thrown;
      if (error instanceof GymRefusal) {
        tell({ outcome: 'refused', code: error.code === 'not-writable' ? 'not-writable' : 'domain', ...(error.code === 'stale' ? { reason: 'stale' } : {}) });
      } else {
        tell({ outcome: 'failed' });
        if (!isStoreFailure(error)) failure(operation, error);
      }
      throw error;
    }
  };
  const ran = async (action) => {
    const outcome = await runner.run(action);
    if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
    return outcome;
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
    if (result.code === 'invalid' || result.code === 'bad-instant') error.sentence = t('gym.runtime.workoutInvalid');
    if (['unknown-record', 'record-dead'].includes(result.code)) error.sentence = t('gym.runtime.workoutGone');
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
        throw new GymRefusal('save-pending', { sentence: t('gym.runtime.savePending') });
      }
      if (record) {
        const current = visible.find((session) => session.id.record === record);
        if (!current) throw new GymRefusal('unknown-record', { sentence: t('gym.runtime.workoutGone') });
        if (current.isOpen) throw new GymRefusal('session-open', { sentence: t('gym.runtime.workoutRunning') });
      }
      if (input.finishedAt > now) throw new GymRefusal('bad-instant', { sentence: t('gym.runtime.pastNow') });
      const overlapping = sessions.find((session) => session.id.record !== (record ?? input.id)
        && input.startedAt < Math.max(session.finishedAt?.ms ?? now, session.startedAt.ms + 1)
        && session.startedAt.ms < Math.max(input.finishedAt, input.startedAt + 1));
      if (overlapping) throw new GymRefusal('session-overlap', { sentence: t('gym.runtime.workoutOverlap'),
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
  // The review's document: the shared proposal document plus the domain's Apply rule, never the proposal's state alone.
  const reviewDocument = (reader, value) => value === null ? null
    : { ...proposalDocument(reader, value), outOfDate: ProposalState.of(reader, value.id).outOfDate };
  const removalDocument = (reader, receipt) => ({ ...reviewDocument(reader, receipt.proposal),
    removalOutcome: receipt.outcome, removalOwner: owner,
    ...(receipt.outcome === 'refused' ? { removalRefusal: gymRefusalError(GymRefusals.ofRefused(new Refused(
      receipt.code, receipt.proposal.id.ref, receipt.detail, 'notice'))).sentence } : {}) });
  const proposal = (reader, record) => {
    const receipt = removalReceipts(reader).find((receipt) => receipt.proposal.id.record === record);
    if (receipt) return removalDocument(reader, receipt);
    return reviewDocument(reader, reader.repository(Proposal).find(new Id(record, Proposal), 'drawn')) ?? shown.get(record) ?? null;
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
  // Every notice of gym's scope as the domain reads it; the review hears only the live ones.
  const recoveryNotices = () => engine.observe(SCOPE).getSnapshot().notices.map((notice) => new DomainNotice(notice, engine.registry, GymRefusals));
  const reviewOf = (reader) => WorkoutRecovery.review(SignedOutWorkout.read(reader), recoveryNotices(), new TrainingLog(reader), new Catalogue(reader));
  // A copy's answer (In this browser, WD9.3): its review row's actions, run in order, then the notices the row named put away,
  // since the answer is theirs. Told as `gym_recovery` with the row's reason; a copy with no row is on its way and answers
  // nothing.
  const recover = (outcome, record, actionsOf) => (async () => {
    const row = read((reader) => reviewOf(reader).find((each) => String(each.id.record) === record)) ?? null;
    if (row === null) return false;
    try {
      for (const action of actionsOf(row)) {
        const done = await runner.run(action);
        if (done.kind === 'refused') throw gymRefusalError(done.refusal);
      }
      for (const id of row.noticeIds) await port.dismissNotice(id);
      recovered(outcome, row.reason);
      return true;
    } catch (thrown) {
      const moved = thrown instanceof ReplicaChanged || (thrown instanceof CommitError && thrown.kind === 'not-writable');
      const error = moved ? notWritable() : thrown;
      recovered(error instanceof GymRefusal ? 'refused' : 'failed', row.reason);
      if (!(error instanceof GymRefusal) && !isStoreFailure(error)) failure('workout-recover', error);
      throw error;
    }
  })();
  return {
    read,
    // Before the seat changes (`routes.sync.seatWillChange`), each workout the anon replica holds is saved for adoption, an
    // open one with its sets recorded again, as the phones do; a bound replica holds none. Each workout is one act on the
    // API's binding, so it lands whole before the seat changes or not at all, and one the domain refuses or that fails
    // leaves the others to land; a seat that moved refuses every act after it, so the first such refusal ends the hook.
    // Told once when it saved something, and once for each workout refused or failed; the seat changes on whichever.
    saveSignedOutWorkouts: async () => {
      // An open copy's set as its adoption saves it: one the start it was logged on took with it, which the adoption
      // superseded, is recorded again, and one the act still draws stands.
      const recordedAgain = (set) => {
        const append = scopedAct(AppendSet(set).recorded);
        return { refusals: append.refusals,
          load: (act) => ({ drawn: act.inScope(SCOPE, (reader) => reader.repository(TrainingSet).find(set.id, 'drawn') !== null), loaded: append.load(act) }),
          decide: ({ drawn, loaded }, ids) => (drawn ? ActDecision.unchanged(null) : append.decide(loaded, ids)) };
      };
      const saved = () => read((reader) => reader.device(SignedOutWorkout.key));
      const workouts = await boundary('workout-adopt', async () => read((reader) => {
        if (!reader.isAnonymous) return [];
        return reader.repository(Session).all('drawn').map((workout) => {
          const adoption = AdoptWorkout(workout.id, 'prepare');
          const copy = adoption.load(reader).workout;
          return [scopedAct(adoption), ...(copy?.session.isOpen ? copy.sets.map(recordedAgain) : [])];
        });
      })).catch(() => []);
      let savedAny = false;
      for (const parts of workouts) {
        try {
          const changed = await boundary('workout-adopt', async () => {
            const before = saved();
            const outcome = await runner.runComposed(parts);
            if (outcome.kind === 'refused') throw gymRefusalError(outcome.refusal);
            return !sameJson(before ?? null, saved() ?? null);
          });
          if (changed) savedAny = true;
        } catch (error) {
          if (error.code === 'not-writable') break;
        }
      }
      if (savedAny) event('workout-adopt', 'saved-local');
    },
    // In this browser (WD9.3): every copy saved for the account that it has not taken, oldest first, as its card draws it.
    browserCopies: () => read((reader) => {
      const rows = reviewOf(reader);
      return SignedOutWorkout.read(reader).map((copy) => browserCopy(reader, copy, rows.find((row) => row.id.equals(copy.session.id)) ?? null))
        .sort((a, b) => a.startedAt - b.startedAt);
    }),
    // Keep as finished: the copy imported as a workout of its own, an open one finished at its last set.
    keepCopy: (record) => recover('kept', record, (row) => [AdoptWorkout(row.id, 'keep',
      row.workout.session.isOpen ? WorkoutFix.ofRecovery(row).markFinished().workout : null)]),
    // Add to your log: the review's retry, a landed workout's stranded sets back into it and those outside it a copy of their own.
    retryCopy: (record) => recover('retried', record, (row) => (row.strandedSets.length > 0
      ? [RecoverStrandedSets(row.id, 'intoWorkout'), RecoverStrandedSets(row.id, 'separately')]
      : [AdoptWorkout(row.id, row.retry === 'restartWorkout' ? 'restart' : 'keep')])),
    discardCopy: (record) => recover('discarded', record, (row) => [DiscardSignedOutWorkout(row.id)]),
    // A start the account refused because another device's won the race (spec §4): its sets saved from the notice for the
    // review, answered with how many the copy holds. A start that holds no set loses nothing: its notice is put away and
    // nothing is said. Another tab's save, or a copy already saved, answers 0.
    saveRefusedStart: async (noticeId) => {
      const notice = recoveryNotices().find((each) => each.id === noticeId);
      const copy = notice ? SignedOutWorkout.ofRefusedStart(notice) : null;
      if (!notice || copy === null) return 0;
      try {
        const outcome = await runner.run(SaveRefusedStart(notice));
        if (outcome.kind === 'committed') {
          recovered('saved', 'session-open');
          return copy.sets.length;
        }
        if (copy.sets.length === 0) await port.dismissNotice(noticeId);
        return 0;
      } catch (error) {
        if (!(error instanceof ReplicaChanged) && !isStoreFailure(error)) failure('workout-recover', error);
        return 0;
      }
    },
    // Whether recovery answers a notice of the engine's, so the room says nothing else of it: a start refused because another
    // device's won the race, or a refusal a saved copy owns, whose card names it.
    recoveryAnswers: (notice) => read((reader) => {
      const refusal = new DomainNotice(notice, engine.registry, GymRefusals);
      return SignedOutWorkout.ofRefusedStart(refusal) !== null || SignedOutWorkout.read(reader).some((copy) => copy.owns(refusal));
    }),
    // The copies the account has taken (web-device-parity §3 Sign-in): each proposal a copy held issued again once the
    // account holds its workout, then every copy taken whole let go. A reissue the account refuses but for a finished
    // workout is a proposal lost, reported once per `lost`.
    settleBrowserCopies: async (lost = new Set()) => {
      const holding = read((reader) => SignedOutWorkout.read(reader)
        .filter((copy) => copy.proposals.length > 0 && reader.confirmed(Session, copy.session.id) !== null));
      for (const proposal of holding.flatMap((copy) => copy.proposals)) {
        const outcome = await runner.run(ReissueWorkoutProposal(proposal));
        if (outcome.kind !== 'refused' || outcome.refusal.kind === 'sessionFinished' || lost.has(String(proposal.id.record))) continue;
        lost.add(String(proposal.id.record));
        failure('workout-recover', new Error('workout-proposal-reissue-refused'));
      }
      await runner.run(ReconcileAdoptedWorkouts());
    },
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
      'history', 'progress', 'record', 'stats'].map((name) => [name, async (...args) => read((reader) => {
      const source = name === 'history' && args[0]?.timeZone
        ? new Reader(reader.views, SCOPE, new Moment(reader.moment.now, namedZone(args[0].timeZone))) : reader;
      const history = new TrainingHistory(source);
      const document = history[name](...args);
      return name === 'history' && args[0]?.projection === 'progress'
        ? { ...document, progress: history.progressIn(args[0]) } : document;
    })])),
    // A copy before its first pull of gym's scope may hold part of the history, so it reads no last time and claims nothing.
    lastTime: async (exerciseId) => read((reader) => (reader.firstPullComplete() ? new TrainingHistory(reader).lastTime(exerciseId) : null)),
    lastSets: async () => read((reader) => (reader.firstPullComplete() ? new TrainingHistory(reader).lastSets() : [])),
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
      if (outcome.kind === 'refused') {
        throw gymRefusalError(outcome.refusal, { kept: read((reader) => reader.repository(TrainingSet).find(id, 'drawn'))?.weightKg ?? null });
      }
      event('set-correct', outcome.kind === 'committed' ? 'saved-local' : 'unchanged');
      return read((reader) => setDocument(reader.repository(TrainingSet).find(id, 'drawn')));
    }),
    holdDeath: (type, record) => {
      const entity = { note: Note, routine: Routine, weighin: WeighIn, session: Session, set: TrainingSet }[type];
      const id = new Id(record, entity);
      return remove(type === 'set' ? DeleteSet(id) : new Remove(id, GymRefusals));
    },
    undoDeath: (gestureId) => boundary('undo', async () => {
      checkOwner(engine.activeBinding());
      const undone = await runner.cancelHeld(gestureId);
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
    mintNote: () => { checkOwner(engine.activeBinding()); return runner.mint(Note).record; },
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
    // A workout on this browser's copy (web-device-parity §4): the domain's actions, each one write; the clock the log
    // stamps with, this device's corrected by the server's offset; and whether this tab leads the browser's tabs.
    now: () => port.physNow(),
    leads: () => engine.leader === true,
    startWorkout: ({ routineId = null } = {}) => workoutWrite('workout-start',
      { step: 'gym_session_started', labels: [{ screen: 'workout', door: routineId === null ? 'empty' : 'routine' }] }, async () => {
        const id = runner.mint(Session);
        const outcome = await ran(StartWorkout({ id, routineId: routineId === null ? null : new Id(routineId, Routine) }));
        return { happened: outcome.kind === 'committed', result: { sessionId: id.record } };
      }),
    settleRack: (sessionId) => workoutWrite('rack-settle', {}, async () => {
      await ran(SettleRack(new Id(sessionId, Session)));
      return { happened: false, result: null };
    }),
    // `change` is `{ movement }` or `{ adding }` (an exercise id); the `{ weightKg }` or `{ reps }` the lifter set; or a
    // step from what the rack holds, `{ stepLoad: { direction, big } }` or `{ stepReps: direction }`.
    turnRack: (sessionId, change) => {
      const field = 'weightKg' in change || 'stepLoad' in change ? 'weight' : 'reps' in change || 'stepReps' in change ? 'reps' : null;
      const domainChange = 'movement' in change ? { movement: new Id(change.movement, Exercise) }
        : 'adding' in change ? { adding: new Id(change.adding, Exercise) } : change;
      const step = field ? { step: 'gym_workout_adjusted', labels: [{ screen: 'workout', field }] }
        : 'adding' in change ? { step: 'gym_workout_plan_changed', labels: [{ action: 'add_movement', door: 'workout' }] }
          : { step: 'gym_workout_movement_chosen', labels: [{ screen: 'workout' }] };
      return workoutWrite('rack-turn', step, async () => {
        const outcome = await ran(TurnRack(new Id(sessionId, Session), domainChange));
        return { happened: outcome.kind === 'committed', result: null };
      });
    },
    // Log set under the offer the tab drew; `logged` is false when that offer's set was already written, by this tab or another.
    logSet: (sessionId, { offer, weightKg, reps }) => workoutWrite('set-log', { step: 'gym_set_logged', labels: [{ screen: 'workout' }] }, async () => {
      const outcome = await ran(LogRackSet({ sessionId: new Id(sessionId, Session), offer, weightKg, reps }));
      return { happened: outcome.kind === 'committed', result: { logged: outcome.kind === 'committed' } };
    }),
    // `base` is the plan the editor opened on; `edits` are `{ kind, index, set, target, exerciseId, restSeconds }` as the
    // domain's PlanOperations name them. A plan another tab or device changed since is refused `stale`.
    reviseWorkout: (sessionId, base, edits) => {
      const operations = edits.map((edit) => ({
        retarget: () => PlanOperations.retarget(edit.index, edit.set, new SetTarget(edit.target?.reps ?? null, edit.target?.weightKg ?? null)),
        addSet: () => PlanOperations.addSet(edit.index),
        removeSet: () => PlanOperations.removeSet(edit.index, edit.set),
        swap: () => PlanOperations.swap(edit.index, new Id(edit.exerciseId, Exercise)),
        addMovement: () => PlanOperations.addMovement(new Id(edit.exerciseId, Exercise)),
        removeMovement: () => PlanOperations.removeMovement(edit.index),
        setRest: () => PlanOperations.setRest(edit.index, edit.restSeconds ?? null),
      }[edit.kind]()));
      const actions = [...new Set(operations.map((operation) => ({ retarget: 'retarget', addSet: 'add_set', removeSet: 'remove_set', swap: 'swap',
        addMovement: 'add_movement', removeMovement: 'remove_movement', setRest: 'rest' })[operation.kind]))];
      return workoutWrite('plan-revise', { step: 'gym_workout_plan_changed', labels: actions.map((action) => ({ action, door: 'workout' })) }, async () => {
        const outcome = await ran(ReviseWorkout({ sessionId: new Id(sessionId, Session), base: base === null ? null : PlanSnapshot.decode(base), operations }));
        return { happened: outcome.kind === 'committed', result: null };
      });
    },
    finishWorkout: (sessionId) => workoutWrite('workout-finish', { step: 'gym_session_finished', labels: [{ screen: 'workout' }] }, async () => {
      const outcome = await ran(FinishWorkout(new Id(sessionId, Session)));
      return { happened: outcome.kind === 'committed', result: null };
    }),
  };
}

// Over the replica this tab draws, bound or anon, waiting for no account, and made again only when its binding changes;
// `ready` once it has something to draw.
export function useGymApi() {
  const replica = useSyncReplica();
  const records = useSyncRecords(SCOPE);
  const ready = records.firstPullComplete || records.drawn.length > 0;
  return useMemo(() => replica ? { ...createGymApi(replica.engine), ready } : null, [replica, ready]);
}

// A workout's title on the device: the name it was logged under, else its routine's, else a free session's.
function workoutTitle(reader, session) {
  return session.name ?? (session.routineId === null ? null : reader.repository(Routine).find(session.routineId, 'drawn')?.name) ?? NO_ROUTINE;
}

// `today` and `yesterday` by name, an older day by its date.
const dayOf = (ms) => (daysAgo(ms) <= 1 ? agoLabel(ms) : shortDayLabel(ms));

// The one action that answers a copy's reason on the web, which has no editor for a copy: Keep as finished while the
// account's workout is open, the retry once nothing refuses it but that it has not gone, and none for the rest, whose way
// out is Discard. A landed workout's stranded sets have no Keep: their workout is on the log.
function answerOf(row) {
  if (row.reason === 'session-open') return row.strandedSets.length > 0 ? null : 'keep';
  return row.reason === 'unsent' || row.reason === 'session-finished' ? 'retry' : null;
}

// A copy as In this browser draws it (WD9.3): its title, when it started, the sets it would move, whether they are a landed
// workout's stranded sets, and while it waits on the person the review's reason and the action that answers it; one with
// no reason is on its way.
function browserCopy(reader, copy, row) {
  const stranded = row !== null && row.strandedSets.length > 0;
  return { id: String(copy.session.id.record), title: workoutTitle(reader, copy.session), startedAt: copy.session.startedAt.ms,
    sets: stranded ? row.strandedSets.length : copy.sets.length, stranded, reason: row?.reason ?? null, answer: row === null ? null : answerOf(row) };
}

// What gym's signed-out work holds as the sign-in question counts it (web-device-parity §3 Sign-in): its workouts, routines
// and weigh-ins, each with what names it, the noun for what the account holds, and the decision told as
// `gym_signin_decision` with the count as a bucket. The engine's active replica is the anon one while the question stands.
export function signInWork(engine, { told = track } = {}) {
  const { workouts, routines, weighIns } = createGymApi(engine).read((reader) => ({
    workouts: reader.repository(Session).all('drawn').sort((a, b) => a.startedAt.ms - b.startedAt.ms)
      .map((session) => ({ title: workoutTitle(reader, session), at: session.startedAt.ms })),
    routines: RoutineValue.ordered(reader.repository(Routine).all('drawn')).map((routine) => routine.name),
    weighIns: reader.repository(WeighIn).all('drawn').map((entry) => {
      const [year, month, date] = String(entry.id.record).split('-').map(Number);
      return new Date(year, month - 1, date).getTime();
    }).sort((a, b) => a - b),
  }));
  const since = (days) => t('gym.signedOutWork.since', { day: dayOf(days[0]) });
  const items = [
    workouts.length > 0 && { label: t('gym.signedOutWork.workouts', { count: workouts.length }),
      detail: workouts.length === 1 ? t('gym.signedOutWork.oneWorkout', { name: workouts[0].title, day: dayOf(workouts[0].at) }) : since(workouts.map((each) => each.at)) },
    routines.length > 0 && { label: t('gym.signedOutWork.routines', { count: routines.length }), detail: routines.join(' · ') },
    weighIns.length > 0 && { label: t('gym.signedOutWork.weighIns', { count: weighIns.length }),
      detail: weighIns.length === 1 ? dayOf(weighIns[0]) : since(weighIns) },
  ].filter(Boolean);
  const total = workouts.length + routines.length + weighIns.length;
  return { items, total, held: t('gym.signedOutWork.held'),
    onStep: (step) => {
      if (['add', 'discard', 'cancel'].includes(step)) told('gym_signin_decision', { choice: step, count_bucket: countBucket(total) });
    } };
}

// The device rows a sign-in or a sign-out counts as gym's work (engine §7.10): the workouts saved for adoption, and the
// past-workout and correction drafts the account refused, which no queued command carries any longer.
export function gymDeviceWork(product, rows) {
  if (product !== 'gym') return [];
  return [SignedOutWorkout.key, WORKOUT_DRAFTS].filter((key) => Object.values(rows[key] ?? {})
    .some((entry) => key === SignedOutWorkout.key || entry?.status === 'refused'));
}

// Gym's rows when a sign-in joins the browser's work to the account's dormant replica (engine §7.10): the workouts saved for
// adoption and the form drafts merged entry by entry, so neither side's is lost, the account's standing on an entry both
// hold; every other row is the account's where it holds one.
export function adoptGymDeviceRows(product, incoming, kept) {
  if (product !== 'gym') return undefined;
  const rows = { ...incoming, ...kept };
  for (const key of [SignedOutWorkout.key, WORKOUT_DRAFTS]) {
    if (incoming[key] != null || kept[key] != null) rows[key] = { ...incoming[key], ...kept[key] };
  }
  return rows;
}

// From the engine's opening for the document (`routes.sync.prepare`): whenever gym's scope moves on a bound replica holding
// copies, the copies the account took are settled (`settleBrowserCopies`), so none outlives its workout's arrival whether
// or not the room is open.
export function watchBrowserCopies(engine, { failure = gymFailure } = {}) {
  const lost = new Set();
  let running = false;
  let dirty = false;
  const settle = async () => {
    dirty = true;
    if (running || engine.closed) return;
    running = true;
    try {
      while (dirty && !engine.closed) {
        dirty = false;
        if (engine.getSnapshot().state !== 'bound' || !engine.readDeviceRows('gym')[SignedOutWorkout.key]) continue;
        await createGymApi(engine, { failure }).settleBrowserCopies(lost);
      }
    } catch (error) {
      if (!(error instanceof ReplicaChanged) && !(error instanceof GymRefusal) && !isStoreFailure(error)) failure('workout-recover', error);
    } finally { running = false; }
  };
  engine.observe(SCOPE).subscribe(settle);
  settle();
}

// An open workout, whichever device started it, keeps the room's sync close, until four idle hours close it.
export function gymLiveHint(engine, replica) {
  return gymReadView(engine.observe(SCOPE).getSnapshot(), {
    now: Date.now() + (replica?.meta?.serverOffsetMs ?? 0),
  }).liveHint();
}
