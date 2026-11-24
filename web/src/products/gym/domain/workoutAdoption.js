// @ts-check

import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { DecodeError, Fields, Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { GymRefusals } from './gymRules.js';
import { Session, SessionRules, SetRules, TrainingSet } from './training.js';
import { AppendSet, ImportedSet, ImportSession, TrainingState, startSessionCommand } from './trainingActions.js';
import { WorkoutProposal } from './workoutProposals.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/reading.js').QueuedCommand} QueuedCommand */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('./catalogue.js').Catalogue} Catalogue */
/** @typedef {import('./gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */
/** @typedef {import('./workoutProposals.js').WorkoutProposalValue} WorkoutProposalValue */
/** @typedef {import('../../../platform/domain-kit/refusals.js').DomainNotice<GymRefusal>} GymNotice */
/** @typedef {import('../../../platform/domain-kit/refusals.js').NoticeContent} NoticeContent */
/** @typedef {import('../../../platform/domain-kit/entities.js').RecordID} RecordID */

/** @param {string} code @param {import('../../../platform/domain-kit/entities.js').RecordRef} subject @param {Json | null} [detail] */
const predicted = (code, subject, detail = null) => GymRefusals.ofRefused(new Refused(code, subject, detail, 'predicted'));

/** @param {SessionValue} a @param {SessionValue} b */
const byStart = (a, b) => a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id);

// A workout logged signed out and saved on this device for the account, under the device key `rack:adoption`: its
// session, the sets it holds in the order performed, and the proposals waiting on an open copy, oldest first, which the
// account takes once it holds the workout.
export class SignedOutWorkout {
  static key = 'rack:adoption';

  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets @param {readonly WorkoutProposalValue[]} [proposals] */
  constructor(session, sets, proposals = []) {
    this.session = session;
    this.sets = Object.freeze(sets.filter((set) => set.sessionId.equals(session.id))
      .sort((a, b) => a.completedAt.ms - b.completedAt.ms || Id.compare(a.id, b.id)));
    this.proposals = Object.freeze([...proposals]);
    Object.freeze(this);
  }

  /** @param {Json} value */
  static decode(value) {
    const fields = Fields.object(value);
    const rawSession = fields.json('session');
    if (rawSession === undefined) throw new DecodeError(Session.type, 'adoption', 'missing session');
    const sessionFields = Fields.object(rawSession);
    const id = sessionFields.ref('id', Session);
    const rows = fields.json('sets');
    if (!Array.isArray(rows)) throw new DecodeError(Session.type, 'adoption', 'invalid saved workout');
    const session = Session.decode(Fields.values(Session.type, id.record, sessionFields.values));
    const sets = rows.map((row) => {
      const setFields = Fields.object(row);
      return TrainingSet.decode(Fields.values(TrainingSet.type, setFields.ref('id', TrainingSet).record, setFields.values));
    });
    const waiting = fields.json('proposals');
    const proposals = Array.isArray(waiting) ? waiting.map((row) => {
      const proposalFields = Fields.object(row);
      return WorkoutProposal.decode(Fields.values(WorkoutProposal.type, proposalFields.ref('id', WorkoutProposal).record, proposalFields.values));
    }) : [];
    return new SignedOutWorkout(session, sets, proposals);
  }

  // The workout a start the account refused `session-open` was logged as, from the notice that holds it: the start's
  // session as the start predicted it, finished where a finish folded into the notice says, and every set born in the
  // notice as its last write there left it, a set deleted before the refusal left out. A workout deleted before the
  // refusal keeps none of its sets. Null for a notice of anything else.
  /** @param {GymNotice} notice */
  static ofRefusedStart(notice) {
    const { code, content } = notice.notice;
    const start = content.cmd;
    if (code !== 'session-open' || start?.name !== 'gym.start') return null;
    const id = /** @type {RecordID} */ (start.args.id);
    /** @type {Json} */
    let finishedAt = null;
    let deleted = false;
    /** @type {Map<string, { id: RecordID, alive: boolean }>} */
    const born = new Map();
    /** @param {NoticeContent} part */
    const walk = (part) => {
      if (part.cmd?.name === 'gym.finish' && sameJson(part.cmd.args.sessionId ?? null, id)) finishedAt = part.cmd.args.finishedAt ?? null;
      for (const delta of part.d ?? []) {
        if (delta.life === undefined) continue;
        if (delta.t === Session.type && sameJson(delta.id, id)) deleted = delta.life[0] === 'dead';
        if (delta.t !== TrainingSet.type) continue;
        const key = jcs(delta.id);
        if (delta.life[0] === 'alive' && delta.life[1] === delta.born) born.set(key, { id: delta.id, alive: true });
        const set = born.get(key);
        if (set !== undefined) set.alive = delta.life[0] === 'alive';
      }
      for (const dependent of part.dependents ?? []) walk(dependent);
    };
    walk(content);
    const routineId = start.args.routineId ?? null;
    const session = Session.decode(Fields.values(Session.type, id, { startedAt: start.args.startedAt ?? null, routineId, historyRoutineId: routineId,
      finishedAt, closedBy: finishedAt === null ? null : 'finish', ...notice.values({ t: Session.type, id }) }));
    const sets = deleted ? [] : [...born.values()].filter((set) => set.alive)
      .map((set) => TrainingSet.decode(Fields.values(TrainingSet.type, set.id, notice.values({ t: TrainingSet.type, id: set.id }))));
    return new SignedOutWorkout(session, sets);
  }

  get json() {
    return { session: { ...this.session.fields(), id: this.session.id.json },
      sets: this.sets.map((set) => ({ ...set.fields(), id: set.id.json })),
      ...(this.proposals.length === 0 ? {} : { proposals: this.proposals.map((proposal) => ({ ...proposal.fields(), id: proposal.id.json })) }) };
  }

  // A finished copy finishes where it says; an open one at its last activity.
  get finishedAt() { return this.session.finishedAt ?? SessionRules.lastActivity(this.session, this.sets); }

  get importAction() {
    return ImportSession({ id: this.session.id, startedAt: this.session.startedAt, finishedAt: this.finishedAt,
      sets: this.sets.map((set) => new ImportedSet({ id: set.id, exerciseId: set.exerciseId, weightKg: set.weightKg, reps: set.reps,
        completedAt: set.completedAt, rpe: set.rpe, note: set.note, rpeNamed: true })), routineId: this.session.routineId });
  }

  // What this device refuses before asking the account: the import's own checks, a window reaching past now, a movement
  // the catalogue lacks, then a crossing with a finished workout on the log.
  /** @param {Moment} moment @param {readonly SessionValue[]} sessions @param {Catalogue} catalogue @returns {GymRefusal | null} */
  importRefusal(moment, sessions, catalogue) {
    const verdict = this.importAction.checked(moment);
    if ('refusal' in verdict) return verdict.refusal;
    const { startedAt } = this.session, finishedAt = this.finishedAt;
    if (finishedAt.ms > moment.now.ms) return predicted('bad-instant', this.session.id.ref);
    const missing = this.sets.find((set) => catalogue.find(set.exerciseId) === null);
    if (missing !== undefined) return predicted('unknown-exercise', missing.id.ref);
    const [crossed] = sessions.filter((other) => !other.id.equals(this.session.id) && SessionRules.crosses(startedAt, finishedAt, other)).sort(byStart);
    return crossed === undefined ? null : predicted('session-overlap', this.session.id.ref, { sessionId: crossed.id.json });
  }

  // The loads a person changed in this copy since `saved` meet their movements' floors; a load the copy recorded stands.
  /** @param {SignedOutWorkout | null} saved @param {Catalogue} catalogue @returns {GymRefusal | null} */
  floorRefusal(saved, catalogue) {
    try {
      this.sets.forEach((set, at) => SetRules.floored(set, saved?.sets ?? [], catalogue, new Path('sets').plus(at).plus('weightKg')));
      return null;
    } catch (error) {
      if (error instanceof Violation) return GymRefusals.ofViolation(error);
      throw error;
    }
  }

  // What this device refuses before a retry asks the account. A finished copy is an import, with the import's checks. An
  // open copy restarts as a start with its sets appended: the log refuses that while it holds an open workout of its own,
  // and never for crossing a finished one.
  /** @param {Moment} moment @param {readonly SessionValue[]} sessions @param {Catalogue} catalogue @returns {GymRefusal | null} */
  retryRefusal(moment, sessions, catalogue) {
    const { session } = this;
    if (!session.isOpen) return this.importRefusal(moment, sessions, catalogue);
    if (sessions.some((other) => other.isOpen && !other.id.equals(session.id))) return predicted('session-open', session.id.ref);
    try {
      SessionRules.instant(session.startedAt, 'session.startedAt', new Path('startedAt'));
      if (session.startedAt.ms > moment.now.ms) return predicted('bad-instant', session.id.ref);
      for (const set of this.sets) {
        new Valid(set, moment);
        if (catalogue.find(set.exerciseId) === null) return predicted('unknown-exercise', set.id.ref);
      }
      return null;
    } catch (error) {
      if (error instanceof Violation) return GymRefusals.ofViolation(error);
      throw error;
    }
  }

  // A notice this copy owns: a refusal of the gestures recovery queues for it, its import, its start with its sets, a
  // correction of its session or the creation of one of its sets. A later edit of a set that landed is the room's.
  /** @param {GymNotice} notice */
  owns(notice) {
    const { content } = notice.notice;
    const id = this.session.id.json;
    if (content.cmd !== undefined) {
      const { name, args } = content.cmd;
      if ((name === 'gym.importSession' || name === 'gym.start') && sameJson(args.id ?? null, id)) return true;
      if (name === 'gym.correctSession' && sameJson(args.sessionId ?? null, id)) return true;
    }
    return (content.d ?? []).some((delta) => delta.t === TrainingSet.type && delta.born !== undefined && delta.life?.[0] === 'alive'
      && delta.life[1] === delta.born && this.sets.some((set) => sameJson(set.id.json, delta.id)));
  }

  /** @param {Reader} read */
  static read(read) {
    const rows = read.device(SignedOutWorkout.key);
    if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) return Object.freeze([]);
    return Object.freeze(Object.values(rows).map(SignedOutWorkout.decode).sort((a, b) => Id.compare(a.session.id, b.session.id)));
  }

  // The device key's rows with these copies replacing their own and these dropped, or null when none is left.
  /**
   * @param {readonly SignedOutWorkout[]} backup @param {readonly SignedOutWorkout[]} replacing
   * @param {readonly Id<SessionValue>[]} [dropping]
   * @returns {Json | null}
   */
  static saved(backup, replacing, dropping = []) {
    /** @type {Record<string, Json>} */
    const rows = Object.fromEntries(backup.map((copy) => [String(copy.session.id.record), copy.json]));
    for (const id of dropping) delete rows[String(id.record)];
    for (const copy of replacing) rows[String(copy.session.id.record)] = copy.json;
    return Object.keys(rows).length === 0 ? null : rows;
  }
}

// `prepare` turns a signed-out workout into one import, or a start, before the replica changes hands; a start an older
// build queued joining is replaced by one that does not. `keep` imports the saved copy as finished at its last set;
// `restart` resubmits an open one's start with every set it holds, in one plan, or refuses the whole retry. Both replay
// what the copy recorded and take a revised copy, whose changed loads meet their floors and which replaces the saved one
// only when the retry is queued.
/**
 * @typedef {{ anonymous: boolean, commands: readonly QueuedCommand[], backup: readonly SignedOutWorkout[],
 *   workout: SignedOutWorkout | null, imported: { state: TrainingState, routine: import('./routines.js').RoutineValue | null } | null,
 *   confirmed: boolean, firstPullComplete: boolean }} AdoptionLoaded
 */
/** @param {Id<SessionValue>} id @param {'prepare' | 'keep' | 'restart'} mode @param {SignedOutWorkout | null} [revised] */
export function AdoptWorkout(id, mode, revised = null) {
  precondition(revised === null || (mode !== 'prepare' && revised.session.id.equals(id)), 'a revision keeps the saved workout\'s identity');
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read @returns {AdoptionLoaded} */
    load(read) {
      const backup = SignedOutWorkout.read(read);
      const saved = backup.find((copy) => copy.session.id.equals(id)) ?? null;
      const workout = mode === 'prepare' ? prepared(read, id, saved) : saved === null ? null : revised ?? saved;
      return { anonymous: read.isAnonymous, commands: read.commands(), backup, workout,
        imported: workout === null ? null : workout.importAction.load(read), confirmed: read.confirmed(Session, id) !== null,
        firstPullComplete: read.firstPullComplete() };
    },
    /** @param {AdoptionLoaded} loaded @param {IDSource} ids */
    decide(loaded, ids) {
      const { workout } = loaded;
      if (workout === null) return Decision.unchanged(null);
      const commands = loaded.commands.filter((queued) => sameJson(queued.command.args.id ?? null, id.json));
      if (commands.some((queued) => queued.command.name === 'gym.importSession')) return Decision.unchanged(null);
      let plan = new Plan();
      if (mode === 'prepare') {
        const start = commands.find((queued) => queued.command.name === 'gym.start' && queued.canSupersede);
        if (!loaded.anonymous || start === undefined) return Decision.unchanged(null);
        if (!workout.session.isOpen && loaded.imported !== null) {
          const imported = decision(workout.importAction.recorded, loaded.imported, ids);
          if (imported.kind === 'refuse') return Decision.refuse(imported.refusal);
          if (imported.kind === 'unchanged') return Decision.unchanged(null);
          plan = imported.plan;
          plan.supersede([start.gestureId]);
        } else if (start.command.args.joinOpenSession !== false) {
          const { session } = workout;
          plan = Plan.running(startSessionCommand(id, session.routineId, session.startedAt), [Prediction.create(id, session.fields())]);
          plan.supersede([start.gestureId]);
        }
      } else {
        if (loaded.anonymous || !loaded.firstPullComplete || commands.some((queued) => queued.command.name === 'gym.start')) {
          return Decision.refuse(predicted('session-open', id.ref));
        }
        if (loaded.confirmed) return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', id.ref, null, 'predicted')));
        if (loaded.imported === null) return Decision.unchanged(null);
        const { state } = loaded.imported;
        const floor = workout.floorRefusal(loaded.backup.find((copy) => copy.session.id.equals(id)) ?? null, state.catalogue);
        if (floor !== null) return Decision.refuse(floor);
        if (mode === 'restart') {
          const restarted = restart(id, workout, state);
          if (restarted.kind !== 'write') return restarted;
          plan = restarted.plan;
        } else {
          const refused = workout.importRefusal(state.moment, state.stored, state.catalogue);
          if (refused !== null) return Decision.refuse(refused);
          const imported = decision(workout.importAction.recorded, loaded.imported, ids);
          if (imported.kind === 'refuse') return Decision.refuse(imported.refusal);
          if (imported.kind === 'unchanged') return Decision.unchanged(null);
          plan = imported.plan;
        }
      }
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, [workout]));
      return Decision.write(plan, null);
    },
  });
}

// The workout as the device draws it before the replica changes hands: its session as the log draws it, its sets, and
// the saved copy's sets not yet stored. An open one keeps the proposals waiting on it: the saved copy's, then those
// stored for it, oldest first.
/** @param {Reader} read @param {Id<SessionValue>} id @param {SignedOutWorkout | null} saved */
function prepared(read, id, saved) {
  const session = read.repository(Session).find(id, 'drawn');
  if (session === null) return null;
  const sets = [...read.repository(TrainingSet).children(id, 'sessionId', 'drawn')];
  for (const set of saved?.sets ?? []) {
    if (!sets.some((drawn) => drawn.id.equals(set.id)) && read.repository(TrainingSet).record(set.id.record, 'stored') === undefined) sets.push(set);
  }
  const waiting = saved?.proposals ?? [];
  const proposals = read.repository(WorkoutProposal);
  const held = proposals.all('stored').filter((proposal) => proposal.sessionId.equals(id) && proposal.state === 'pending'
    && !waiting.some((each) => sameJson(each.id.json, proposal.id.json) && sameJson(each.fields(), proposal.fields())))
    .flatMap((proposal) => {
      const born = proposals.record(proposal.id.record, 'stored')?.born;
      return born === undefined ? [] : [{ proposal, born }];
    }).sort((a, b) => Stamp.compare(a.born, b.born)).map((each) => each.proposal);
  const drawn = SessionRules.drawn(session, sets, read.moment.now);
  return new SignedOutWorkout(drawn, sets, drawn.isOpen ? [...waiting, ...held] : []);
}

// An open copy's start and every set it holds appended in the order performed: the account takes the workout whole, or
// the device refuses the retry whole, naming the first set it would refuse.
/** @param {Id<SessionValue>} id @param {SignedOutWorkout} workout @param {TrainingState} state */
function restart(id, workout, state) {
  const { session } = workout;
  if (!session.isOpen) return Decision.refuse(predicted('session-finished', id.ref));
  if (state.stored.some((stored) => SessionRules.drawn(stored, state.sets, state.moment.now).isOpen)) return Decision.refuse(predicted('session-open', id.ref));
  try {
    SessionRules.instant(session.startedAt, 'session.startedAt', new Path('startedAt'));
    if (session.startedAt.ms > state.moment.now.ms) return Decision.refuse(predicted('bad-instant', id.ref));
    const plan = Plan.running(startSessionCommand(id, session.routineId, session.startedAt), [Prediction.create(id, session.fields())]);
    /** @type {TrainingSetValue[]} */
    const planned = [];
    for (const set of workout.sets) {
      const valid = new Valid(set, state.moment);
      const refused = AppendSet.refusal(valid, session, state, planned);
      if (refused !== null) return Decision.refuse(refused);
      plan.create(valid);
      planned.push(valid.value);
    }
    return Decision.write(plan, null);
  } catch (error) {
    if (error instanceof Violation) return Decision.refuse(GymRefusals.ofViolation(error));
    throw error;
  }
}

// Drops every saved copy the account has taken whole: its session and each of its sets confirmed.
export function ReconcileAdoptedWorkouts() {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      const all = SignedOutWorkout.read(read);
      const remaining = all.filter((workout) => read.confirmed(Session, workout.session.id) === null
        || workout.sets.some((set) => read.confirmed(TrainingSet, set.id) === null));
      return { all, remaining };
    },
    /** @param {{ all: readonly SignedOutWorkout[], remaining: readonly SignedOutWorkout[] }} loaded */
    decide({ all, remaining }) {
      if (remaining.length === all.length) return Decision.unchanged(null);
      const plan = new Plan();
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(remaining, []));
      return Decision.write(plan, null);
    },
  });
}
