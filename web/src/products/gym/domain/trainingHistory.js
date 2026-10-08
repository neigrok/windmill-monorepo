// @ts-check

import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { roundHalfAway } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { Bodyweight, WeighIn } from './bodyweight.js';
import { Catalogue, Exercise } from './catalogue.js';
import { Proposal } from './proposals.js';
import { Note } from './notes.js';
import { Preferences, PreferencesValue, restSettings } from './preferences.js';
import { Routine } from './routines.js';
import { SeedExercises } from './seedExercises.js';
import { Session, SessionRules, TrainingSet } from './training.js';
import { GymEstimate, StatsProgress, TrainingLog } from './trainingReads.js';

/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('./proposals.js').ProposalValue} ProposalValue */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */
/** @typedef {Record<string, any>} Document */
/** @typedef {{ exerciseId: import('../../../platform/domain-kit/entities.js').RecordID, weightKg: number, reps: number, rpe: number | null,
 * at: number, setId: import('../../../platform/domain-kit/entities.js').RecordID }} Mark */
/** @typedef {{ marks: Map<number, Mark>, heaviest: Mark | null,
 * estimate: { fact: import('./trainingReads.js').EstimatedFact, at: number } | null }} Standing */
/** @typedef {{before?: number, beforeId?: string, limit?: number, from?: number, until?: number, exercise?: string, routine?: string, projection?: string}} HistoryQuery */

/** @param {SessionValue} value @returns {Document} */
export function sessionDocument(value) {
  return { id: value.id.record, startedAt: value.startedAt.ms,
    ...(value.finishedAt === null ? {} : { finishedAt: value.finishedAt.ms }),
    ...(value.routineId === null ? {} : { routineId: value.routineId.record }),
    ...(value.plan === null ? {} : { plan: value.plan.json }),
    ...(value.displayName === null ? {} : { routineName: value.displayName }) };
}

/** @param {TrainingSetValue} value @returns {Document} */
export function setDocument(value) {
  return { id: value.id.record, exerciseId: value.exerciseId.record, ...(value.setNumber === null ? {} : { setNumber: value.setNumber }),
    weightKg: value.weightKg, reps: value.reps, kind: value.kind, note: value.note, completedAt: value.completedAt.ms,
    ...(value.rpe === null ? {} : { rpe: value.rpe }) };
}

/** @param {Reader} read @param {ProposalValue} value @returns {Document} */
function proposalHead(read, value) {
  const createdAt = read.repository(Proposal).record(value.id.record, 'stored')?.rc
    ?? read.repository(Proposal).record(value.id.record, 'drawn')?.rc ?? read.confirmed(Proposal, value.id)?.rc;
  const source = { door: value.door, ...(value.connection ? { connection: value.connection } : {}),
    ...(value.agent ? { agent: value.agent } : {}), ...(value.threadId ? { thread: value.threadId } : {}) };
  return { id: value.id.record, routineId: value.routineId.record, intent: value.intent, state: value.state,
    summary: value.summary, ...(createdAt == null ? {} : { createdAt }), source,
    ...(value.changeCount === null ? {} : { changeCount: value.changeCount }),
    ...(value.settledAt === null ? {} : { settledAt: value.settledAt.ms }) };
}

/** @param {Reader} read @param {{routineId?: string, state?: string}} query @returns {Document[]} */
export function proposalsDocument(read, { routineId, state } = {}) {
  return read.repository(Proposal).all('drawn').map((value) => proposalHead(read, value))
    .filter((head) => (routineId === undefined || head.routineId === routineId) && (state !== 'pending' || head.state === 'pending'))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || compareText(String(b.id), String(a.id)));
}

/** @param {Reader} read @param {ProposalValue | null} value @returns {Document | null} */
export function proposalDocument(read, value) {
  if (!value) return null;
  const sessions = new Set(read.views.visible('drawn', 'session').map((row) => row.id));
  const sets = read.repository(TrainingSet).all('drawn').filter((set) => sessions.has(set.sessionId.record));
  return { ...proposalHead(read, value), name: value.proposedName,
    changes: value.changes.map((change, index) => ({ position: index + 1, ...change.json,
      ...(change.kind !== 'added' ? { before: change.before?.json ?? {} } : {}),
      ...(change.kind !== 'removed' ? { after: change.after?.json ?? {} } : {}),
      ...(change.kind === 'removed' ? { loggedSets: sets.filter((set) => set.exerciseId.equals(change.exerciseId)).length } : {}) })),
    ...(value.baseRevision === null ? {} : { baseRevision: value.baseRevision }),
    ...(value.baseName === null ? {} : { baseName: value.baseName }) };
}

/** @param {readonly TrainingSetValue[]} sets */
function working(sets) { return sets.filter((set) => set.kind === 'working'); }

/** @param {readonly TrainingSetValue[]} sets */
function totals(sets) {
  return { sets: sets.length, reps: sets.reduce((sum, set) => sum + set.reps, 0),
    tonnageKg: sets.reduce((sum, set) => sum + Math.max(0, roundHalfAway(set.weightKg * 100)) * set.reps, 0) / 100 };
}

/** @param {readonly TrainingSetValue[]} sets */
function topSet(sets) {
  return [...sets].sort((a, b) => b.weightKg - a.weightKg || b.reps - a.reps || Id.compare(a.id, b.id))[0] ?? null;
}

/** @param {SessionValue} a @param {SessionValue} b */
function ascending(a, b) { return a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id); }

/** @param {readonly SessionValue[]} sessions @param {HistoryQuery} query */
function pageOf(sessions, { before = SessionRules.maxInstantMs, beforeId = '', limit = 50 }) {
  const count = Math.min(200, limit > 0 ? Number(limit) : 50);
  const matching = sessions.filter((session) => session.startedAt.ms < Number(before)
    || (session.startedAt.ms === Number(before) && compareText(String(session.id.record), beforeId) > 0));
  const page = matching.slice(0, count);
  const last = page.at(-1);
  return { page, next: matching.length > count && last ? { before: last.startedAt.ms, beforeId: last.id.record } : null };
}

export class TrainingHistory {
  /** @type {Map<string, Document | null> | null} */
  #records = null;
  /** @type {Map<string, import('./catalogue.js').ExerciseValue>} */
  #exercisesById;

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  constructor(read) {
    this.read = read;
    this.log = new TrainingLog(read);
    this.catalogue = new Catalogue(read);
    this.finished = Object.freeze(this.log.drawnSessions.filter((session) => !session.isOpen));
    this.#exercisesById = new Map(this.catalogue.exercises.map((exercise) => [jcs(exercise.id.json), exercise]));
    Object.freeze(this);
  }

  exercises() {
    return this.catalogue.exercises.map((value) => ({ id: value.id.record, ...value.fields(),
      custom: !SeedExercises.all.some((seed) => seed.id.equals(value.id)),
      ...(value.aliases.length ? { aliases: [...value.aliases] } : {}) }))
      .sort((a, b) => compareText(a.pattern, b.pattern) || compareText(a.name, b.name) || compareText(String(a.id), String(b.id)));
  }

  /** @param {string} id */
  session(id) {
    const session = this.log.drawnSessions.find((value) => value.id.record === id);
    return session ? { session: sessionDocument(session), sets: this.log.setsFor(session.id).map(setDocument) } : null;
  }

  /** @param {string} id */
  set(id) { const set = this.log.sets.find((value) => value.id.record === id); return set ? setDocument(set) : null; }

  liveHint() { return this.log.liveHint; }

  /** @param {SessionValue} session @returns {Document | null} */
  recordAgainst(session) {
    if (session.isOpen || !this.log.firstPullComplete) return null;
    if (this.#records === null) {
      /** @type {Map<string, Document | null>} */
      const records = new Map();
      /** @type {Map<string, Standing>} */
      const standing = new Map();
      for (const point of this.log.progress.sessions) {
        /** @type {Map<string, Map<number, Mark>>} */
        const earned = new Map();
        for (const set of working(this.log.setsFor(point.sessionId))) {
          const key = jcs(set.exerciseId.json);
          const marks = earned.get(key) ?? new Map();
          const held = marks.get(set.weightKg);
          if (!held || set.reps > held.reps) marks.set(set.weightKg, { exerciseId: set.exerciseId.record,
            weightKg: set.weightKg, reps: set.reps, rpe: set.rpe, at: point.startedAt.ms, setId: set.id.record });
          earned.set(key, marks);
        }
        /** @type {Document[]} */
        const candidates = [];
        for (const fact of point.movements) {
          const key = jcs(fact.exerciseId.json);
          const today = earned.get(key) ?? new Map();
          /** @type {Standing} */
          const prior = standing.get(key) ?? { marks: new Map(), heaviest: null, estimate: null };
          /** @param {string} kind @param {Document} mark @param {number} value @param {number} previous @param {number} previousAt */
          const add = (kind, mark, value, previous, previousAt) => candidates.push({ kind, exerciseId: fact.exerciseId.record,
            value, weightKg: mark.weightKg, reps: mark.reps, previous, previousAt, at: point.startedAt.ms,
            score: GymEstimate.score(mark.weightKg, mark.reps, 'working', mark.rpe ?? null) ?? 0 });
          const currentEstimate = fact.estimate;
          if (currentEstimate && prior.estimate && currentEstimate.score > prior.estimate.fact.score) {
            add('e1rm', currentEstimate, currentEstimate.e1rm, prior.estimate.fact.e1rm, prior.estimate.at);
          }
          const currentLoad = [...today.values()].reduce((best, mark) => best === null || mark.weightKg > best.weightKg ? mark : best,
            /** @type {Mark | null} */ (null));
          if (currentLoad && prior.heaviest && currentLoad.weightKg > prior.heaviest.weightKg) {
            add('heaviest', currentLoad, currentLoad.weightKg, prior.heaviest.weightKg, prior.heaviest.at);
          }
          for (const mark of today.values()) {
            const held = prior.marks.get(mark.weightKg);
            if (held && mark.reps > held.reps) add('reps-at-weight', mark, mark.reps, held.reps, held.at);
            if (!held || mark.reps > held.reps) prior.marks.set(mark.weightKg, mark);
          }
          if (currentLoad && (!prior.heaviest || currentLoad.weightKg > prior.heaviest.weightKg
            || (currentLoad.weightKg === prior.heaviest.weightKg && currentLoad.reps > prior.heaviest.reps))) prior.heaviest = currentLoad;
          if (currentEstimate && (!prior.estimate || currentEstimate.score > prior.estimate.fact.score)) {
            prior.estimate = { fact: currentEstimate, at: point.startedAt.ms };
          }
          standing.set(key, prior);
        }
        /** @type {Record<string, number>} */
        const ranks = { e1rm: 0, heaviest: 1, 'reps-at-weight': 2 };
        candidates.sort((a, b) => (ranks[a.kind] ?? 0) - (ranks[b.kind] ?? 0) || b.score - a.score
          || b.weightKg - a.weightKg || a.at - b.at || compareText(a.exerciseId, b.exerciseId));
        const first = candidates[0];
        if (!first) records.set(jcs(point.sessionId.json), null);
        else {
          const { at, score, ...record } = first;
          records.set(jcs(point.sessionId.json), Object.freeze(record));
        }
      }
      this.#records = records;
    }
    const record = this.#records.get(jcs(session.id.json));
    return record ? { ...record } : null;
  }

  /** @param {string} id @returns {Document | null} */
  review(id) {
    const session = this.log.drawnSessions.find((value) => value.id.record === id);
    if (!session) return null;
    const held = this.log.setsFor(session.id);
    const readout = this.log.readout(session.id);
    const topE1rm = readout?.topE1rm;
    const stats = { durationMs: readout?.durationMs ?? Math.max(0, SessionRules.lastActivity(session, held).ms - session.startedAt.ms),
      workingSets: working(held).length, ...(topE1rm == null ? {} : { topE1rm }) };
    /** @type {Document} */
    const review = { stats, slight: stats.workingSets < 4 };
    if (review.slight) return review;
    const record = this.log.firstPullComplete ? this.recordAgainst(session) : null;
    if (record) review.record = record;
    const routineId = session.routineId;
    const previous = routineId ? this.finished.find((prior) => prior.routineId?.equals(routineId) && ascending(prior, session) < 0) : null;
    if (!previous) return review;
    /** @param {TrainingSetValue[]} sets */
    const top = (sets) => { const value = topSet(sets); return value ? { weightKg: value.weightKg, reps: value.reps,
      sets: sets.filter((set) => set.weightKg === value.weightKg).length } : null; };
    const movements = [...new Set(working(held).map((set) => String(set.exerciseId.record)))].map((exerciseId) => {
      const before = top(working(this.log.setsFor(previous.id)).filter((set) => set.exerciseId.record === exerciseId));
      const plan = session.plan?.entries.find((entry) => entry.exerciseId.record === exerciseId);
      return { exerciseId, now: top(working(held).filter((set) => set.exerciseId.record === exerciseId)),
        ...(before ? { before } : {}), ...(plan ? { planned: plan.sets ? { sets: plan.sets.map((set) => set.json) } : {} } : {}) };
    });
    review.against = { sessionId: previous.id.record, ...(previous.plan?.routine ? { routine: previous.plan.routine } : {}), startedAt: previous.startedAt.ms, movements };
    return review;
  }

  /** @param {HistoryQuery} query */
  sessions(query = {}) {
    return pageOf(this.log.drawnSessions, query).page.map((session) => {
      const held = this.log.setsFor(session.id); const worked = working(held); const top = topSet(worked);
      const topE1rm = this.log.topE1rm(session.id);
      return { ...sessionDocument(session), setCount: held.length, workingSetCount: worked.length, tonnageKg: totals(worked).tonnageKg,
        exercises: [...new Set(held.flatMap((set) => { const exercise = this.#exercisesById.get(jcs(set.exerciseId.json)); return exercise ? [exercise.name] : []; }))].sort(compareText),
        ...(top ? { topSet: { weightKg: top.weightKg, reps: top.reps } } : {}), ...(topE1rm === null ? {} : { topE1rm }),
        record: this.log.firstPullComplete && worked.length >= 4 && this.recordAgainst(session) !== null,
        closedItself: session.closedBy ? session.closedBy === 'stale' : session.finishedAt?.ms === SessionRules.lastActivity(session, held).ms };
    });
  }

  /** @param {string} exerciseId */
  lastTime(exerciseId) {
    const last = this.log.lastTime(new Id(exerciseId, Exercise));
    return { exerciseId, ...(last.session ? { session: sessionDocument(last.session),
      ...(last.routine === null ? {} : { routine: last.routine }), sets: [...last.sets].sort((a, b) => (a.setNumber ?? 0) - (b.setNumber ?? 0) || Id.compare(a.id, b.id)).map(setDocument) } : {}) };
  }

  lastSets() {
    return [...new Set(this.finished.flatMap((session) => this.log.setsFor(session.id).filter((set) => set.kind !== 'warmup').map((set) => String(set.exerciseId.record))))]
      .sort(compareText).flatMap((exerciseId) => {
        const last = this.lastTime(exerciseId); const set = last.sets?.at(-1);
        return set ? [{ exerciseId, weightKg: set.weightKg, reps: set.reps, at: last.session?.startedAt }] : [];
      });
  }

  progress() { return this.log.progress.json; }

  /** @param {HistoryQuery} query */
  scopedSessions({ from = 0, until = SessionRules.maxInstantMs, exercise = '', routine = '' } = {}) {
    return this.finished.filter((session) => session.startedAt.ms >= Number(from) && session.startedAt.ms < Number(until)
      && (!exercise || this.log.setsFor(session.id).some((set) => set.exerciseId.record === exercise)) && (!routine || session.historyRoutineId?.record === routine));
  }

  /** @param {HistoryQuery} query */
  progressIn(query = {}) {
    const scoped = new Set(this.scopedSessions(query).map((session) => jcs(session.id.json)));
    const progress = this.log.progress;
    return StatsProgress.fromSessions(progress.sessions.filter((session) => scoped.has(jcs(session.sessionId.json))),
      progress.asOf, progress.isComplete);
  }

  /** @param {HistoryQuery} query */
  history(query = {}) {
    const scoped = this.scopedSessions(query);
    const { page, next } = pageOf(scoped, query);
    /** @type {Map<string, number>} */
    const months = new Map();
    /** @type {Map<string, Document>} */
    const exercises = new Map();
    /** @type {Map<string, Document>} */
    const routines = new Map();
    for (const session of scoped) {
      const month = LocalDay.in(session.startedAt, this.read.moment.zone).text.slice(0, 7);
      months.set(month, (months.get(month) ?? 0) + 1);
      for (const id of new Set(this.log.setsFor(session.id).map((set) => String(set.exerciseId.record)))) {
        const known = this.#exercisesById.get(jcs(id));
        const facet = exercises.get(id) ?? { id, name: known?.name ?? '', sessions: 0, ...(known?.equipment ? { equipment: known.equipment } : {}) };
        facet.sessions += 1; exercises.set(id, facet);
      }
      const id = session.historyRoutineId?.record;
      if (typeof id === 'string') {
        const facet = routines.get(id) ?? { id, name: session.name ?? '', sessions: 0 };
        facet.sessions += 1; routines.set(id, facet);
      }
    }
    /** @param {Document} a @param {Document} b */
    const facetOrder = (a, b) => compareText(a.name, b.name) || compareText(a.id, b.id);
    const total = totals(scoped.flatMap((session) => working(this.log.setsFor(session.id))));
    return { sessions: page.map((session) => {
      const held = this.log.setsFor(session.id); const worked = working(held); const count = totals(worked);
      const names = held.map((set) => this.#exercisesById.get(jcs(set.exerciseId.json))?.name ?? '');
      return { id: session.id.record, startedAt: session.startedAt.ms, finishedAt: session.finishedAt?.ms,
        ...(session.historyRoutineId === null ? {} : { routineId: session.historyRoutineId.record }), routineName: session.name ?? '',
        setCount: held.length, workingSetCount: worked.length, reps: count.reps, tonnageKg: count.tonnageKg,
        sets: held.map((set) => { const { kind, note, ...fields } = setDocument(set); return { ...fields, exercise: this.#exercisesById.get(jcs(set.exerciseId.json))?.name ?? '' }; }),
        movements: [...new Set(held.map((set) => String(set.exerciseId.record)))].sort(compareText).map((exerciseId) => ({ exerciseId, ...totals(worked.filter((set) => set.exerciseId.record === exerciseId)) })),
        exerciseNames: [...new Set(names)].sort(compareText) };
    }), summary: { sessions: scoped.length, ...total },
    months: [...months].sort(([a], [b]) => compareText(b, a)).map(([month, sessions]) => ({ month, sessions })),
    exercises: [...exercises.values()].sort(facetOrder), routines: [...routines.values()].sort(facetOrder),
    ...(query.projection === 'progress' ? { progress: this.progressIn(query).json } : {}), next };
  }

  /** @param {string} exerciseId @returns {Document | null} */
  record(exerciseId) {
    const exercise = this.exercises().find((value) => value.id === exerciseId);
    if (!exercise) return null;
    const movement = this.log.progress.movement(new Id(exerciseId, Exercise));
    const routines = this.read.repository(Routine).all('drawn').filter((value) => value.entries.some((entry) => entry.exerciseId.record === exerciseId))
      .sort((a, b) => a.position - b.position || Id.compare(a.id, b.id));
    /** @param {any} point @param {'estimate' | 'heaviest'} field */
    const fact = (point, field) => { const value = point.fact[field]; const e1rm = field === 'estimate' ? value.e1rm : GymEstimate.value(value.weightKg, value.reps, 'working', value.rpe);
      return { weightKg: value.weightKg, reps: value.reps, at: point.startedAt.ms, ...(e1rm === null ? {} : { e1rm }) }; };
    const series = movement.chartWindow(this.read.moment.now, this.read.moment.zone).estimates.map((point) => fact(point, 'estimate'));
    const records = movement.records.map((point) => fact(point, 'estimate')).reverse();
    const recentDays = this.finished.filter((session) => this.log.setsFor(session.id).some((set) => set.exerciseId.record === exerciseId && set.kind !== 'warmup')).slice(0, 10)
      .map((session) => ({ sessionId: session.id.record, startedAt: session.startedAt.ms, sets: this.log.setsFor(session.id).filter((set) => set.exerciseId.record === exerciseId && set.kind !== 'warmup')
        .sort((a, b) => (a.setNumber ?? 0) - (b.setNumber ?? 0) || Id.compare(a.id, b.id)).map(setDocument) }));
    return { exercise, routineCount: routines.length, sessionCount: movement.sessions.length,
      ...(routines.length ? { routines: routines.map((value) => value.name) } : {}),
      ...(movement.best ? { bestE1rm: fact(movement.best, 'estimate') } : {}), ...(movement.heaviest ? { heaviest: fact(movement.heaviest, 'heaviest') } : {}),
      ...(series.length ? { e1rmSeries: series } : {}), ...(records.length ? { records } : {}), ...(recentDays.length ? { recentDays } : {}) };
  }

  stats() {
    /** @param {SessionValue} session */
    const weekOf = (session) => { const day = LocalDay.from(session.startedAt, 0); return day.adding(1 - day.weekday).daysSinceEpoch * 86400000; };
    const finished = this.finished; const first = finished.at(-1); const last = finished[0];
    const weeks = [];
    if (first && last) for (let startedAt = weekOf(first); startedAt <= weekOf(last); startedAt += 7 * 86400000) {
      const trained = finished.filter((session) => weekOf(session) === startedAt);
      weeks.push({ startedAt, sessions: trained.length, workingSets: trained.reduce((sum, session) => sum + working(this.log.setsFor(session.id)).length, 0) });
    }
    const movements = [...new Set(this.log.progress.sessions.flatMap((session) => session.movements.map((movement) => String(movement.exerciseId.record))))].map((exerciseId) => {
      const progress = this.log.progress.movement(new Id(exerciseId, Exercise));
      const record = this.record(exerciseId);
      return { exerciseId, lastTrainedAt: progress.sessions.at(-1)?.startedAt.ms,
        points: progress.sessions.map((point) => { const value = point.fact.heaviest; const e1rm = GymEstimate.value(value.weightKg, value.reps, 'working', value.rpe);
          return { at: point.startedAt.ms, weightKg: value.weightKg, reps: value.reps, ...(e1rm === null ? {} : { e1rm }) }; }),
        ...(record?.bestE1rm ? { bestE1rm: record.bestE1rm } : {}), ...(record?.heaviest ? { heaviest: record.heaviest } : {}) };
    }).sort((a, b) => (b.lastTrainedAt ?? 0) - (a.lastTrainedAt ?? 0) || compareText(a.exerciseId, b.exerciseId));
    return { weeks, movements };
  }

  /** @param {{routineId?: string, state?: string}} query @returns {Document[]} */
  proposals(query = {}) { return proposalsDocument(this.read, query); }

  /** @param {string} id @returns {Document | null} */
  proposal(id) { return proposalDocument(this.read, this.read.repository(Proposal).find(new Id(id, Proposal), 'drawn')); }

  /** @returns {Document[]} */
  routines() {
    const heads = this.proposals();
    return this.read.repository(Routine).all('drawn').filter((value) => value.entries.length).map((value) => {
      const trained = this.log.drawnSessions.find((session) => session.routineId?.equals(value.id));
      const pending = heads.find((head) => head.routineId === value.id.record && head.state === 'pending');
      return { id: value.id.record, name: value.name, position: value.position, entries: value.entries.map((entry, index) => ({ position: index + 1, ...entry.json })),
        ...(value.revision === null ? {} : { revision: value.revision }), ...(trained ? { lastTrainedAt: trained.startedAt.ms } : {}), ...(pending ? { pendingProposal: pending } : {}) };
    }).sort((a, b) => (b.lastTrainedAt ?? -1) - (a.lastTrainedAt ?? -1) || a.position - b.position || compareText(String(a.id), String(b.id)));
  }

  /** @param {string} id @returns {Document | null} */
  routine(id) {
    const routine = this.routines().find((value) => value.id === id);
    if (!routine) return null;
    const value = this.read.repository(Routine).find(new Id(id, Routine), 'drawn');
    if (!value) return null;
    const createdAt = this.read.repository(Routine).record(id, 'drawn')?.rc ?? this.read.confirmed(Routine, value.id)?.rc;
    const created = { kind: 'created', ...(createdAt == null ? {} : { at: createdAt }), ...(value.createdDoor ? { by: value.createdDoor } : {}),
      ...(value.createdEntries === null ? {} : { movements: value.createdEntries }) };
    return { ...routine, history: [...this.proposals({ routineId: id }).slice(0, 20).map((proposal) => ({ kind: 'proposal',
      ...(proposal.createdAt === undefined ? {} : { at: proposal.createdAt }), proposal })), created] };
  }

  preferences() {
    const id = new Id('prefs', Preferences); const value = this.read.repository(Preferences).find(id, 'drawn') ?? new PreferencesValue(id);
    const rest = restSettings(this.read);
    return { ...value.fields(), restSound: rest.sound, ...(rest.seconds === null ? {} : { restSeconds: rest.seconds }) };
  }

  notes() {
    const notes = this.read.repository(Note); const stored = notes.all('stored');
    return notes.all('drawn').map((value) => ({ id: value.id.record, position: stored.findIndex((each) => each.id.equals(value.id)), ...value.fields(),
      ...(value.updatedAt === null ? {} : { updatedAt: value.updatedAt.ms }) }));
  }

  /** @param {{from?: string, to?: string}} bounds */
  bodyweight({ from, to } = {}) {
    const weights = new Bodyweight(this.read);
    /** @param {import('./bodyweight.js').BodyweightEntry} entry */
    const form = (entry) => ({ dateLocal: entry.day.text, weightKg: entry.kg,
      recordedAt: this.read.repository(WeighIn).find(Id.ofDay(entry.day, WeighIn), 'drawn')?.recordedAt?.ms ?? null });
    return { entries: weights.list(from ? LocalDay.parse(from) : null, to ? LocalDay.parse(to) : null).map(form), latest: weights.reading ? form(weights.reading.entry) : null };
  }

  /** @param {HistoryQuery} query */
  hasStoredSessions({ from = 0, until = SessionRules.maxInstantMs, exercise = '', routine = '' } = {}) {
    /** @type {Map<string, TrainingSetValue[]>} */
    const sets = new Map();
    for (const set of this.read.repository(TrainingSet).all('stored')) {
      const key = jcs(set.sessionId.json);
      const own = sets.get(key) ?? [];
      own.push(set);
      sets.set(key, own);
    }
    return this.read.repository(Session).all('stored').some((session) => {
      if (session.startedAt.ms < from || session.startedAt.ms >= until || (routine && session.historyRoutineId?.record !== routine)) return false;
      const own = sets.get(jcs(session.id.json)) ?? [];
      return (!exercise || own.some((set) => set.exerciseId.record === exercise))
        && !SessionRules.drawn(session, own, this.read.moment.now).isOpen;
    });
  }
}
