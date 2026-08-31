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
  list_bodyweight: 'read your bodyweight',
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
    const said = phrase + (step.failed ? ' (nothing came back)' : '');
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
  };
}

export const COACH_TITLE = 'Coach';
export const COACH_TERMS = 'reads your log · proposes only';
export const COACH_PLACEHOLDER = 'Ask about your training';
export const NOTES_DOOR = 'Notes';

// The promise, immediately above the composer, on every turn of the room.
export const ALLOWANCE_LINE = 'Ten questions a day, three back to back.';
// The moment, replacing the composer when the day's allowance is spent.
export const CAP_REACHED_NOTE = 'The next question frees up in a couple of hours.';

// Scope, not quality: what a connected agent reaches that this room cannot.
export const FREE_DOOR_LINE =
  'If you already use Claude or ChatGPT, connect them instead — it’s free, and it reaches what '
  + 'Coach can’t: it knows the rest of your life.';
export const FREE_DOOR_VERB = 'Connect your own tools';

export const PROPOSAL_NOTE =
  'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.';

export const FIX_IS_YOURS =
  'Correcting a set is yours, not Coach’s. Open the workout in your log and tap the set.';

// The server stores a question and its answer as two turns against a ceiling of eight, so one
// conversation holds four questions; the ninth turn is refused 409 `ask-thread-full`.
export const MAX_TURNS = 8;

export function threadFull(turns) {
  const answered = turns.filter((turn) => turn.from === 'ask').length;
  return answered * 2 + 1 > MAX_TURNS;
}

export const THREAD_FULL_NOTE = 'This conversation holds four questions. Start a new one.';

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

// The state is decided off status and code, never off the sentence. The words are the server's
// wherever it sent any (`detail`); the room's own sentence is the wordless fallback for a reply that
// carried no body — one constant per CODE, so a wordless ceiling never prints the daily cap's hours.
// `gone` retires the composer; `capped` replaces it with the cap-reached moment; `ceiling` says
// which ceiling was hit, because the account's has no clock and so no way back through a new
// conversation; `full` closes the conversation; `fresh` asks for a new thread id; `refused` says the
// server turned the question away and stored nothing, so the room takes it off the conversation.
export function askFailure(error) {
  const said = typeof error?.detail === 'string' && error.detail !== '' ? error.detail : null;
  const note = (own) => said ?? own;
  if (error?.status === 401) return { note: note(SIGNED_OUT_NOTE), gone: true };
  if (error?.status === 404 || error?.code === 'ask-not-configured') return { note: note(COACH_ABSENT_NOTE), gone: true };
  if (error?.status === 409 && error?.code === 'ask-session-open') return { note: note(MID_SESSION_NOTE), refused: true };
  if (error?.status === 409 && error?.code === 'ask-thread-full') return { note: note(THREAD_FULL_NOTE), full: true, refused: true };
  if (error?.status === 409 && error?.code === 'ask-thread-taken') return { note: note(THREAD_TAKEN_NOTE), fresh: true, refused: true };
  if (error?.status === 429 && error?.code === 'ask-daily-limit') return { note: note(CAP_REACHED_NOTE), capped: true, refused: true };
  if (error?.status === 429 && error?.code === 'ask-out-of-budget') return { note: note(OUT_OF_BUDGET_NOTE), capped: true, ceiling: true, refused: true };
  if (error?.status === 429) return { note: note(BRAKE_NOTE), refused: true };
  if (error?.status === 400) return { note: note(UNREADABLE_NOTE) };
  return { note: note(NO_ANSWER_NOTE) };
}

export const THREAD_PREFIX = 'thr_';
