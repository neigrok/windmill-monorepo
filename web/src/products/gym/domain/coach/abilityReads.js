// @ts-check
// The read abilities over the replica (gym Coach INV-4, INV-5): each a decider that loads what its projection needs and
// answers the server's result bytes, with the rows it served. The documents every ability prints are here too.

import { Decision } from '../../../../platform/domain-kit/actions.js';
import { Collation } from '../../../../platform/domain-kit/collation.js';
import { Id, compareText } from '../../../../platform/domain-kit/entities.js';
import { Refused } from '../../../../platform/domain-kit/refusals.js';
import { LocalDay } from '../../../../platform/domain-kit/time.js';
import { Path, Violation } from '../../../../platform/domain-kit/values.js';
import { Bodyweight, WeighIn, WeighInRules } from '../bodyweight.js';
import { Catalogue, Exercise } from '../catalogue.js';
import { GymRefusals } from '../gymRules.js';
import { Note } from '../notes.js';
import { Proposal, RoutineChange } from '../proposals.js';
import { Routine } from '../routines.js';
import { GymEstimate, Session } from '../training.js';
import { TrainingHistory, exerciseDocument, sessionDocument, setDocument } from '../trainingHistory.js';
import { LastTime, PerformedFact, ProgressSession } from '../trainingReads.js';
import { ReadServed } from './conversation.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/entities.js').RecordRef} RecordRef */
/** @typedef {import('../../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../routines.js').RoutineValue} RoutineValue */
/** @typedef {import('../routines.js').RoutineEntry} RoutineEntry */
/** @typedef {import('../proposals.js').ProposalValue} ProposalValue */
/** @typedef {import('../workoutProposals.js').WorkoutProposalValue} WorkoutProposalValue */
/** @typedef {import('../training.js').SessionValue} SessionValue */
/** @typedef {import('../training.js').TrainingSetValue} TrainingSetValue */
/** @typedef {import('../notes.js').NoteValue} NoteValue */
/** @typedef {{ [key: string]: Json }} Printed */

// What one ability call answers: the result the model reads, the log rows it served, the records it created.
export class AbilityAnswer {
  /** @param {Json} payload @param {ReadServed} [served] @param {readonly RecordRef[]} [created] */
  constructor(payload, served = ReadServed.none, created = []) {
    this.payload = payload;
    this.served = served;
    this.created = Object.freeze([...created]);
    Object.freeze(this);
  }
}

/** @param {Id<any>} id */
function gone(id) { return GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted')); }

/** @param {string} door @param {string} connection @param {string} agent @param {string | null} thread @returns {Printed} */
function source(door, connection, agent, thread) {
  return { door, ...(connection ? { connection } : {}), ...(agent ? { agent } : {}), ...(thread === null ? {} : { thread }) };
}

/** @param {RoutineChange} change @param {number} index @param {number | null} [loggedSets] @returns {Printed} */
function changeLine(change, index, loggedSets = null) {
  return { ...change.json, position: index + 1, ...(loggedSets === null ? {} : { loggedSets }) };
}

/** @param {ProposalValue} value @param {RoutineValue | null} routine @returns {Printed} */
function proposalHead(value, routine) {
  return { id: value.id.json, routineId: value.routineId.json, intent: value.intent, state: value.state, summary: value.summary,
    ...(routine === null ? {} : { changeCount: value.countChanges(routine) }), ...(value.settledAt === null ? {} : { settledAt: value.settledAt.ms }),
    source: source(value.door, value.connection, value.agent, value.threadId) };
}

export const CoachDocuments = Object.freeze({
  /** @param {readonly RoutineEntry[]} entries @returns {Json} */
  entries: (entries) => entries.map((entry, index) => ({ ...entry.json, position: index + 1 })),

  // A routine as the program lists it; a revision the log has not numbered yet reads as the first.
  /** @param {RoutineValue} value @param {import('../../../../platform/domain-kit/time.js').Instant | null} [lastTrainedAt] @param {ProposalValue | null} [pending] @returns {Json} */
  routine: (value, lastTrainedAt = null, pending = null) => ({ id: value.id.json, name: value.name, position: value.position, revision: value.revision ?? 1,
    ...(lastTrainedAt === null ? {} : { lastTrainedAt: lastTrainedAt.ms }), entries: CoachDocuments.entries(value.entries),
    ...(pending === null ? {} : { pendingProposal: proposalHead(pending, value) }) }),

  // A proposal's receipt: the proposal with its diff, where a person decides, and the words that keep the model honest.
  /** @param {ProposalValue} value @param {RoutineValue | null} routine @param {(id: Id<any>) => number} loggedSets @param {string} appBaseUrl @returns {Json} */
  proposal: (value, routine, loggedSets, appBaseUrl) => {
    const baseName = value.baseName ?? routine?.name ?? null;
    const baseRevision = value.baseRevision ?? routine?.revision ?? null;
    const notes = /** @type {Record<string, string>} */ ({
      applied: 'This proposal was already applied by the lifter — this is the record of it, not a second change.',
      dismissed: 'The lifter rejected this proposal. Nothing changed. It stays in the routine\'s history. Do not resend the same id; propose again '
        + 'only if you have something different to say.',
      superseded: 'This proposal was superseded — the routine moved after it was minted, so it can no longer be applied. Read the routine again '
        + 'with list_routines before you propose anything else.',
    });
    const waiting = `Nothing has changed. ${baseName ?? ''} still reads exactly as it did, and this proposal is waiting in the lifter's app until `
      + 'they open it and tap Apply — no tool on this connection can apply it. Say so when you answer: the routine is unchanged and '
      + 'something is waiting for them.';
    return { proposal: { ...proposalHead(value, routine), ...(baseRevision === null ? {} : { baseRevision }), ...(baseName === null ? {} : { baseName }),
      name: value.proposedName,
      changes: value.changes.map((line, index) => changeLine(line, index, line.kind === 'removed' ? loggedSets(line.exerciseId) : null)) },
    reviewUrl: `${appBaseUrl}/#/gym/proposals/${value.id.record}`, note: notes[value.state] ?? waiting };
  },

  // A workout proposal's receipt: the proposal with its diff against the plan it read, and the words that keep the model
  // honest. The lifter decides it on the workout's card, which has no address.
  /** @param {WorkoutProposalValue} value @param {readonly RoutineEntry[]} base @param {number | null} planRevision @returns {Json} */
  workoutProposal: (value, base, planRevision) => {
    const notes = /** @type {Record<string, string>} */ ({
      applied: 'This change was already applied by the lifter — this is the record of it, not a second change.',
      dismissed: 'The lifter dismissed this change, and the workout kept its plan. Do not resend the same id; propose again only if you have '
        + 'something different to say.',
      superseded: 'This change was superseded — the workout\'s plan moved, or a newer change replaced it, so it can no longer be applied. Read the '
        + 'workout again with get_session before you propose anything else.',
    });
    const waiting = 'Nothing has changed. This workout keeps its plan, and this change is waiting on its card in the lifter\'s app until they tap '
      + 'Apply — no tool on this connection can apply it. Say so when you answer: the workout is unchanged and a change is waiting for them.';
    return { proposal: { id: value.id.json, sessionId: value.sessionId.json, state: value.state, summary: value.summary,
      changeCount: value.countChanges(base), ...(value.settledAt === null ? {} : { settledAt: value.settledAt.ms }),
      source: source(value.door, value.connection, value.agent, value.threadId), baseRevision: value.baseRevision ?? planRevision ?? 1,
      changes: value.changes.map((line, index) => changeLine(line, index)) }, note: notes[value.state] ?? waiting };
  },

  /** @param {NoteValue} value @param {number} position @returns {Json} */
  note: (value, position) => ({ id: value.id.json, position, title: value.title, body: value.body }),

  // gym Coach §3.3: an estimate in a result is stated to one decimal, rounding last: every `e1rm` and `topE1rm`, and the
  // number a new best in e1RM is about.
  /** @param {any} printed @returns {Json} */
  stated: (printed) => {
    if (Array.isArray(printed)) return printed.map(CoachDocuments.stated);
    if (printed === null || typeof printed !== 'object') return printed;
    const estimate = printed.kind === 'e1rm';
    return Object.fromEntries(Object.entries(printed).map(([key, value]) => {
      const states = ['e1rm', 'topE1rm'].includes(key) || (estimate && ['value', 'previous'].includes(key));
      return [key, typeof value === 'number' && states ? GymEstimate.stated(value) : CoachDocuments.stated(value)];
    }));
  },

  // The order a workout's sets are read in: as performed, then by their number, then by id.
  /** @param {readonly TrainingSetValue[]} sets */
  performed: (sets) => [...sets].sort((a, b) => a.completedAt.ms - b.completedAt.ms || (a.setNumber ?? 0) - (b.setNumber ?? 0) || Id.compare(a.id, b.id)),

  // A movement's sets of one workout, by their number.
  /** @param {readonly TrainingSetValue[]} sets */
  numbered: (sets) => [...sets].sort((a, b) => (a.setNumber ?? 0) - (b.setNumber ?? 0) || Id.compare(a.id, b.id)),
});

/**
 * @typedef {{ kind: 'sessions', before: number, beforeId: string, limit: number }
 *   | { kind: 'workout', id: Id<SessionValue>, review: boolean }
 *   | { kind: 'workouts', ids: readonly Id<SessionValue>[], review: boolean }
 *   | { kind: 'lastTime', id: Id<any> }
 *   | { kind: 'lastTimes', ids: readonly Id<any>[] }
 *   | { kind: 'stats', only: Id<any> | null }} LogQuery
 */

// `list_sessions`, `get_session`, `get_sessions`, `last_time`, `get_last_times` and `get_stats` over the whole history.
export class LogRead {
  static defaultPage = 20;
  static maxPage = 200;
  scope = Session.scope;
  refusals = GymRefusals;

  /** @param {LogQuery} query */
  constructor(query) { this.query = query; }

  /** @param {Reader} read */
  load(read) { return new TrainingHistory(read); }

  /** @param {TrainingHistory} history @param {IDSource} ids */
  decide(history, ids) {
    const query = this.query;
    switch (query.kind) {
      case 'sessions': {
        const page = LogRead.newestFirst(history)
          .filter((session) => session.startedAt.ms < query.before || (session.startedAt.ms === query.before && compareText(String(session.id.record), query.beforeId) < 0))
          .slice(0, query.limit);
        // A row: the workout's summary by the name it went by, without its plan, with a line per movement it held.
        const rows = page.map((session) => {
          const { plan, routineName, topSet, ...summary } = history.summary(session);
          const lines = ProgressSession.of(session, history.log.setsFor(session.id)).movements;
          const top = [...lines].sort((a, b) => PerformedFact.heavierFirst(a.heaviest, b.heaviest))[0];
          return { ...summary, ...(session.name ? { routineName: session.name } : {}),
            ...(top ? { topSet: { exerciseId: top.exerciseId.record, weightKg: top.heaviest.weightKg, reps: top.heaviest.reps } } : {}),
            movements: lines.map((line) => ({ exerciseId: line.exerciseId.record, topSet: { weightKg: line.heaviest.weightKg, reps: line.heaviest.reps },
              topE1rm: line.estimate?.e1rm ?? null })) };
        });
        return Decision.unchanged(new AbilityAnswer({ sessions: CoachDocuments.stated(rows) },
          page.reduce((served, session) => served.sawSession(session), ReadServed.none)));
      }
      case 'workout': {
        const session = history.log.drawnSessions.find((each) => each.id.equals(query.id));
        if (!session) return Decision.refuse(gone(query.id));
        const line = LogRead.workout(session, query.review, history);
        return Decision.unchanged(new AbilityAnswer(line.printed, line.served));
      }
      case 'workouts': {
        const drawn = history.log.drawnSessions;
        const lines = query.ids.flatMap((id) => drawn.filter((session) => session.id.equals(id)).map((session) => LogRead.workout(session, query.review, history)));
        const missing = query.ids.filter((id) => !drawn.some((session) => session.id.equals(id)));
        return Decision.unchanged(new AbilityAnswer({ sessions: lines.map((line) => line.printed), missingSessionIds: missing.map((id) => id.json) },
          lines.reduce((served, line) => served.saw(line.served), ReadServed.none)));
      }
      case 'lastTime': {
        const last = LastTime.of(query.id, history.log, LogRead.newestFirst(history));
        if (last.session === null && history.log.catalogue.find(query.id) === null) return Decision.refuse(gone(query.id));
        const line = LogRead.lastTime(last);
        return Decision.unchanged(new AbilityAnswer(line.printed, line.served));
      }
      case 'lastTimes': {
        const newest = LogRead.newestFirst(history);
        const lasts = query.ids.map((id) => LastTime.of(id, history.log, newest));
        const known = lasts.filter((last) => last.session !== null || history.log.catalogue.find(last.exerciseId) !== null);
        const missing = lasts.filter((last) => !known.includes(last));
        const lines = known.map((last) => ({ line: LogRead.lastTime(last), trained: last.session !== null }));
        return Decision.unchanged(new AbilityAnswer({
          exercises: lines.map(({ line, trained }) => {
            const { routine, ...printed } = line.printed;
            return { ...printed, trained };
          }),
          missingExerciseIds: missing.map((last) => last.exerciseId.json),
        }, lines.reduce((served, { line }) => served.saw(line.served), ReadServed.none)));
      }
      case 'stats': {
        const stats = history.stats();
        const served = stats.weeks.reduce((held, week) => held.sawWeek(week.startedAt), ReadServed.none);
        const movements = stats.movements.filter((movement) => query.only === null || movement.exerciseId === query.only.record);
        return Decision.unchanged(new AbilityAnswer(CoachDocuments.stated({ weeks: stats.weeks, movements }), served));
      }
      default: throw new Error('an unknown log query');
    }
  }

  // The server's `ORDER BY started_at DESC, id DESC` (INV-1): a same-millisecond tie goes to the higher id, where the
  // room's `drawnSessions` lists the lower first.
  /** @param {TrainingHistory} history */
  static newestFirst(history) {
    return [...history.log.drawnSessions].sort((a, b) => b.startedAt.ms - a.startedAt.ms || Id.compare(b.id, a.id));
  }

  /** @param {SessionValue} session @param {boolean} review @param {TrainingHistory} history */
  static workout(session, review, history) {
    const sets = CoachDocuments.performed(history.log.setsFor(session.id));
    /** @type {Printed} */
    const printed = { session: sessionDocument(session), sets: sets.map(setDocument),
      ...(review ? { review: CoachDocuments.stated(history.review(String(session.id.record))) } : {}) };
    return { printed, served: sets.reduce((served, set) => served.sawSet(set), ReadServed.none.sawSession(session)) };
  }

  /** @param {LastTime} last */
  static lastTime(last) {
    if (last.session === null) return { printed: /** @type {Printed} */ ({ exerciseId: last.exerciseId.json }), served: ReadServed.none };
    const sets = CoachDocuments.numbered(last.sets);
    const name = last.session.name;
    /** @type {Printed} */
    const printed = { exerciseId: last.exerciseId.json, session: sessionDocument(last.session), ...(name ? { routine: name } : {}), sets: sets.map(setDocument) };
    return { printed, served: sets.reduce((served, set) => served.sawSet(set), ReadServed.none.sawSession(last.session)) };
  }
}

// `list_routines`: the routines most recently trained first, each with the proposal waiting on it.
export class ProgramRead {
  scope = Routine.scope;
  refusals = GymRefusals;

  /** @param {Id<RoutineValue> | null} routineId */
  constructor(routineId) { this.routineId = routineId; }

  /** @param {Reader} read */
  load(read) {
    const history = new TrainingHistory(read);
    const proposals = read.repository(Proposal);
    const rc = (/** @type {ProposalValue} */ value) => Number(proposals.record(value.id.record, 'drawn')?.rc ?? 0);
    const pending = proposals.all('drawn').filter((value) => value.state === 'pending').sort((a, b) => rc(b) - rc(a) || Id.compare(b.id, a.id));
    /** @param {Id<RoutineValue>} id */
    const lastTrainedAt = (id) => history.log.drawnSessions.find((session) => session.routineId?.equals(id))?.startedAt ?? null;
    const program = read.repository(Routine).all('drawn').filter((value) => value.entries.length > 0)
      .sort((a, b) => (lastTrainedAt(b.id)?.ms ?? -1) - (lastTrainedAt(a.id)?.ms ?? -1) || a.position - b.position || Id.compare(a.id, b.id));
    return program.map((routine) => ({ id: routine.id,
      printed: CoachDocuments.routine(routine, lastTrainedAt(routine.id), pending.find((proposal) => proposal.routineId.equals(routine.id)) ?? null) }));
  }

  /** @param {ReturnType<ProgramRead['load']>} program @param {IDSource} ids */
  decide(program, ids) {
    const routineId = this.routineId;
    if (routineId === null) return Decision.unchanged(new AbilityAnswer({ routines: program.map((line) => line.printed) }));
    const listed = program.find((line) => line.id.equals(routineId));
    if (!listed) return Decision.refuse(gone(routineId));
    return Decision.unchanged(new AbilityAnswer({ routines: [listed.printed] }));
  }
}

// `list_exercises`: the catalogue by pattern, then the name the lifter sees, in the server's order (INV-1): its
// `ORDER BY pattern, name` runs under the database's `en_US.UTF-8` collation (`Collation`); patterns are lowercase ASCII
// words, the same order either way. What the collation leaves tied, the id breaks.
export class CatalogueRead {
  scope = Exercise.scope;
  refusals = GymRefusals;

  /** @param {Reader} read */
  load(read) { return new Catalogue(read); }

  /** @param {Catalogue} catalogue @param {IDSource} ids */
  decide(catalogue, ids) {
    const exercises = [...catalogue.exercises].sort((a, b) => compareText(a.pattern, b.pattern) || Collation.compare(a.name, b.name) || Id.compare(a.id, b.id));
    return Decision.unchanged(new AbilityAnswer({ exercises: exercises.map(exerciseDocument) }));
  }
}

// `list_notes`: precedence order, without the id and the instant the model has no use for.
export class NotesRead {
  scope = Note.scope;
  refusals = GymRefusals;

  /** @param {Reader} read */
  load(read) { return { drawn: read.repository(Note).all('drawn'), stored: read.repository(Note).all('stored') }; }

  /** @param {ReturnType<NotesRead['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    return Decision.unchanged(new AbilityAnswer({ notes: loaded.drawn.map((note) => ({
      position: Math.max(0, loaded.stored.findIndex((each) => each.id.equals(note.id))), title: note.title, body: note.body })) }));
  }
}

// `list_bodyweight`: day ascending between two inclusive days, either open.
export class BodyweightRead {
  scope = WeighIn.scope;
  refusals = GymRefusals;

  /** @param {string | null} from @param {string | null} to */
  constructor(from, to) {
    this.from = from;
    this.to = to;
  }

  /** @param {Reader} read */
  load(read) { return new Bodyweight(read); }

  /** @param {Bodyweight} bodyweight @param {IDSource} ids */
  decide(bodyweight, ids) {
    /** @param {string} label @param {string | null} text */
    const day = (label, text) => {
      if (text === null) return null;
      const parsed = LocalDay.parse(text);
      if (parsed === null) throw new Violation(WeighInRules.day, new Path(label), { kind: 'custom', custom: 'notADay' });
      return parsed;
    };
    const entries = bodyweight.list(day('from', this.from), day('to', this.to)).map((entry) => ({ dateLocal: entry.day.text, weightKg: entry.kg }));
    return Decision.unchanged(new AbilityAnswer({ entries }));
  }
}

