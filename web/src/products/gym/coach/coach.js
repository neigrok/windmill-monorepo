// The pure rules behind the Coach room: the step phrases, the receipt, the turn shape and every
// sentence the room says of its own. Server sentences are shown as sent and never rewritten here.

export const TOOL_PHRASE = {
  list_sessions: 'read your recent workouts',
  get_session: 'read one workout',
  last_time: 'read the last time you trained a movement',
  list_exercises: 'read your movement list',
  list_routines: 'read your program',
  get_stats: 'read your movement history',
  list_notes: 'read your notes',
  save_note: 'saved a note',
  list_bodyweight: 'read your bodyweight',
  create_routine: 'created a routine',
  propose_routine_change: 'wrote a proposal for one of your routines',
  propose_routine_removal: 'wrote a proposal to remove a routine',
};

export const NO_STEPS = 'Answered from your recent workouts alone.';

// A tool with no phrase prints nothing — a raw tool name is developer output on a lifter's screen.
// The receipt beside this line is what the honesty claim rests on, so a step list that empties out
// draws no sentence at all rather than claiming the answer came from nowhere.
export function stepsLine(steps) {
  if (!steps || steps.length === 0) return NO_STEPS;
  const seen = [];
  for (const step of steps) {
    const phrase = TOOL_PHRASE[step.tool];
    if (!phrase) continue;
    const said = step.tool === 'save_note' && step.failed
      ? 'could not confirm a note save'
      : phrase + (step.failed ? ' (nothing came back)' : '');
    if (!seen.includes(said)) seen.push(said);
  }
  if (seen.length === 0) return null;
  return `It ${seen.join(', then ')}.`;
}

function rowCount(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

// Null for a missing or malformed read; a real zero across all three gets words.
export function readLine(read) {
  if (!read) return null;
  const { sets, sessions, weeks } = read;
  if (typeof sets !== 'number' || typeof sessions !== 'number' || typeof weeks !== 'number') return null;
  if (sets === 0 && sessions === 0 && weeks === 0) return 'read nothing from your log';
  return `read ${rowCount(sets, 'set')} · ${rowCount(weeks, 'week')} · ${rowCount(sessions, 'session')}`;
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
    ...(reply.receipt ? { receipt: reply.receipt } : {}),
    ...(reply.results ? { results: reply.results } : {}),
  };
}

export const COACH_TITLE = 'Coach';
export const COACH_PLACEHOLDER = 'Ask about your training';
export const PROPOSAL_NOTE =
  'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.';
export const CAP_REACHED_NOTE = 'The next question frees up in a couple of hours.';

// The cap is bytes, not characters.
export const QUESTION_BYTES = 1000;

export function questionTooLong(question) {
  return new TextEncoder().encode(question).length > QUESTION_BYTES;
}

export const TOO_LONG_NOTE = 'That question is too long to send. Shorten it and ask again.';

export const SIGNED_OUT_NOTE = 'Coach reads your log, so it needs you signed in.';

export const COACH_ABSENT_NOTE = 'Coach isn’t part of this Windmill. Your log is still yours to read.';

export const MID_SESSION_NOTE = 'Finish your workout first — Coach reads a log that has stopped moving.';

export const NO_ANSWER_NOTE = 'Coach didn’t answer. Try again in a moment.';

export const OUT_OF_BUDGET_NOTE =
  'This account has reached its AI ceiling for the last 30 days. Coach will answer again as that '
  + 'window rolls on.';

export const THREAD_TAKEN_NOTE = 'That conversation id was already taken. Ask again — it opens a new one.';
export const BRAKE_NOTE = 'That’s a lot of questions at once. Try again shortly.';
export const UNREADABLE_NOTE = 'Coach couldn’t read that. Start a new question and send it on its own.';

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
  if (error?.code === 'ask-generation-active') return { note: note('Coach is answering another question in this conversation. Try again shortly.'), refused: true };
  if (error?.code === 'ask-request-conflict') return { note: note('That request belongs to another question. Open the conversation again.'), gone: true };
  return { note: note(NO_ANSWER_NOTE) };
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
    else merged[index] = { ...merged[index], ...turn };
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
      receipt: generation.receipt, results: generation.results ?? [] },
  ];
}

export function requestFromGeneration(thread, generation) {
  if (!generation || ['completed', 'stopped'].includes(generation.status)) return null;
  return { thread, requestId: generation.requestId, question: generation.question, at: generation.at,
    attachmentIds: (generation.attachments ?? []).map((photo) => photo.id),
    attachments: generation.attachments ?? [], accepted: true };
}
