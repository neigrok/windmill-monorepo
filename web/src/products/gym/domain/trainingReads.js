// @ts-check

import { Id } from '../../../platform/domain-kit/entities.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { precondition } from '../../../platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { roundHalfAway, roundToQuantum } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { Exercise } from './catalogue.js';
import { GymEstimate, Session, SessionRules, TrainingSet } from './training.js';
import { GymUnits, WeightLadder } from './units.js';
export { GymEstimate, SessionRules, SetRules } from './training.js';

/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('../../../platform/domain-kit/time.js').Zone} Zone */
/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineEntry} RoutineEntry */
/** @typedef {import('./routines.js').SetTarget} SetTarget */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */

export class TrainingLog {
  /** @type {Map<string, readonly TrainingSetValue[]>} */
  #setsBySession;
  /** @type {Map<string, SessionValue>} */
  #drawnById;
  /** @type {StatsProgress | null} */
  #progress = null;

  /** @param {Reader} read */
  constructor(read) {
    this.sessions = Object.freeze(read.repository(Session).all('drawn'));
    this.sets = Object.freeze(read.repository(TrainingSet).all('drawn'));
    this.moment = read.moment;
    this.firstPullComplete = read.firstPullComplete();
    /** @type {Map<string, TrainingSetValue[]>} */
    const groups = new Map(this.sessions.map((session) => [jcs(session.id.json), []]));
    for (const set of this.sets) groups.get(jcs(set.sessionId.json))?.push(set);
    this.#setsBySession = new Map([...groups].map(([id, sets]) => [id,
      Object.freeze(sets.sort((a, b) => a.completedAt.ms - b.completedAt.ms || Id.compare(a.id, b.id)))]));
    this.drawnSessions = Object.freeze(this.sessions.map((session) => SessionRules.drawn(session, this.setsFor(session.id), this.moment.now))
      .sort((a, b) => b.startedAt.ms - a.startedAt.ms || Id.compare(a.id, b.id)));
    this.#drawnById = new Map(this.drawnSessions.map((session) => [jcs(session.id.json), session]));
    Object.freeze(this);
  }

  get open() { return this.drawnSessions.find((session) => session.isOpen) ?? null; }
  get liveHint() { return this.open !== null; }
  get progress() { return this.#progress ??= new StatsProgress(this); }

  /** @param {Id<SessionValue>} sessionId */
  setsFor(sessionId) {
    return sessionId.entity.type === Session.type ? this.#setsBySession.get(jcs(sessionId.json)) ?? Object.freeze([]) : Object.freeze([]);
  }

  /** @param {Id<SessionValue>} sessionId */
  volumeKg(sessionId) { return this.setsFor(sessionId).reduce((sum, set) => sum + set.volumeKg, 0); }

  /** @param {Id<SessionValue>} sessionId */
  topE1rm(sessionId) {
    const estimates = this.setsFor(sessionId).flatMap((set) => set.e1rm === null ? [] : [set.e1rm]);
    return estimates.length === 0 ? null : Math.max(...estimates);
  }

  /** @param {Id<SessionValue>} sessionId */
  readout(sessionId) {
    const session = sessionId.entity.type === Session.type ? this.#drawnById.get(jcs(sessionId.json)) : null;
    return session ? new SessionReadout(session, this.setsFor(sessionId)) : null;
  }

  /** @param {Id<ExerciseValue>} exerciseId */
  lastTime(exerciseId) { return LastTime.of(exerciseId, this); }
}

export class SessionReadout {
  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets */
  constructor(session, sets) {
    const own = sets.filter((set) => set.sessionId.equals(session.id));
    const estimates = own.flatMap((set) => set.e1rm === null ? [] : [set.e1rm]);
    this.sessionId = session.id;
    this.name = session.name;
    this.durationMs = session.finishedAt === null ? null : Math.max(0, session.finishedAt.ms - session.startedAt.ms);
    this.workingSetCount = own.filter((set) => set.kind === 'working').length;
    this.movementCount = new Set(own.map((set) => jcs(set.exerciseId.json))).size;
    this.volumeKg = own.reduce((sum, set) => sum + set.volumeKg, 0);
    this.topE1rm = estimates.length === 0 ? null : Math.max(...estimates);
    Object.freeze(this);
  }
}

export class LastTime {
  /** @param {Id<ExerciseValue>} exerciseId @param {SessionValue | null} session @param {readonly TrainingSetValue[]} sets @param {boolean} isComplete */
  constructor(exerciseId, session = null, sets = [], isComplete = true) {
    this.exerciseId = exerciseId;
    this.session = session;
    this.sets = Object.freeze([...sets]);
    this.isComplete = isComplete;
    Object.freeze(this);
  }

  get routine() { return this.session?.name ?? null; }
  get isFirstTime() { return this.isComplete && this.session === null; }

  /** @param {Id<ExerciseValue>} exerciseId @param {TrainingLog} log */
  static of(exerciseId, log) {
    for (const session of log.drawnSessions) {
      if (session.isOpen) continue;
      const sets = log.setsFor(session.id).filter((set) => set.exerciseId.equals(exerciseId) && set.kind !== 'warmup');
      if (sets.length > 0) return new LastTime(exerciseId, session, sets, log.firstPullComplete);
    }
    return new LastTime(exerciseId, null, [], log.firstPullComplete);
  }
}

export class Prefill {
  static emptyBarKg = 20;
  static emptyBarReps = 5;

  /** @param {number} weightKg @param {number} reps */
  constructor(weightKg = Prefill.emptyBarKg, reps = Prefill.emptyBarReps) {
    this.weightKg = weightKg;
    this.reps = Math.max(1, reps);
    Object.freeze(this);
  }

  /** @param {readonly TrainingSetValue[]} todaySets @param {RoutineEntry | null} planEntry @param {LastTime | null} lastTime */
  static of(todaySets, planEntry, lastTime) {
    const scheme = planEntry?.sets ?? [];
    const working = todaySets.filter((set) => set.kind === 'working');
    const sticky = working.at(-1);
    const history = lastTime?.sets ?? [];
    const first = scheme[0];
    const straight = first === undefined || scheme.every((set) => set.reps === first.reps && set.weightKg === first.weightKg);
    if (scheme.length > 0 && !straight) {
      const slot = scheme[working.length];
      const lastNth = history.filter((set) => set.kind === 'working')[working.length];
      return new Prefill(slot?.weightKg ?? lastNth?.weightKg ?? sticky?.weightKg ?? Prefill.emptyBarKg,
        slot?.reps ?? lastNth?.reps ?? sticky?.reps ?? Prefill.emptyBarReps);
    }
    if (sticky) return new Prefill(sticky.weightKg, sticky.reps);
    return new Prefill(first?.weightKg ?? history.at(-1)?.weightKg ?? Prefill.emptyBarKg,
      first?.reps ?? history[0]?.reps ?? Prefill.emptyBarReps);
  }
}

export class PerformedFact {
  /** @param {Pick<TrainingSetValue, 'id' | 'weightKg' | 'reps' | 'rpe'>} set */
  constructor(set) {
    this.setId = set.id;
    this.weightKg = set.weightKg;
    this.reps = set.reps;
    this.rpe = set.rpe;
    Object.freeze(this);
  }

  get json() {
    return { setId: this.setId.json, weightKg: this.weightKg, reps: this.reps, ...(this.rpe === null ? {} : { rpe: this.rpe }) };
  }
}

export class EstimatedFact {
  /** @param {Pick<TrainingSetValue, 'id' | 'weightKg' | 'reps' | 'rpe'>} set @param {number} e1rm */
  constructor(set, e1rm) {
    this.performed = new PerformedFact(set);
    this.e1rm = e1rm;
    this.score = GymEstimate.score(set.weightKg, set.reps, 'working', set.rpe) ?? 0;
    Object.freeze(this);
  }

  get setId() { return this.performed.setId; }
  get weightKg() { return this.performed.weightKg; }
  get reps() { return this.performed.reps; }
  get rpe() { return this.performed.rpe; }
  get json() { return { ...this.performed.json, e1rm: this.e1rm }; }
}

export class MovementSessionFact {
  /** @param {Id<ExerciseValue>} exerciseId @param {number} workingSetCount @param {PerformedFact} heaviest @param {PerformedFact} mostReps @param {EstimatedFact | null} estimate @param {PerformedFact | null} bodyweightReps */
  constructor(exerciseId, workingSetCount, heaviest, mostReps, estimate = null, bodyweightReps = null) {
    this.exerciseId = exerciseId;
    this.workingSetCount = workingSetCount;
    this.heaviest = heaviest;
    this.mostReps = mostReps;
    this.estimate = estimate;
    this.bodyweightReps = bodyweightReps;
    Object.freeze(this);
  }

  get json() {
    return { exerciseId: this.exerciseId.json, workingSetCount: this.workingSetCount, heaviest: this.heaviest.json,
      ...(this.estimate === null ? {} : { estimate: this.estimate.json }) };
  }
}

export class ProgressSession {
  /** @param {Id<SessionValue>} sessionId @param {Instant} startedAt @param {readonly MovementSessionFact[]} movements */
  constructor(sessionId, startedAt, movements) {
    this.sessionId = sessionId;
    this.startedAt = startedAt;
    this.movements = Object.freeze([...movements]);
    Object.freeze(this);
  }

  get json() { return { sessionId: this.sessionId.json, startedAt: this.startedAt.ms, movements: this.movements.map((movement) => movement.json) }; }
}

export class StatsProgress {
  /** @type {Map<string, ProgressSession>} */
  #sessionsById = new Map();
  /** @type {Map<string, MovementProgress>} */
  #movements = new Map();

  /** @param {TrainingLog | readonly ProgressSession[]} source @param {Instant | null} asOf @param {boolean} isComplete */
  constructor(source, asOf = null, isComplete = true) {
    if (!(source instanceof TrainingLog)) {
      precondition(asOf !== null, 'a progress snapshot supplies its as-of instant');
      this.asOf = asOf;
      this.isComplete = isComplete;
      this.sessions = Object.freeze([...source].sort((a, b) => a.startedAt.ms - b.startedAt.ms || Id.compare(a.sessionId, b.sessionId)));
    } else {
      const log = source;
      this.asOf = asOf ?? log.moment.now;
      this.isComplete = log.firstPullComplete;
      this.sessions = Object.freeze(log.drawnSessions.filter((session) => !session.isOpen).flatMap((session) => {
        /** @type {Map<string, TrainingSetValue[]>} */
        const groups = new Map();
        for (const set of log.setsFor(session.id).filter((set) => set.kind === 'working')) {
          const key = jcs(set.exerciseId.json);
          const group = groups.get(key);
          if (group) group.push(set);
          else groups.set(key, [set]);
        }
        const movements = [...groups.values()].flatMap((sets) => {
          const heaviest = [...sets].sort((a, b) => b.weightKg - a.weightKg || b.reps - a.reps || Id.compare(a.id, b.id))[0];
          const mostReps = [...sets].sort((a, b) => b.reps - a.reps || b.weightKg - a.weightKg || Id.compare(a.id, b.id))[0];
          if (!heaviest || !mostReps) return [];
          const bodyweight = sets.filter((set) => set.weightKg === 0).sort((a, b) => b.reps - a.reps || Id.compare(a.id, b.id))[0];
          const estimate = sets.flatMap((set) => set.e1rm === null ? [] : [new EstimatedFact(set, set.e1rm)])
            .sort((a, b) => b.score - a.score || Id.compare(a.setId, b.setId))[0] ?? null;
          return [new MovementSessionFact(heaviest.exerciseId, sets.length, new PerformedFact(heaviest), new PerformedFact(mostReps), estimate,
            bodyweight ? new PerformedFact(bodyweight) : null)];
        }).sort((a, b) => Id.compare(a.exerciseId, b.exerciseId));
        return movements.length === 0 ? [] : [new ProgressSession(session.id, session.startedAt, movements)];
      }).sort((a, b) => a.startedAt.ms - b.startedAt.ms || Id.compare(a.sessionId, b.sessionId)));
    }
    /** @type {Map<string, { id: Id<ExerciseValue>, points: MovementPoint[] }>} */
    const movements = new Map();
    for (const session of this.sessions) {
      this.#sessionsById.set(jcs(session.sessionId.json), session);
      for (const fact of session.movements) {
        const key = jcs(fact.exerciseId.json);
        const group = movements.get(key) ?? { id: fact.exerciseId, points: [] };
        group.points.push(Object.freeze({ id: session.sessionId, startedAt: session.startedAt, fact }));
        movements.set(key, group);
      }
    }
    for (const [key, group] of movements) this.#movements.set(key, new MovementProgress(group.id, group.points, this.isComplete));
    Object.freeze(this);
  }

  get json() { return { asOf: this.asOf.ms, sessions: this.sessions.map((session) => session.json) }; }

  /** @param {readonly ProgressSession[]} sessions @param {Instant} asOf @param {boolean} isComplete */
  static fromSessions(sessions, asOf, isComplete = true) { return new StatsProgress(sessions, asOf, isComplete); }

  /** @param {Id<ExerciseValue>} exerciseId */
  movement(exerciseId) {
    return (exerciseId.entity.type === Exercise.type ? this.#movements.get(jcs(exerciseId.json)) : null)
      ?? new MovementProgress(exerciseId, [], this.isComplete);
  }

  /** @param {Id<SessionValue>} id */
  sessionEstimate(id) {
    if (id.entity.type !== Session.type) return null;
    const estimates = this.#sessionsById.get(jcs(id.json))?.movements
      .flatMap((movement) => movement.estimate === null ? [] : [movement.estimate.e1rm]) ?? [];
    return estimates.length === 0 ? null : Math.max(...estimates);
  }

  /** @param {Instant} now @param {Zone} zone */
  consistency(now, zone) {
    if (!this.isComplete) return null;
    const today = LocalDay.in(now, zone);
    const monday = today.adding(1 - today.weekday);
    const weeks = new Set(this.sessions.map((session) => {
      const day = LocalDay.in(session.startedAt, zone);
      return day.adding(1 - day.weekday).text;
    }));
    if (weeks.size < 2) return null;
    const count = [0, 1, 2, 3].filter((index) => weeks.has(monday.adding(-7 * index).text)).length;
    return count === 0 ? null : count;
  }
}

/** @typedef {{ readonly id: Id<SessionValue>, readonly startedAt: Instant, readonly fact: MovementSessionFact }} MovementPoint */

export class MovementProgress {
  static gapDays = 21;

  /** @param {Id<ExerciseValue>} exerciseId @param {readonly MovementPoint[]} sessions @param {boolean} isComplete */
  constructor(exerciseId, sessions, isComplete = true) {
    this.exerciseId = exerciseId;
    this.sessions = Object.freeze([...sessions].sort((a, b) => a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id)));
    this.isComplete = isComplete;
    Object.freeze(this);
  }

  get estimates() { return Object.freeze(this.sessions.filter((point) => point.fact.estimate !== null)); }
  get latest() { return this.estimates.at(-1) ?? null; }

  get best() {
    if (!this.isComplete) return null;
    return [...this.estimates].sort((a, b) => (b.fact.estimate?.score ?? 0) - (a.fact.estimate?.score ?? 0)
      || a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id))[0] ?? null;
  }

  get heaviest() {
    if (!this.isComplete) return null;
    return [...this.sessions].sort((a, b) => b.fact.heaviest.weightKg - a.fact.heaviest.weightKg
      || b.fact.heaviest.reps - a.fact.heaviest.reps || a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id))[0] ?? null;
  }

  get mostReps() {
    if (!this.isComplete) return null;
    return [...this.sessions].sort((a, b) => b.fact.mostReps.reps - a.fact.mostReps.reps
      || b.fact.mostReps.weightKg - a.fact.mostReps.weightKg || a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id))[0] ?? null;
  }

  get bodyweightReps() {
    if (!this.isComplete) return null;
    return this.sessions.filter((point) => point.fact.bodyweightReps !== null)
      .sort((a, b) => (b.fact.bodyweightReps?.reps ?? 0) - (a.fact.bodyweightReps?.reps ?? 0)
        || a.startedAt.ms - b.startedAt.ms || Id.compare(a.id, b.id))[0] ?? null;
  }

  get records() {
    /** @type {MovementPoint[]} */
    const records = [];
    if (!this.isComplete) return Object.freeze(records);
    for (const point of this.estimates) {
      if ((point.fact.estimate?.score ?? 0) > (records.at(-1)?.fact.estimate?.score ?? 0)) records.push(point);
    }
    return Object.freeze(records);
  }

  /** @param {Instant} now @param {Zone} zone */
  chartWindow(now, zone) {
    const start = LocalDay.in(now, zone).adding(-84);
    return new MovementProgress(this.exerciseId, this.sessions.filter((point) =>
      point.startedAt.ms <= now.ms && LocalDay.compare(LocalDay.in(point.startedAt, zone), start) >= 0), this.isComplete);
  }

  /** @param {Zone} zone */
  hasChart(zone) {
    if (!this.isComplete) return false;
    const points = this.estimates;
    const first = points[0];
    const last = points.at(-1);
    return points.length >= 4 && first !== undefined && last !== undefined
      && LocalDay.in(first.startedAt, zone).daysUntil(LocalDay.in(last.startedAt, zone)) >= 21;
  }

  /** @param {Zone} zone */
  gaps(zone) {
    const points = this.estimates;
    return Object.freeze(points.flatMap((before, index) => {
      const after = points[index + 1];
      return after && LocalDay.in(before.startedAt, zone).daysUntil(LocalDay.in(after.startedAt, zone)) > MovementProgress.gapDays
        ? [Object.freeze({ before, after })] : [];
    }));
  }
}

const months = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

export const Readout = Object.freeze({
  noRoutine: 'Free session',
  openTarget: 'open',
  /** @param {number} kg @param {GymUnits} units */
  weight(kg, units = GymUnits.kg) {
    const value = WeightLadder.round(units.display(kg));
    if (!Number.isFinite(value)) return String(value);
    const hundredths = roundHalfAway(Math.abs(value) * 100);
    const whole = String(Math.trunc(hundredths / 100));
    const tail = hundredths % 100;
    const digits = tail === 0 ? whole : tail % 10 === 0 ? `${whole}.${tail / 10}` : `${whole}.${String(tail).padStart(2, '0')}`;
    return (value < 0 ? '−' : '') + digits;
  },
  /** @param {number} weightKg @param {number} reps @param {GymUnits} units */
  effort(weightKg, reps, units = GymUnits.kg) { return `${Readout.weight(weightKg, units)} × ${reps}`; },
  /** @param {number} e1rm @param {GymUnits} units */
  estimatedWeight(e1rm, units = GymUnits.kg) {
    const displayed = units.value === 'lb' ? e1rm / GymUnits.kilogramsPerPound : e1rm;
    return Readout.weight(roundToQuantum(displayed, 0.1));
  },
  /** @param {number} e1rm @param {GymUnits} units */
  estimate(e1rm, units = GymUnits.kg) { return `e1RM ${Readout.estimatedWeight(e1rm, units)}`; },
  /** @param {number | null} reps */
  repTarget(reps) { return reps === null ? 'max' : String(reps); },
  /** @param {SetTarget} set */
  setTarget(set) { return `${set.weightKg === null ? 'last' : Readout.weight(set.weightKg)} × ${Readout.repTarget(set.reps)}`; },
  /** @param {readonly SetTarget[]} sets */
  ladder(sets) { return sets.map(Readout.setTarget).join(' · '); },
  /** @param {readonly SetTarget[] | null} sets */
  target(sets) {
    if (sets === null || sets.length === 0) return Readout.openTarget;
    const reps = sets.flatMap((set) => set.reps === null ? [] : [set.reps]);
    const loads = sets.flatMap((set) => set.weightKg === null ? [] : [WeightLadder.round(set.weightKg)]);
    const lowReps = Math.min(...reps);
    const highReps = Math.max(...reps);
    const repColumn = reps.length === 0 ? 'max' : reps.length < sets.length ? `${lowReps}–max`
      : lowReps === highReps ? String(lowReps) : `${lowReps}–${highReps}`;
    if (loads.length === 0) return `${sets.length} × ${repColumn}`;
    const low = Math.min(...loads);
    const high = Math.max(...loads);
    const load = loads.length < sets.length ? `${Readout.weight(low)}–last`
      : low === high ? Readout.weight(low) : `${Readout.weight(low)}–${Readout.weight(high)}`;
    return `${sets.length} × ${repColumn} · ${load}`;
  },
  /** @param {number} kg */
  tonnes(kg) {
    if (!Number.isFinite(kg) || kg <= 0) return null;
    const tenths = roundHalfAway(kg / 100);
    return tenths > 0 ? `${Math.trunc(tenths / 10)}.${tenths % 10} t` : null;
  },
  /** @param {number} milliseconds */
  duration(milliseconds) {
    const minutes = Math.max(1, Math.trunc(milliseconds / 60_000));
    return minutes < 60 ? `${minutes}m` : `${Math.trunc(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  },
  /** @param {Instant} instant @param {Instant} now @param {Zone} zone */
  briefDay(instant, now, zone) {
    const day = LocalDay.in(instant, zone);
    const today = LocalDay.in(now, zone);
    if (LocalDay.compare(day, today) === 0) return 'today';
    const date = `${day.day} ${months[day.month - 1]}`;
    return day.year === today.year ? date : `${date} ${day.year}`;
  },
  /** @param {Instant} instant @param {Instant} now @param {Zone} zone */
  ago(instant, now, zone) {
    const days = LocalDay.in(instant, zone).daysUntil(LocalDay.in(now, zone));
    if (days <= 0) return 'today';
    return days === 1 ? 'yesterday' : `${days} days ago`;
  },
});
