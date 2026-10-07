// @ts-check

import { Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { roundHalfAway } from '../../../platform/sync/core/values.js';
import { Bodyweight, WeighIn } from './bodyweight.js';
import { Catalogue, Exercise } from './catalogue.js';
import { Proposal } from './gymRules.js';
import { Note } from './notes.js';
import { Preferences, PreferencesValue, restSettings } from './preferences.js';
import { Routine } from './routines.js';
import { SeedExercises } from './seedExercises.js';
import { Session, SessionRules, TrainingSet } from './training.js';
import { GymEstimate, StatsProgress, TrainingLog } from './trainingReads.js';

/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */
/** @typedef {Record<string, any>} Document */
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

/** @param {Document} mark */
function estimate(mark) { return GymEstimate.value(mark.weightKg, mark.reps, 'working', mark.rpe ?? null); }

export class TrainingHistory {
  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  constructor(read) {
    this.read = read;
    this.log = new TrainingLog(read);
    this.catalogue = new Catalogue(read);
    Object.freeze(this);
  }

  get finished() { return this.log.drawnSessions.filter((session) => !session.isOpen); }

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

  /** @param {readonly SessionValue[]} sessions */
  marks(sessions) {
    /** @type {Document[]} */
    const marks = [];
    for (const session of [...sessions].sort(ascending)) for (const set of working(this.log.setsFor(session.id))) {
      const mark = { exerciseId: set.exerciseId.record, weightKg: set.weightKg, reps: set.reps, rpe: set.rpe,
        at: session.startedAt.ms, setId: set.id.record };
      const held = marks.find((entry) => entry.exerciseId === mark.exerciseId && entry.weightKg === mark.weightKg);
      if (!held) marks.push(mark);
      else if (mark.reps > held.reps) Object.assign(held, mark);
    }
    return marks;
  }

  /** @param {SessionValue} session @returns {Document | null} */
  recordAgainst(session) {
    if (session.isOpen || !this.log.firstPullComplete) return null;
    const earned = this.marks([session]);
    const priorSessions = this.finished.filter((prior) => ascending(prior, session) < 0);
    const standing = this.marks(priorSessions);
    const progress = this.log.progress;
    /** @type {Document[]} */
    const candidates = [];
    for (const exerciseId of new Set(earned.map((mark) => mark.exerciseId))) {
      const today = earned.filter((mark) => mark.exerciseId === exerciseId);
      const priors = standing.filter((mark) => mark.exerciseId === exerciseId);
      /** @param {Document[]} marks */
      const heavy = (marks) => [...marks].sort((a, b) => b.weightKg - a.weightKg || b.reps - a.reps || a.at - b.at || compareText(a.setId, b.setId))[0];
      /** @param {string} kind @param {Document} mark @param {number} value @param {number} previous @param {number} previousAt */
      const add = (kind, mark, value, previous, previousAt) => candidates.push({ kind, exerciseId, value,
        weightKg: mark.weightKg, reps: mark.reps, previous, previousAt, at: mark.at, e1rm: estimate(mark) ?? 0 });
      const estimates = progress.movement(new Id(exerciseId, Exercise)).estimates;
      const currentEstimate = estimates.find((point) => point.id.equals(session.id))?.fact.estimate;
      const priorPoint = estimates.filter((point) => priorSessions.some((value) => value.id.equals(point.id)))
        .sort((a, b) => (b.fact.estimate?.e1rm ?? 0) - (a.fact.estimate?.e1rm ?? 0) || a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id))[0];
      const priorEstimate = priorPoint?.fact.estimate;
      if (currentEstimate && priorEstimate && currentEstimate.e1rm > priorEstimate.e1rm) {
        add('e1rm', { ...currentEstimate.json, at: session.startedAt.ms }, currentEstimate.e1rm, priorEstimate.e1rm, priorPoint.startedAt.ms);
      }
      const currentLoad = heavy(today); const priorLoad = heavy(priors);
      if (currentLoad && priorLoad && currentLoad.weightKg > priorLoad.weightKg) add('heaviest', currentLoad, currentLoad.weightKg, priorLoad.weightKg, priorLoad.at);
      for (const mark of today) {
        const prior = priors.find((held) => held.weightKg === mark.weightKg);
        if (prior && mark.reps > prior.reps) add('reps-at-weight', mark, mark.reps, prior.reps, prior.at);
      }
    }
    /** @type {Record<string, number>} */
    const ranks = { e1rm: 0, heaviest: 1, 'reps-at-weight': 2 };
    candidates.sort((a, b) => (ranks[a.kind] ?? 0) - (ranks[b.kind] ?? 0) || b.e1rm - a.e1rm || b.weightKg - a.weightKg || a.at - b.at || compareText(a.exerciseId, b.exerciseId));
    const first = candidates[0];
    if (!first) return null;
    const { at, e1rm, ...record } = first;
    return record;
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
        exercises: [...new Set(held.flatMap((set) => { const exercise = this.catalogue.find(set.exerciseId); return exercise ? [exercise.name] : []; }))].sort(compareText),
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
    const scoped = this.scopedSessions(query);
    const progress = this.log.progress;
    return StatsProgress.fromSessions(progress.sessions.filter((session) => scoped.some((value) => value.id.equals(session.sessionId))),
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
        const known = this.catalogue.find(new Id(id, Exercise));
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
      const names = held.map((set) => this.catalogue.find(set.exerciseId)?.name ?? '');
      return { id: session.id.record, startedAt: session.startedAt.ms, finishedAt: session.finishedAt?.ms,
        ...(session.historyRoutineId === null ? {} : { routineId: session.historyRoutineId.record }), routineName: session.name ?? '',
        setCount: held.length, workingSetCount: worked.length, reps: count.reps, tonnageKg: count.tonnageKg,
        sets: held.map((set) => { const { kind, note, ...fields } = setDocument(set); return { ...fields, exercise: this.catalogue.find(set.exerciseId)?.name ?? '' }; }),
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
  proposals({ routineId, state } = {}) {
    return this.read.repository(Proposal).all('drawn').map((value) => {
      const row = this.read.repository(Proposal).record(value.id.record, 'drawn');
      if (!row) throw new Error('a proposal read has its record');
      const f = Fields.record(row);
      /** @type {Document} */
      const source = { door: f.string('door', 'ask') };
      for (const name of ['connection', 'agent']) { const text = f.optionalString(name); if (text) source[name] = text; }
      const thread = f.optionalString('threadId'); if (thread) source.thread = thread;
      const createdAt = row.rc ?? this.read.confirmed(Proposal, value.id)?.rc;
      const changeCount = f.optionalInt('changeCount'); const settledAt = f.optionalInstant('settledAt');
      return { id: value.id.record, routineId: f.ref('routineId', Routine).record, intent: f.string('intent'), state: f.string('state', 'pending'), summary: f.string('summary', ''), source,
        ...(createdAt == null ? {} : { createdAt }), ...(changeCount === null ? {} : { changeCount }), ...(settledAt === null ? {} : { settledAt: settledAt.ms }) };
    }).filter((head) => (routineId === undefined || head.routineId === routineId) && (state !== 'pending' || head.state === 'pending'))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || compareText(String(b.id), String(a.id)));
  }

  /** @param {string} id @returns {Document | null} */
  proposal(id) {
    const head = this.proposals().find((value) => value.id === id);
    const row = this.read.repository(Proposal).record(id, 'drawn');
    if (!head || !row) return null;
    const f = Fields.record(row);
    const changes = f.list('changes', (change) => change.values).map((change, index) => ({ position: index + 1, ...change,
      ...(change.kind === 'removed' ? { loggedSets: this.log.sets.filter((set) => set.exerciseId.record === change.exerciseId && this.log.sessions.some((session) => session.id.equals(set.sessionId))).length } : {}) }));
    const baseRevision = f.optionalInt('baseRevision'); const baseName = f.optionalString('baseName');
    return { ...head, name: f.string('proposedName', ''), changes,
      ...(baseRevision === null ? {} : { baseRevision }), ...(baseName === null ? {} : { baseName }) };
  }

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
    const sets = this.read.repository(TrainingSet).all('stored');
    return this.read.repository(Session).all('stored').some((session) => {
      if (SessionRules.drawn(session, sets, this.read.moment.now).isOpen) return false;
      return session.startedAt.ms >= from && session.startedAt.ms < until
        && (!routine || session.historyRoutineId?.record === routine)
        && (!exercise || sets.some((set) => set.sessionId.equals(session.id) && set.exerciseId.record === exercise));
    });
  }
}
