// The pure rules behind the Coach room: the step phrases, the receipt, the turn shape and every
// sentence the room says of its own. Server sentences are shown as sent and never rewritten here.

import { entryLabel, loadBasisLabel, movementOf, nameOfMovement, planOf, planReadingOf, routineNameOf, slotRows, targetLoadOf, timeLabel } from '../log.js';
import { inLoggedOrder } from '../domain/training.js';
import { t } from '../i18n/index.js';

export function coachWorkout(session, sets = [], catalog = []) {
  const plan = planOf(session);
  const entries = Array.isArray(plan?.entries) ? plan.entries.filter((entry) => typeof entry?.exerciseId === 'string') : [];
  const ids = [...new Set([...entries.map((entry) => entry.exerciseId), ...sets.map((set) => set.exerciseId)])];
  const latest = [...sets].sort((left, right) => right.completedAt - left.completedAt)[0]?.exerciseId;
  const groups = ids.map((id) => {
    const entry = planReadingOf(session, id).entry;
    const logged = sets.filter((set) => set.exerciseId === id).sort(inLoggedOrder);
    const bodyweight = catalog.find((movement) => movement.id === id)?.equipment === 'bodyweight'
      && entry?.sets?.every((set) => set.weightKg == null || set.weightKg === 0);
    return { id, name: nameOfMovement(catalog, id),
      scheme: !entry ? null : bodyweight ? t('gym.coach.schemeBodyweight', { scheme: entryLabel(entry) }) : entryLabel(entry),
      rows: slotRows(logged, entry), targets: entry?.sets?.length ?? null };
  });
  const active = latest ?? groups.find((group) => group.rows.some((row) => row.kind === 'target'))?.id;
  const total = groups.length && groups.every((group) => group.targets !== null)
    ? groups.reduce((count, group) => count + group.targets, 0) : null;
  const remaining = groups.reduce((count, group) => count + group.rows.filter((row) => row.kind === 'target').length, 0);
  const count = t('gym.coach.setsLogged', { count: sets.length });
  return { name: routineNameOf(session) ?? t('gym.coach.freeSession'), started: timeLabel(session.startedAt), count,
    progress: total && remaining ? t('gym.coach.setOfTotal', { position: total - remaining + 1, total }) : count,
    groups, active };
}

export const TOOL_PHRASE = {
  list_sessions: t('gym.coach.tools.listSessions'),
  get_session: t('gym.coach.tools.getSession'),
  last_time: t('gym.coach.tools.lastTime'),
  list_exercises: t('gym.coach.tools.listExercises'),
  list_routines: t('gym.coach.tools.listRoutines'),
  get_stats: t('gym.coach.tools.getStats'),
  list_notes: t('gym.coach.tools.listNotes'),
  save_note: t('gym.coach.tools.saveNote'),
  list_bodyweight: t('gym.coach.tools.listBodyweight'),
  create_routine: t('gym.coach.tools.createRoutine'),
  update_exercise: t('gym.coach.tools.updateExercise'),
  propose_routine_change: t('gym.coach.tools.proposeRoutineChange'),
  propose_routine_removal: t('gym.coach.tools.proposeRoutineRemoval'),
};

// A turn that carries routine drafts asked the lifter to save each one; an older turn's create_routine saved it itself.
export const DRAFTED_ROUTINE_PHRASE = t('gym.coach.tools.draftedRoutine');

export const NO_STEPS = t('gym.coach.noSteps');

// A tool with no phrase prints nothing — a raw tool name is developer output on a lifter's screen.
// The receipt beside this line is what the honesty claim rests on, so a step list that empties out
// draws no sentence at all rather than claiming the answer came from nowhere.
export function stepsLine(steps, { drafted = false } = {}) {
  if (!steps || steps.length === 0) return NO_STEPS;
  const seen = [];
  for (const step of steps) {
    const phrase = step.tool === 'create_routine' && drafted ? DRAFTED_ROUTINE_PHRASE : TOOL_PHRASE[step.tool];
    if (!phrase) continue;
    const said = step.tool === 'save_note' && step.failed
      ? t('gym.coach.tools.noteSaveUnconfirmed')
      : step.failed ? t('gym.coach.tools.nothingCameBack', { phrase }) : phrase;
    if (!seen.includes(said)) seen.push(said);
  }
  if (seen.length === 0) return null;
  return t('gym.coach.steps', { steps: seen.reduce((done, next) => t('gym.coach.stepsThen', { done, next })) });
}

// Null for a missing or malformed read; a real zero across all three gets words. `figure` dresses each count.
export function readLine(read, figure = (value) => value) {
  if (!read) return null;
  const { sets, sessions, weeks } = read;
  if (typeof sets !== 'number' || typeof sessions !== 'number' || typeof weeks !== 'number') return null;
  if (sets === 0 && sessions === 0 && weeks === 0) return t('gym.coach.readNothing');
  return t('gym.coach.read', { sets, weeks, sessions, setsShown: figure(sets), weeksShown: figure(weeks), sessionsShown: figure(sessions) });
}

// `from: 'ask'` is the wire's enum for the room's turn and is a machine token, not the room's name.
export function answerTurn(reply) {
  if (typeof reply?.answer !== 'string') return null;
  if (readLine(reply.read) === null) return null;
  return {
    from: 'ask',
    text: reply.answer,
    steps: reply.steps,
    read: reply.read,
    proposals: reply.proposals ?? [],
    ...(reply.routineDrafts?.length ? { routineDrafts: reply.routineDrafts } : {}),
    ...(reply.receipt ? { receipt: reply.receipt } : {}),
    ...(reply.results ? { results: reply.results } : {}),
  };
}

export const COACH_TITLE = t('gym.coach.title');
export const COACH_PLACEHOLDER = t('gym.coach.placeholder');
export const CAP_REACHED_NOTE = t('gym.coach.capReached');

// The cap is bytes, not characters.
export const QUESTION_BYTES = 1000;

export function questionTooLong(question) {
  return new TextEncoder().encode(question).length > QUESTION_BYTES;
}

export const TOO_LONG_NOTE = t('gym.coach.tooLong');

export const SIGNED_OUT_NOTE = t('gym.coach.signedOut');

export const COACH_ABSENT_NOTE = t('gym.coach.absent');

export const MID_SESSION_NOTE = t('gym.coach.midSession');

export const NO_ANSWER_NOTE = t('gym.coach.noAnswer');

export const OUT_OF_BUDGET_NOTE = t('gym.coach.outOfBudget');

export const THREAD_TAKEN_NOTE = t('gym.coach.threadTaken');
export const BRAKE_NOTE = t('gym.coach.brake');
export const UNREADABLE_NOTE = t('gym.coach.unreadable');


export function askFailure(error) {
  const said = typeof error?.detail === 'string' && error.detail !== '' ? error.detail : null;
  const note = (own) => said ?? own;
  if (error?.status === 401) return { note: note(SIGNED_OUT_NOTE), gone: true };
  if (error?.status === 404 || error?.code === 'ask-not-configured') return { note: note(COACH_ABSENT_NOTE), gone: true };
  if (error?.status === 409 && error?.code === 'ask-session-open') return { note: note(MID_SESSION_NOTE), refused: true };
  if (error?.status === 409 && error?.code === 'ask-thread-taken') return { note: note(THREAD_TAKEN_NOTE), fresh: true, refused: true };
  if (error?.status === 429 && error?.code === 'ask-daily-limit') return { note: note(CAP_REACHED_NOTE), capped: true, refused: true };
  if (error?.status === 429 && error?.code === 'ask-out-of-budget') return { note: note(OUT_OF_BUDGET_NOTE), capped: true, ceiling: true, refused: true };
  if (error?.status === 429) return { note: note(BRAKE_NOTE), refused: true };
  if (error?.status === 400) return { note: note(UNREADABLE_NOTE), refused: true };
  if (error?.code === 'ask-generation-active') return { note: note(t('gym.coach.generationActive')), refused: true };
  if (error?.code === 'ask-request-conflict') return { note: note(t('gym.coach.requestConflict')), gone: true };
  return { note: note(NO_ANSWER_NOTE) };
}

export const CONFIRM_RETRY_NOTE = t('gym.coach.confirmRetry');
export const DRAFT_GONE_NOTE = t('gym.coach.draftGone');
export const DRAFT_UNSAVABLE_NOTE = t('gym.coach.draftUnsavable');

// A Save routine that did not come back saved: what the draft card says, whether Save stays offered, and the
// funnel outcome. A lost reply asserts nothing about the routine; only a refusal the server answered closes the draft.
export function confirmFailure(error) {
  const status = error?.status;
  if (!(status >= 400 && status < 500)) return { outcome: 'failed', note: CONFIRM_RETRY_NOTE, closed: false };
  if (status === 404) return { outcome: 'refused', note: DRAFT_GONE_NOTE, closed: true };
  if (status === 400 || status === 422) return { outcome: 'refused', note: DRAFT_UNSAVABLE_NOTE, closed: true };
  if (status === 401) return { outcome: 'refused', note: SIGNED_OUT_NOTE, closed: false };
  return { outcome: 'refused', note: CONFIRM_RETRY_NOTE, closed: false };
}

export const NEW_MOVEMENT = t('gym.coach.newMovement');
const EQUIPMENT_LABEL = {
  barbell: t('gym.coach.equipment.barbell'),
  bodyweight: t('gym.coach.equipment.bodyweight'),
  machine: t('gym.coach.equipment.machine'),
  cable: t('gym.coach.equipment.cable'),
  kettlebell: t('gym.coach.equipment.kettlebell'),
};

// One movement of a routine draft as the log knows it: targets in the lifter's unit with what a load counts, then
// equipment and rest. A movement the log has not synced yet is named neutrally and asserts no basis or equipment.
export function draftEntryLine(entry, catalog) {
  const exercise = movementOf(catalog, entry.exerciseId);
  const load = entry.sets?.map((set) => targetLoadOf(set.weightKg)).find((value) => value != null) ?? null;
  const equipment = exercise?.equipment === 'dumbbell'
    ? (exercise.loadCount === 1 ? t('gym.coach.equipment.oneDumbbell') : t('gym.coach.equipment.twoDumbbells'))
    : EQUIPMENT_LABEL[exercise?.equipment] ?? null;
  const scheme = load === null || !exercise
    ? entryLabel(entry)
    : t('gym.coach.schemeWithBasis', { scheme: entryLabel(entry), basis: loadBasisLabel(exercise, load) });
  const rest = entry.restSeconds ? t('gym.coach.restSeconds', { seconds: entry.restSeconds }) : null;
  return { name: exercise?.name ?? NEW_MOVEMENT, detail: [scheme, equipment, rest].filter(Boolean).join(' · ') };
}

export const THREAD_PREFIX = 'thr_';

export function mergeTurns(held, incoming) {
  const merged = [...held];
  for (const turn of incoming ?? []) {
    const index = merged.findIndex((existing) => (
      Number.isInteger(turn.position) && existing.position === turn.position
    ) || (turn.requestId && existing.requestId === turn.requestId && existing.from === turn.from)
      || (turn.generationId && existing.generationId === turn.generationId && existing.from === turn.from));
    if (index < 0) merged.push(turn);
    else {
      const previous = merged[index];
      if ((previous.revision ?? -1) > (turn.revision ?? Number.MAX_SAFE_INTEGER)) continue;
      const saved = new Map((previous.routineDrafts ?? []).filter((draft) => draft.state === 'saved').map((draft) => [draft.operationId, draft]));
      merged[index] = { ...previous, ...turn,
        ...(turn.routineDrafts ? { routineDrafts: turn.routineDrafts.map((draft) => saved.get(draft.operationId) ?? draft) } : {}),
        ...(saved.size ? { results: [...new Map([...(previous.results ?? []), ...(turn.results ?? [])].map((result) => [result.operationId, result])).values()] } : {}),
      };
    }
  }
  return merged.sort((left, right) => {
    if (Number.isInteger(left.position) && Number.isInteger(right.position)) return left.position - right.position;
    return (left.at ?? 0) - (right.at ?? 0);
  });
}

export function generationTurns(generation) {
  if (!generation) return [];
  const identity = { generationId: generation.id, requestId: generation.requestId, at: generation.at,
    ...(Number.isInteger(generation.revision) ? { revision: generation.revision } : {}) };
  return [
    { ...identity, from: 'lifter', text: generation.question, ...(generation.attachments?.length ? { attachments: generation.attachments } : {}) },
    { ...identity, from: 'ask', text: generation.answer ?? '', status: generation.status,
      receipt: generation.receipt, results: generation.results ?? [], routineDrafts: generation.routineDrafts ?? [] },
  ];
}

export function requestFromGeneration(thread, generation) {
  if (!generation || ['completed', 'stopped'].includes(generation.status)) return null;
  return { thread, requestId: generation.requestId, question: generation.question, at: generation.at,
    attachmentIds: (generation.attachments ?? []).map((photo) => photo.id),
    attachments: generation.attachments ?? [], accepted: true };
}
