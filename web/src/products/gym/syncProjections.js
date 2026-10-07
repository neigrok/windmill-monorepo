import { Reader, Views } from '../../platform/domain-kit/reading.js';
import { Instant, Moment } from '../../platform/domain-kit/time.js';
import { registry } from '../../platform/sync/schema.js';
import { bodyweightDocument, namedZone, preferencesDocument } from './gymRuntime.js';

// Global seed movements are outside sync scopes (engine A.2). Kept equal to schema.sql.
export const GYM_SEED_CATALOG = [
  { id: 'back-squat', name: 'Back Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'front-squat', name: 'Front Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'goblet-squat', name: 'Goblet Squat', pattern: 'squat', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'bulgarian-split-squat', name: 'Bulgarian Split Squat', pattern: 'squat', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'walking-lunge', name: 'Walking Lunge', pattern: 'squat', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'step-up', name: 'Step Up', pattern: 'squat', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'leg-press', name: 'Leg Press', pattern: 'squat', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'hack-squat', name: 'Hack Squat', pattern: 'squat', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'deadlift', name: 'Deadlift', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'sumo-deadlift', name: 'Sumo Deadlift', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'trap-bar-deadlift', name: 'Trap Bar Deadlift', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'good-morning', name: 'Good Morning', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'hip-thrust', name: 'Hip Thrust', pattern: 'hinge', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'back-extension', name: 'Back Extension', pattern: 'hinge', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'kettlebell-swing', name: 'Kettlebell Swing', pattern: 'hinge', equipment: 'kettlebell', stepKg: 4.0, custom: false },
  { id: 'bench-press', name: 'Bench Press', pattern: 'press', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'incline-bench-press', name: 'Incline Bench Press', pattern: 'press', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'close-grip-bench-press', name: 'Close Grip Bench Press', pattern: 'press', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'overhead-press', name: 'Overhead Press', pattern: 'press', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'push-press', name: 'Push Press', pattern: 'press', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'dumbbell-bench-press', name: 'Dumbbell Bench Press', pattern: 'press', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'incline-dumbbell-press', name: 'Incline Dumbbell Press', pattern: 'press', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'dumbbell-shoulder-press', name: 'Dumbbell Shoulder Press', pattern: 'press', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'machine-chest-press', name: 'Machine Chest Press', pattern: 'press', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'machine-shoulder-press', name: 'Machine Shoulder Press', pattern: 'press', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'dip', name: 'Dip', pattern: 'press', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'push-up', name: 'Push Up', pattern: 'press', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'pull-up', name: 'Pull Up', pattern: 'pull', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'chin-up', name: 'Chin Up', pattern: 'pull', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'muscle-up', name: 'Muscle Up', pattern: 'pull', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'lat-pulldown', name: 'Lat Pulldown', pattern: 'pull', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'barbell-row', name: 'Barbell Row', pattern: 'pull', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'dumbbell-row', name: 'Dumbbell Row', pattern: 'pull', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'chest-supported-row', name: 'Chest Supported Row', pattern: 'pull', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'seated-cable-row', name: 'Seated Cable Row', pattern: 'pull', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'face-pull', name: 'Face Pull', pattern: 'pull', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'barbell-shrug', name: 'Barbell Shrug', pattern: 'pull', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'inverted-row', name: 'Inverted Row', pattern: 'pull', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'farmers-carry', name: 'Farmers Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'suitcase-carry', name: 'Suitcase Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'overhead-carry', name: 'Overhead Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'plank', name: 'Plank', pattern: 'core', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', pattern: 'core', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'ab-wheel-rollout', name: 'Ab Wheel Rollout', pattern: 'core', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'cable-crunch', name: 'Cable Crunch', pattern: 'core', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'pallof-press', name: 'Pallof Press', pattern: 'core', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'weighted-sit-up', name: 'Weighted Sit Up', pattern: 'core', equipment: 'bodyweight', stepKg: 2.5, custom: false },
  { id: 'barbell-curl', name: 'Barbell Curl', pattern: 'isolation', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'dumbbell-curl', name: 'Dumbbell Curl', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'hammer-curl', name: 'Hammer Curl', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'triceps-pushdown', name: 'Triceps Pushdown', pattern: 'isolation', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'skull-crusher', name: 'Skull Crusher', pattern: 'isolation', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'overhead-triceps-extension', name: 'Overhead Triceps Extension', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'lateral-raise', name: 'Lateral Raise', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'dumbbell-fly', name: 'Dumbbell Fly', pattern: 'isolation', equipment: 'dumbbell', stepKg: 2.0, custom: false },
  { id: 'cable-fly', name: 'Cable Fly', pattern: 'isolation', equipment: 'cable', stepKg: 2.5, custom: false },
  { id: 'leg-extension', name: 'Leg Extension', pattern: 'isolation', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'lying-leg-curl', name: 'Lying Leg Curl', pattern: 'isolation', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'standing-calf-raise', name: 'Standing Calf Raise', pattern: 'isolation', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'seated-calf-raise', name: 'Seated Calf Raise', pattern: 'isolation', equipment: 'machine', stepKg: 5.0, custom: false },
  { id: 'wrist-curl', name: 'Wrist Curl', pattern: 'isolation', equipment: 'barbell', stepKg: 2.5, custom: false },
  { id: 'hip-abduction', name: 'Hip Abduction', pattern: 'isolation', equipment: 'machine', stepKg: 5.0, custom: false },
];

const MAX_INSTANT = 253402300799000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 4 * 60 * 60 * 1000;
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ascending = (a, b) => a.startedAt - b.startedAt || lexical(a.id, b.id);
const chronological = (a, b) => a.completedAt - b.completedAt || a.setNumber - b.setNumber || lexical(a.id, b.id);
const working = (sets) => sets.filter((set) => set.kind === 'working');
const estimate = (set) => set.weightKg > 0 ? Math.round(set.weightKg * (1 + set.reps / 30) * 10) / 10 : undefined;
const field = (row, name) => row?.f?.[name]?.[0] ?? row?.v?.[name];
const defined = (value) => value !== undefined && value !== null;
const topSet = (sets) => sets.reduce((top, set) => !top || set.weightKg > top.weightKg || (set.weightKg === top.weightKg && set.reps > top.reps) ? set : top, null);
const volumeOf = (sets) => sets.reduce((cents, set) => cents + Math.max(0, Math.round(set.weightKg * 100)) * set.reps, 0) / 100;

function targets(entry) {
  const scheme = Array.isArray(entry.sets) && entry.sets.every((set) => set && typeof set === 'object' && !Array.isArray(set) && (!defined(set.reps) || (Number.isInteger(set.reps) && set.reps >= 1 && set.reps <= 100)) && (!defined(set.weightKg) || (typeof set.weightKg === 'number' && set.weightKg >= -500 && set.weightKg <= 500))) ? entry.sets : [];
  return {
    ...(scheme.length ? { sets: scheme.map((set) => ({ ...(defined(set.reps) ? { reps: set.reps } : {}), ...(defined(set.weightKg) ? { weightKg: set.weightKg } : {}) })) } : {}),
    ...(defined(entry.restSeconds) ? { restSeconds: entry.restSeconds } : {}),
  };
}

function sessionOf(row) {
  const session = { id: row.id, startedAt: field(row, 'startedAt') };
  for (const name of ['finishedAt', 'routineId']) if (defined(field(row, name))) session[name] = field(row, name);
  const plan = field(row, 'plan');
  if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
    session.plan = { routine: typeof plan.routine === 'string' ? plan.routine : '', entries: (Array.isArray(plan.entries) ? plan.entries : []).filter((entry) => typeof entry?.exerciseId === 'string' && (!('sets' in entry) || Array.isArray(entry.sets))).map((entry) => ({ exerciseId: entry.exerciseId, ...targets(entry) })) };
  }
  if (defined(field(row, 'displayName'))) session.routineName = field(row, 'displayName');
  return session;
}

function setOf(row) {
  const set = { id: row.id, exerciseId: field(row, 'exerciseId'), setNumber: field(row, 'setNumber'), weightKg: field(row, 'weightKg'), reps: field(row, 'reps'), kind: field(row, 'kind') ?? 'working', note: field(row, 'note') ?? '', completedAt: field(row, 'completedAt') };
  if (defined(field(row, 'rpe'))) set.rpe = field(row, 'rpe');
  return set;
}

function foldMarks(marks, incoming) {
  for (const mark of incoming) {
    const held = marks.find((entry) => entry.exerciseId === mark.exerciseId && entry.weightKg === mark.weightKg);
    if (!held) marks.push({ ...mark });
    else if (mark.reps > held.reps) Object.assign(held, mark);
    else if (mark.reps === held.reps && mark.at < held.at) held.at = mark.at;
  }
  return marks;
}

function marksOf(sets, at) {
  return foldMarks([], working(sets).map((set) => ({ exerciseId: set.exerciseId, weightKg: set.weightKg, reps: set.reps, at: at ?? set.completedAt })));
}

function recordAgainst(earned, standing) {
  const candidates = [];
  for (const exerciseId of new Set(earned.map((mark) => mark.exerciseId))) {
    const today = earned.filter((mark) => mark.exerciseId === exerciseId);
    const priors = standing.filter((mark) => mark.exerciseId === exerciseId);
    const byEstimate = (marks) => marks.reduce((best, mark) => estimate(mark) !== undefined && (!best || estimate(mark) > estimate(best)) ? mark : best, null);
    const byLoad = (marks) => marks.reduce((best, mark) => !best || mark.weightKg > best.weightKg || (mark.weightKg === best.weightKg && (mark.reps > best.reps || (mark.reps === best.reps && mark.at < best.at))) ? mark : best, null);
    const add = (kind, mark, value, previous, previousAt) => candidates.push({ kind, exerciseId, value, weightKg: mark.weightKg, reps: mark.reps, previous, previousAt, at: mark.at, e1rm: estimate(mark) ?? 0 });
    const nowEstimate = byEstimate(today);
    const priorEstimate = byEstimate(priors);
    if (nowEstimate && priorEstimate && estimate(nowEstimate) > estimate(priorEstimate)) add('e1rm', nowEstimate, estimate(nowEstimate), estimate(priorEstimate), priorEstimate.at);
    const nowLoad = byLoad(today);
    const priorLoad = byLoad(priors);
    if (nowLoad && priorLoad && nowLoad.weightKg > priorLoad.weightKg) add('heaviest', nowLoad, nowLoad.weightKg, priorLoad.weightKg, priorLoad.at);
    for (const mark of today) {
      const prior = priors.find((held) => held.weightKg === mark.weightKg);
      if (prior && mark.reps > prior.reps) add('reps-at-weight', mark, mark.reps, prior.reps, prior.at);
    }
  }
  const ranks = { e1rm: 0, heaviest: 1, 'reps-at-weight': 2 };
  candidates.sort((a, b) => ranks[a.kind] - ranks[b.kind] || b.e1rm - a.e1rm || b.weightKg - a.weightKg || a.at - b.at);
  if (candidates.length === 0) return null;
  const { at, e1rm, ...record } = candidates[0];
  return record;
}

function progressOf(sessions, setsFor, now) {
  return { asOf: now, sessions: sessions.filter((session) => working(setsFor(session.id)).length).slice().sort(ascending).map((session) => {
    const sets = working(setsFor(session.id));
    const movements = [...new Set(sets.map((set) => set.exerciseId))].sort(lexical).map((exerciseId) => {
      const performed = (set) => ({ setId: set.id, weightKg: set.weightKg, reps: set.reps, ...(defined(set.rpe) ? { rpe: set.rpe } : {}) });
      const held = sets.filter((set) => set.exerciseId === exerciseId).sort((a, b) => lexical(a.id, b.id));
      const heaviest = topSet(held);
      const mostReps = held.filter((set) => set.weightKg === 0).sort((a, b) => b.reps - a.reps || lexical(a.id, b.id))[0];
      const qualified = held.filter((set) => set.weightKg > 0 && set.reps <= 10 && (!defined(set.rpe) || set.rpe >= 7));
      const e1rm = (set) => set.reps === 1 ? set.weightKg : set.weightKg * (1 + set.reps / 30);
      qualified.sort((a, b) => e1rm(b) - e1rm(a) || lexical(a.id, b.id));
      return { exerciseId, workingSetCount: held.length, heaviest: performed(heaviest), ...(mostReps ? { mostReps: performed(mostReps) } : {}), ...(qualified.length ? { estimate: { ...performed(qualified[0]), e1rm: Number(e1rm(qualified[0]).toPrecision(15)) } } : {}) };
    });
    return { sessionId: session.id, startedAt: session.startedAt, movements };
  }) };
}

// Server-authored fields stay absent until admission; local predictions cannot invent historical metadata.
export function projectGym(rows, { now = Date.now(), timeZone = 'UTC', catalog = GYM_SEED_CATALOG } = {}) {
  const read = () => new Reader(Views.ofRecords(registry, { drawn: rows, stored: rows }), 'self/gym', new Moment(new Instant(now), namedZone(timeZone)));
  const alive = rows.filter((row) => row.life === undefined || row.life[0] === 'alive');
  const ofType = (type) => alive.filter((row) => row.t === type);
  const sessionRows = new Map(ofType('session').map((row) => [row.id, row]));
  const sessions = ofType('session').map(sessionOf).sort((a, b) => ascending(b, a));
  const sets = ofType('set').filter((row) => sessionRows.has(field(row, 'sessionId')));
  const setsBySession = new Map();
  for (const row of sets) {
    const id = field(row, 'sessionId');
    if (!setsBySession.has(id)) setsBySession.set(id, []);
    setsBySession.get(id).push(setOf(row));
  }
  for (const held of setsBySession.values()) held.sort(chronological);
  const setsFor = (id) => setsBySession.get(id) ?? [];
  const staleSessions = new Set();
  for (const session of sessions) {
    if (defined(session.finishedAt)) continue;
    const held = setsFor(session.id);
    const lastActivity = held.length ? Math.max(...held.map((set) => set.completedAt)) : session.startedAt;
    if (now - lastActivity < STALE_MS) continue;
    session.finishedAt = lastActivity;
    staleSessions.add(session.id);
  }
  const finished = sessions.filter((session) => defined(session.finishedAt));
  const nameRows = new Map(ofType('exerciseName').map((row) => [row.id, row]));
  const exercises = catalog.filter((exercise) => !exercise.custom).map((seed) => {
    const row = nameRows.get(seed.id);
    const aliases = field(row, 'aliases');
    return { ...seed, name: field(row, 'name') ?? seed.name, ...(aliases?.length ? { aliases } : {}) };
  });
  for (const row of ofType('exercise')) {
    const exercise = { id: row.id, name: field(row, 'name'), pattern: field(row, 'pattern'), equipment: field(row, 'equipment'), stepKg: field(row, 'stepKg'), custom: true };
    if (field(row, 'aliases')?.length) exercise.aliases = field(row, 'aliases');
    exercises.push(exercise);
  }
  exercises.sort((a, b) => lexical(a.pattern, b.pattern) || lexical(a.name, b.name));
  const exerciseById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const routineRows = ofType('routine');
  const proposalRows = ofType('proposal').sort((a, b) => (b.rc ?? 0) - (a.rc ?? 0) || lexical(b.id, a.id));
  const proposalHead = (row) => {
    const source = { door: field(row, 'door') };
    for (const name of ['connection', 'agent']) if (field(row, name)) source[name] = field(row, name);
    if (field(row, 'threadId')) source.thread = field(row, 'threadId');
    const head = { id: row.id, routineId: field(row, 'routineId'), intent: field(row, 'intent'), state: field(row, 'state') ?? 'pending', summary: field(row, 'summary') ?? '', ...(defined(row.rc) ? { createdAt: row.rc } : {}), source };
    if (defined(field(row, 'changeCount'))) head.changeCount = field(row, 'changeCount');
    if (defined(field(row, 'settledAt'))) head.settledAt = field(row, 'settledAt');
    return head;
  };
  const proposalHeads = proposalRows.map(proposalHead);
  const routines = routineRows.filter((row) => field(row, 'entries')?.length).map((row) => {
    const routine = { id: row.id, name: field(row, 'name'), position: field(row, 'position') ?? 0, entries: field(row, 'entries').map((entry, index) => ({ position: index + 1, exerciseId: entry.exerciseId, ...targets(entry) })) };
    if (defined(field(row, 'revision'))) routine.revision = field(row, 'revision');
    const trained = sessions.filter((session) => session.routineId === row.id);
    if (trained.length) routine.lastTrainedAt = trained[0].startedAt;
    const pending = proposalHeads.find((head) => head.routineId === row.id && head.state === 'pending');
    if (pending) routine.pendingProposal = pending;
    return routine;
  }).sort((a, b) => (b.lastTrainedAt ?? -1) - (a.lastTrainedAt ?? -1) || a.position - b.position || lexical(a.id, b.id));
  const priorMarks = (session, descendingLoads = false) => {
    const marks = foldMarks([], finished.filter((prior) => ascending(prior, session) < 0).slice().sort(ascending).flatMap((prior) => marksOf(setsFor(prior.id), prior.startedAt)));
    return marks.sort((a, b) => lexical(a.exerciseId, b.exerciseId) || (descendingLoads ? b.weightKg - a.weightKg : a.weightKg - b.weightKg));
  };
  const reviewOf = (session) => {
    if (!session) return null;
    const held = setsFor(session.id);
    const earned = marksOf(held);
    const estimates = earned.map(estimate).filter(defined);
    const stats = { durationMs: Math.max(0, (session.finishedAt ?? Math.max(session.startedAt, ...held.map((set) => set.completedAt))) - session.startedAt), workingSets: working(held).length, ...(estimates.length ? { topE1rm: Math.max(...estimates) } : {}) };
    const review = { stats, slight: stats.workingSets < 4 };
    if (review.slight) return review;
    const record = recordAgainst(earned, priorMarks(session));
    if (record) review.record = record;
    const previous = session.routineId ? finished.find((prior) => prior.routineId === session.routineId && ascending(prior, session) < 0) : null;
    if (!previous) return review;
    const top = (sets) => { const set = topSet(sets); return set ? { weightKg: set.weightKg, reps: set.reps, sets: sets.filter((held) => held.weightKg === set.weightKg).length } : null; };
    const movements = [...new Set(earned.map((mark) => mark.exerciseId))].map((exerciseId) => {
      const before = top(working(setsFor(previous.id)).filter((set) => set.exerciseId === exerciseId));
      const plan = session.plan?.entries.find((entry) => entry.exerciseId === exerciseId);
      return { exerciseId, now: top(working(held).filter((set) => set.exerciseId === exerciseId)), ...(before ? { before } : {}), ...(plan ? { planned: plan.sets ? { sets: plan.sets } : {} } : {}) };
    });
    review.against = { sessionId: previous.id, ...(previous.plan?.routine ? { routine: previous.plan.routine } : {}), startedAt: previous.startedAt, movements };
    return review;
  };
  const summaryOf = (session) => {
    const held = setsFor(session.id);
    const worked = working(held);
    const top = topSet(worked);
    const earned = marksOf(held, session.startedAt).sort((a, b) => lexical(a.exerciseId, b.exerciseId) || b.weightKg - a.weightKg);
    const estimates = earned.map(estimate).filter(defined);
    const row = sessionRows.get(session.id);
    const closedBy = staleSessions.has(session.id) ? 'stale' : field(row, 'closedBy');
    return { ...session, setCount: held.length, workingSetCount: worked.length, tonnageKg: volumeOf(worked), exercises: [...new Set(held.map((set) => exerciseById.get(set.exerciseId)?.name).filter(defined))].sort(lexical), ...(top ? { topSet: { weightKg: top.weightKg, reps: top.reps } } : {}), ...(estimates.length ? { topE1rm: Math.max(...estimates) } : {}), record: worked.length >= 4 && Boolean(recordAgainst(earned, priorMarks(session, true))), closedItself: closedBy ? closedBy === 'stale' : defined(session.finishedAt) && session.finishedAt === (held.length ? Math.max(...held.map((set) => set.completedAt)) : session.startedAt) };
  };
  const historyWorkout = (session) => {
    const held = setsFor(session.id);
    const worked = working(held);
    const totals = (sets) => ({ sets: sets.length, reps: sets.reduce((sum, set) => sum + set.reps, 0), tonnageKg: volumeOf(sets) });
    const historyRoutineId = field(sessionRows.get(session.id), 'historyRoutineId');
    return { id: session.id, startedAt: session.startedAt, finishedAt: session.finishedAt, ...(historyRoutineId ? { routineId: historyRoutineId } : {}), routineName: session.routineName ?? session.plan?.routine ?? '', setCount: held.length, workingSetCount: worked.length, reps: totals(worked).reps, tonnageKg: totals(worked).tonnageKg,
      sets: held.map(({ id, exerciseId, setNumber, weightKg, reps, rpe, completedAt }) => ({ id, exerciseId, exercise: exerciseById.get(exerciseId)?.name ?? '', setNumber, weightKg, reps, ...(defined(rpe) ? { rpe } : {}), completedAt })),
      movements: [...new Set(held.map((set) => set.exerciseId))].sort(lexical).map((exerciseId) => ({ exerciseId, ...totals(worked.filter((set) => set.exerciseId === exerciseId)) })), exerciseNames: [...new Set(held.map((set) => exerciseById.get(set.exerciseId)?.name ?? ''))].sort(lexical) };
  };

  return {
    liveHint: () => sessions.some((session) => !defined(session.finishedAt)),
    exercises: () => exercises,
    sessions: ({ before = MAX_INSTANT, beforeId = '', limit = 50 } = {}) => sessions.filter((session) => session.startedAt < Number(before) || (session.startedAt === Number(before) && lexical(session.id, beforeId) < 0)).slice(0, Math.min(200, limit > 0 ? Number(limit) : 50)).map(summaryOf),
    session: (id) => { const session = sessions.find((session) => session.id === id); return session ? { session, sets: setsFor(id) } : null; },
    set: (id) => { const row = ofType('set').find((each) => each.id === id); return row ? setOf(row) : null; },
    review: (id) => reviewOf(sessions.find((session) => session.id === id)),
    preferences: () => preferencesDocument(read()),
    routines: () => routines,
    routine: (id) => {
      const routine = routines.find((routine) => routine.id === id);
      if (!routine) return null;
      const row = routineRows.find((row) => row.id === id);
      const created = { kind: 'created', ...(defined(row.rc) ? { at: row.rc } : {}), ...(field(row, 'createdDoor') ? { by: field(row, 'createdDoor') } : {}) };
      if (defined(field(row, 'createdEntries'))) created.movements = field(row, 'createdEntries');
      return { ...routine, history: [...proposalHeads.filter((head) => head.routineId === id).slice(0, 20).map((proposal) => ({ kind: 'proposal', ...(defined(proposal.createdAt) ? { at: proposal.createdAt } : {}), proposal })), created] };
    },
    proposals: ({ routineId, state } = {}) => proposalHeads.filter((head) => (routineId === undefined || head.routineId === routineId) && (state !== 'pending' || head.state === 'pending')),
    proposal: (id) => {
      const row = proposalRows.find((row) => row.id === id);
      if (!row) return null;
      const changes = (field(row, 'changes') ?? []).map((change, index) => ({ position: index + 1, kind: change.kind, exerciseId: change.exerciseId, ...(change.kind !== 'added' ? { before: targets(change.before ?? {}) } : {}), ...(change.kind !== 'removed' ? { after: targets(change.after ?? {}) } : {}), ...(change.kind === 'removed' ? { loggedSets: sets.filter((set) => field(set, 'exerciseId') === change.exerciseId).length } : {}) }));
      return { ...proposalHead(row), name: field(row, 'proposedName'), changes,
        ...(defined(field(row, 'baseRevision')) ? { baseRevision: field(row, 'baseRevision') } : {}),
        ...(defined(field(row, 'baseName')) ? { baseName: field(row, 'baseName') } : {}) };
    },
    notes: () => ofType('note').slice().sort((a, b) => lexical(field(a, 'ord'), field(b, 'ord')) || lexical(a.id, b.id)).map((row, position) => ({ id: row.id, position, title: field(row, 'title'), body: field(row, 'body'),
      ...(defined(field(row, 'updatedAt')) ? { updatedAt: field(row, 'updatedAt') } : {}) })),
    bodyweight: (bounds) => bodyweightDocument(read(), bounds),
    lastTime: (exerciseId) => {
      const session = finished.find((session) => setsFor(session.id).some((set) => set.exerciseId === exerciseId && set.kind !== 'warmup'));
      if (!session) return { exerciseId };
      const routine = session.routineName ?? session.plan?.routine;
      return { exerciseId, session, ...(routine ? { routine } : {}), sets: setsFor(session.id).filter((set) => set.exerciseId === exerciseId && set.kind !== 'warmup').sort((a, b) => a.setNumber - b.setNumber) };
    },
    lastSets: () => [...new Set(finished.flatMap((session) => setsFor(session.id).filter((set) => set.kind !== 'warmup').map((set) => set.exerciseId)))].sort(lexical).map((exerciseId) => {
      const session = finished.find((session) => setsFor(session.id).some((set) => set.exerciseId === exerciseId && set.kind !== 'warmup'));
      const set = setsFor(session.id).filter((set) => set.exerciseId === exerciseId && set.kind !== 'warmup').sort((a, b) => b.setNumber - a.setNumber)[0];
      return { exerciseId, weightKg: set.weightKg, reps: set.reps, at: session.startedAt };
    }),
    progress: () => progressOf(finished, setsFor, now),
    history: ({ from = 0, until = MAX_INSTANT, exercise = '', routine = '', before = MAX_INSTANT, beforeId = '', limit = 50, timeZone: zone = timeZone, projection } = {}) => {
      const scoped = finished.filter((session) => session.startedAt >= Number(from) && session.startedAt < Number(until) && (!exercise || setsFor(session.id).some((set) => set.exerciseId === exercise)) && (!routine || field(sessionRows.get(session.id), 'historyRoutineId') === routine));
      const page = scoped.filter((session) => session.startedAt < Number(before) || (session.startedAt === Number(before) && lexical(session.id, beforeId) < 0)).slice(0, Number(limit) + 1);
      const hasMore = page.length > Number(limit);
      if (hasMore) page.pop();
      const months = new Map();
      const monthFormat = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit' });
      const exerciseFacets = new Map();
      const routineFacets = new Map();
      let totalSets = 0; let reps = 0; let tonnageCents = 0;
      for (const session of scoped) {
        const parts = monthFormat.formatToParts(new Date(session.startedAt));
        const month = `${parts.find((part) => part.type === 'year').value}-${parts.find((part) => part.type === 'month').value}`;
        months.set(month, (months.get(month) ?? 0) + 1);
        const held = setsFor(session.id);
        for (const set of working(held)) { totalSets += 1; reps += set.reps; tonnageCents += Math.max(0, Math.round(set.weightKg * 100)) * set.reps; }
        for (const id of new Set(held.map((set) => set.exerciseId))) {
          const known = exerciseById.get(id);
          const facet = exerciseFacets.get(id) ?? { id, name: known?.name ?? '', sessions: 0, ...(known?.equipment ? { equipment: known.equipment } : {}) };
          facet.sessions += 1; exerciseFacets.set(id, facet);
        }
        const id = field(sessionRows.get(session.id), 'historyRoutineId');
        if (id) { const facet = routineFacets.get(id) ?? { id, name: session.routineName ?? session.plan?.routine ?? '', sessions: 0 }; facet.sessions += 1; routineFacets.set(id, facet); }
      }
      const facetOrder = (a, b) => lexical(a.name, b.name) || lexical(a.id, b.id);
      const last = page.at(-1);
      return { sessions: page.map(historyWorkout), summary: { sessions: scoped.length, sets: totalSets, reps, tonnageKg: tonnageCents / 100 }, months: [...months].sort(([a], [b]) => lexical(b, a)).map(([month, sessions]) => ({ month, sessions })), exercises: [...exerciseFacets.values()].sort(facetOrder), routines: [...routineFacets.values()].sort(facetOrder), ...(projection === 'progress' ? { progress: progressOf(scoped, setsFor, now) } : {}), next: hasMore && last ? { before: last.startedAt, beforeId: last.id } : null };
    },
    record: (exerciseId) => {
      const exercise = exerciseById.get(exerciseId);
      if (!exercise) return null;
      const relevant = finished.slice().sort(ascending).filter((session) => working(setsFor(session.id)).some((set) => set.exerciseId === exerciseId));
      const record = { exercise, routineCount: 0, sessionCount: relevant.length };
      const heldRoutines = routines.filter((routine) => routine.entries.some((entry) => entry.exerciseId === exerciseId)).sort((a, b) => a.position - b.position || lexical(a.id, b.id));
      record.routineCount = heldRoutines.length;
      if (heldRoutines.length) record.routines = heldRoutines.map((routine) => routine.name);
      const series = []; const records = []; let best = null; let heaviest = null;
      for (const session of relevant) {
        const loads = marksOf(setsFor(session.id), session.startedAt).filter((mark) => mark.exerciseId === exerciseId).sort((a, b) => b.weightKg - a.weightKg);
        for (const load of loads) if (!heaviest || load.weightKg > heaviest.weightKg || (load.weightKg === heaviest.weightKg && load.reps > heaviest.reps)) heaviest = { weightKg: load.weightKg, reps: load.reps, at: session.startedAt, ...(defined(estimate(load)) ? { e1rm: estimate(load) } : {}) };
        const point = loads.reduce((top, load) => defined(estimate(load)) && (!top || estimate(load) > top.e1rm) ? { at: session.startedAt, weightKg: load.weightKg, reps: load.reps, e1rm: estimate(load) } : top, null);
        if (!point) continue;
        if (session.startedAt >= Math.max(0, now - 12 * WEEK_MS)) series.push(point);
        if (best && point.e1rm <= best.e1rm) continue;
        if (best) records.push(point);
        best = point;
      }
      if (best) record.bestE1rm = { weightKg: best.weightKg, reps: best.reps, at: best.at, e1rm: best.e1rm };
      if (heaviest) record.heaviest = heaviest;
      if (series.length) record.e1rmSeries = series;
      if (records.length) record.records = records.reverse();
      const recent = finished.filter((session) => setsFor(session.id).some((set) => set.exerciseId === exerciseId && set.kind !== 'warmup')).slice(0, 10).map((session) => ({ sessionId: session.id, startedAt: session.startedAt, sets: setsFor(session.id).filter((set) => set.exerciseId === exerciseId && set.kind !== 'warmup').sort((a, b) => a.setNumber - b.setNumber) }));
      if (recent.length) record.recentDays = recent;
      return record;
    },
    stats: () => {
      const weekOf = (at) => { const day = new Date(at); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return day.getTime(); };
      const weeks = [];
      if (finished.length) for (let startedAt = weekOf(finished.at(-1).startedAt); startedAt <= weekOf(finished[0].startedAt); startedAt += WEEK_MS) { const trained = finished.filter((session) => weekOf(session.startedAt) === startedAt); weeks.push({ startedAt, sessions: trained.length, workingSets: trained.reduce((sum, session) => sum + working(setsFor(session.id)).length, 0) }); }
      const movements = [...new Set(finished.flatMap((session) => working(setsFor(session.id)).map((set) => set.exerciseId)))].map((exerciseId) => {
        const trained = finished.filter((session) => working(setsFor(session.id)).some((set) => set.exerciseId === exerciseId)).slice().sort(ascending);
        const points = trained.map((session) => { const top = topSet(working(setsFor(session.id)).filter((set) => set.exerciseId === exerciseId)); return { at: session.startedAt, weightKg: top.weightKg, reps: top.reps, ...(defined(estimate(top)) ? { e1rm: estimate(top) } : {}) }; });
        const marks = foldMarks([], trained.flatMap((session) => marksOf(setsFor(session.id), session.startedAt).filter((mark) => mark.exerciseId === exerciseId))).sort((a, b) => a.weightKg - b.weightKg);
        const best = marks.reduce((best, mark) => defined(estimate(mark)) && (!best || estimate(mark) > estimate(best)) ? mark : best, null);
        const heavy = marks.reduce((best, mark) => !best || mark.weightKg > best.weightKg ? mark : best, null);
        const asBest = (mark) => ({ weightKg: mark.weightKg, reps: mark.reps, at: mark.at, ...(defined(estimate(mark)) ? { e1rm: estimate(mark) } : {}) });
        return { exerciseId, lastTrainedAt: trained.at(-1).startedAt, points, ...(best ? { bestE1rm: asBest(best) } : {}), ...(heavy ? { heaviest: asBest(heavy) } : {}) };
      }).sort((a, b) => b.lastTrainedAt - a.lastTrainedAt || lexical(a.exerciseId, b.exerciseId));
      return { weeks, movements };
    },
  };
}
