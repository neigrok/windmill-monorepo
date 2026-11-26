import { Id } from '../../../platform/domain-kit/entities.js';
import { restSettings } from '../domain/preferences.js';
import { Routine } from '../domain/routines.js';
import { Session } from '../domain/training.js';
import { sessionDocument, setDocument } from '../domain/trainingHistory.js';
import { Prefill, RestTarget, TrainingLog } from '../domain/trainingReads.js';
import { PlanChanges } from '../domain/workoutPlan.js';
import { WorkoutRack } from '../domain/workoutRack.js';
import { t } from '../i18n/index.js';
import { clockOf, fmt } from '../log.js';

// The account's open workout as its pages draw it, read from the browser's copy and settled the way its rows will be
// written: the movements in their order with each one's plan entry and set rail, the one in hand with its ledger and the
// rack, the set on offer once the rows hold it, what its clocks count from, and whether its rest sounds when it comes to
// its target (Rest sound). Null while no workout is open.
export function workoutView(read) {
  const log = new TrainingLog(read);
  const open = log.open;
  if (open === null) return null;
  const rack = WorkoutRack.of(read, open.id);
  const rows = rack.settled();
  const rest = restSettings(read);
  const movement = rows.movement;
  const latest = rack.sets.at(-1) ?? null;
  const movements = rows.order.map((exerciseId) => {
    const entry = rack.entry(exerciseId);
    const logged = rack.setsOf(exerciseId).length;
    const targets = entry?.sets?.length ?? 0;
    const inHand = movement !== null && exerciseId.equals(movement);
    return {
      exerciseId: String(exerciseId.record), entry: entry?.json ?? null, logged, targets, inHand,
      editable: entry !== null && logged === 0,
      ticks: Array.from({ length: Math.max(targets, logged) }, (_, at) => (at < logged ? 'landed' : at === logged && inHand ? 'in-hand' : 'to-come')),
    };
  });
  const place = movements.findIndex((each) => each.inHand);
  const current = movements[place] ?? null;
  return {
    id: String(open.id.record),
    name: open.name,
    startedAt: open.startedAt.ms,
    plan: open.plan?.json ?? null,
    firstPullComplete: log.firstPullComplete,
    settled: rack.isSettled,
    offer: rack.isSettled ? rows.offer : null,
    movements,
    movement: current,
    next: current !== null && current.targets > 0 && current.logged >= current.targets ? movements[place + 1] ?? null : null,
    rack: rows.rack === null ? null : { weightKg: rows.rack.weightKg, reps: rows.rack.reps },
    ledger: movement === null ? [] : ledgerRows(rack, movement, rows.rack),
    restSeconds: movement === null ? null : RestTarget.of(rack.entry(movement), rest)?.seconds ?? null,
    lastSetAt: latest?.completedAt.ms ?? null,
    latestSetId: latest === null ? null : String(latest.id.record),
    setCount: rack.sets.length,
    restSound: rest.sound,
  };
}

// One movement's ledger (iOS 03.34): the sets logged, as lifted; then the set in hand and the plan still ahead, each at
// the load the plan expects of it, which no set logged today changes, `—` while last time is not read; or, past the plan
// or with none, the next set as the rack holds it.
function ledgerRows(rack, movement, held) {
  const sets = rack.setsOf(movement);
  const entry = rack.entry(movement);
  const targets = entry?.sets ?? [];
  const logged = sets.map((set, at) => ({ key: String(set.id.record), kind: 'logged', ordinal: at + 1,
    reading: `${fmt(set.weightKg)} × ${set.reps}`, set: { id: String(set.id.record), weightKg: set.weightKg, reps: set.reps } }));
  if (sets.length >= targets.length) {
    return [...logged, { key: 'open', kind: 'open', ordinal: sets.length + 1, reading: held === null ? '' : `${fmt(held.weightKg)} × ${held.reps}` }];
  }
  const expected = Prefill.expectedLoads(sets.length, entry, rack.lastTime(movement));
  return [...logged, ...targets.slice(sets.length).map((target, at) => {
    const load = expected[at] ?? null;
    return { key: `slot-${sets.length + at}`, kind: at === 0 ? 'current' : 'planned', ordinal: sets.length + at + 1,
      reading: `${load === null ? '—' : fmt(load)} × ${target.reps ?? t('gym.workout.maxReps')}` };
  })];
}

// A number as typed, a comma or a typographic minus read as a point or a minus; null for anything else, the empty field
// included.
export function typedNumber(text) {
  const value = Number(String(text).trim().replace(',', '.').replace('−', '-'));
  return String(text).trim() !== '' && Number.isFinite(value) ? value : null;
}

// The clocks at `now`, the server's time: the workout's from its start, the rest's from the latest set, and whether the
// rest has come to its target. Every reading is an instant's distance, never a count, so a tab that wakes reads true.
export function clocksAt(view, now) {
  const sinceMs = view.lastSetAt === null ? null : Math.max(0, now - view.lastSetAt);
  return {
    workoutMs: Math.max(0, now - view.startedAt),
    sinceMs,
    reached: view.restSeconds !== null && sinceMs !== null && new RestTarget(view.restSeconds).isReached(sinceMs),
  };
}

// A clock in words, its empty parts left out: *2 minutes 14 seconds*.
export function spokenClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [
    [Math.floor(total / 3600), (count) => t('gym.workout.hours', { count })],
    [Math.floor(total % 3600 / 60), (count) => t('gym.workout.minutes', { count })],
    [total % 60, (count) => t('gym.workout.seconds', { count })],
  ].filter(([count]) => count > 0).map(([count, say]) => say(count));
  return parts.length ? parts.join(' ') : t('gym.workout.seconds', { count: 0 });
}

// The tab's title while the workout is open (WD2.5): the rest's clock first so a narrow tab still shows it, then the
// routine; before the first set the workout's own clock.
export function tabTitle(view, now) {
  const { workoutMs, sinceMs } = clocksAt(view, now);
  return t('gym.workout.tabTitle', { clock: clockOf(sinceMs ?? workoutMs), name: view.name ?? t('gym.workout.untitled') });
}

// A finished workout's receipt, from the copy: the workout and its sets, its volume, each movement's sets in the order
// first done, and the plan changes the workout made against its routine as the routine stands now (iOS 03.32).
export function receiptOf(read, record) {
  const id = new Id(record, Session);
  const log = new TrainingLog(read);
  const session = log.drawnSessions.find((each) => each.id.equals(id)) ?? null;
  if (session === null) return null;
  const sets = log.setsFor(id);
  const routine = session.routineId === null ? null : read.repository(Routine).find(session.routineId, 'drawn');
  const changes = PlanChanges.between(read.repository(Session).find(id, 'drawn'), routine);
  const movements = [];
  for (const set of sets) {
    const exerciseId = String(set.exerciseId.record);
    const group = movements.find((each) => each.exerciseId === exerciseId);
    if (group) group.sets.push(setDocument(set));
    else movements.push({ exerciseId, sets: [setDocument(set)] });
  }
  return {
    session: { ...sessionDocument(session), isOpen: session.isOpen, name: session.name },
    sets: sets.map(setDocument),
    volumeKg: log.volumeKg(id),
    movements,
    changes: changes.json,
    routine: routine === null ? null : { id: String(routine.id.record), ...routine.fields() },
  };
}
