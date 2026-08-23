export const TOOL_PHRASE = {
  list_sessions: 'read your recent workouts',
  get_session: 'read one workout',
  last_time: 'read the last time you trained a movement',
  list_exercises: 'read your movement list',
  list_routines: 'read your program',
  get_stats: 'read your movement history',
  propose_routine_change: 'wrote a proposal for one of your routines',
  propose_routine_removal: 'wrote a proposal to remove a routine',
};

export const NO_STEPS = 'Answered from your recent workouts alone.';

export function stepsLine(steps) {
  if (!steps || steps.length === 0) return NO_STEPS;
  const seen = [];
  for (const step of steps) {
    const phrase = (TOOL_PHRASE[step.tool] ?? step.tool) + (step.failed ? ' (nothing came back)' : '');
    if (!seen.includes(phrase)) seen.push(phrase);
  }
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

export const ASK_TITLE = 'Ask';
export const ASK_TERMS = 'reads your log · proposes only';
export const ASK_PLACEHOLDER = 'Ask about your training';

export const FREE_DOOR_LINE =
  'If you already use Claude or ChatGPT, connect them instead — it’s free, and it’s better, because '
  + 'it knows the rest of your life.';
export const FREE_DOOR_VERB = 'Connect your own tools';

export const PROPOSAL_NOTE =
  'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.';

export const FIX_IS_YOURS =
  'Correcting a set is yours, not Ask’s. Open the workout in your log and tap the set.';

// The server holds at most eight turns per thread and refuses a ninth with 409 `ask-thread-full`.
export const MAX_TURNS = 8;

export function threadFull(turns) {
  const answered = turns.filter((turn) => turn.from === 'ask').length;
  return answered * 2 + 1 > MAX_TURNS;
}

export const THREAD_FULL_NOTE = 'That’s as long as one conversation goes here. It’s kept in Threads.';

// The cap is bytes, not characters.
export const QUESTION_BYTES = 1000;

export function questionTooLong(question) {
  return new TextEncoder().encode(question).length > QUESTION_BYTES;
}

export const TOO_LONG_NOTE = 'That question is too long to send. Shorten it and ask again.';

export const ASK_ABSENT_NOTE = 'Ask isn’t switched on here.';

export const MID_SESSION_NOTE = 'Finish your workout first — Ask reads a log that has stopped moving.';

export const NO_ANSWER_NOTE = 'Ask didn’t answer. Try again in a moment.';

// `gone` retires the composer.
export function askFailure(error) {
  if (error?.status === 401) return { note: 'Sign in to open your training log.', gone: true };
  if (error?.status === 404 || error?.code === 'ask-not-configured') return { note: ASK_ABSENT_NOTE, gone: true };
  if (error?.status === 409 && error?.code === 'ask-session-open') return { note: MID_SESSION_NOTE };
  if (error?.status === 409 && error?.code === 'ask-thread-full') return { note: THREAD_FULL_NOTE, full: true };
  if (error?.status === 409 && error?.code === 'ask-thread-taken') {
    return { note: 'That conversation id was already taken. Ask again — it opens a new one.', fresh: true };
  }
  if (error?.status === 429 && error?.code === 'ask-daily-limit') {
    return { note: 'That’s Ask for now — it answers about ten questions a day, three back to back. The next one frees up in a couple of hours.' };
  }
  if (error?.status === 429 && error?.code === 'ask-out-of-budget') {
    return { note: 'This account has reached its AI ceiling for the last 30 days. Ask will answer again as that window rolls on — the rest of your log is untouched.' };
  }
  if (error?.status === 429) return { note: 'That’s a lot of questions at once. Try again shortly.' };
  if (error?.status === 400) return { note: 'Ask couldn’t read that. Start a new question and send it on its own.' };
  return { note: NO_ANSWER_NOTE };
}

export const THREAD_PREFIX = 'thr_';
