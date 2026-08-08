// THE PANEL'S WORDS AND ITS ONE RULE, kept out of the component because both are promises and a
// promise is worth a test. The rule: a model reaches this log through the same tools your own AI
// tools do, it holds READ tools only, and the panel says which ones it used — every time, in order.
// A chatbot claims to know things; an instrument shows you where it looked.

// What each tool actually did, in the lifter's language rather than the wire's. The map is the whole
// translation and it is exhaustive over the six reads gym hands a panel (CoachTools) — a name that
// somehow arrives without an entry is shown verbatim rather than dropped, because a step nobody can
// read is still a step that happened and hiding it would be the one thing this panel must not do.
export const TOOL_PHRASE = {
  get_session: 'read this workout',
  last_time: 'read the last time you trained that movement',
  list_sessions: 'read your recent workouts',
  list_exercises: 'read your movement list',
  list_routines: 'read your program',
  get_stats: 'read your movement history',
};

// One line under an answer: what it read, in call order, said once each. Repeats collapse because
// "read your movement history, read your movement history, read your movement history" tells a
// lifter nothing a single mention does not, and a failed read is named as failed rather than hidden.
export function stepsLine(steps) {
  if (!steps || steps.length === 0) return 'Answered from this workout alone.';
  const seen = [];
  for (const step of steps) {
    const phrase = (TOOL_PHRASE[step.tool] ?? step.tool) + (step.failed ? ' (nothing came back)' : '');
    if (!seen.includes(phrase)) seen.push(phrase);
  }
  return `It ${seen.join(', then ')}.`;
}

// The panel's own copy. TERMS is the honest description of the capability — what it may do and what
// it may not — and it sits on screen before anything is typed, not in a tooltip after.
export const COACH_TITLE = 'Ask about this workout';
export const COACH_TERMS =
  'It reads this workout, and your history behind it, through the same tools your own AI tools use. '
  + 'It only reads: it cannot log a set, change your program, delete a workout, or make a coach link.';
export const COACH_PLACEHOLDER = 'How did the squats go?';
export const COACH_LOCKED_NOTE = 'The coach panel is part of Windmill One.';
// Said when the plan itself is not on sale yet. It replaces the Upgrade button rather than sitting
// beside it: a price is only honest when there is a door behind it, and there isn't one today.
export const COACH_NOT_FOR_SALE = 'Windmill One isn’t on sale yet — nothing here is billable, and this panel opens when it is.';
export const COACH_ABSENT_NOTE = 'The coach isn’t switched on here.';

// Why an ask did not come back, in the half-sentence the panel finishes. Every branch reads the
// STATUS and the machine word — never the sentence, which may be reworded any day.
//   403 the paywall raced us (bought elsewhere, or lapsed mid-thread)
//   404 + coach-no-session  this workout is not this account's to read
//   404 with no code        the route does not exist here — the deployment has no model wired
//   429 + coach-out-of-budget  our own AI ceiling for this account's rolling 30 days
//   429 with no code           the per-account brake, which is about pace and not about money
//   everything else         the model did not answer, and asking again is the whole repair
export function askFailure(error) {
  if (error?.status === 403) return { note: COACH_LOCKED_NOTE, locked: true };
  if (error?.status === 404 && error?.code === 'coach-no-session') {
    return { note: 'That workout isn’t in your log.', gone: true };
  }
  if (error?.status === 404 || error?.status === 503) return { note: COACH_ABSENT_NOTE, gone: true };
  // TWO DIFFERENT 429s, and reading only the status would have said the wrong one out loud: the
  // brake is about pace and clears in a minute, the ceiling is about money and clears as a 30-day
  // window rolls. Neither is the lifter's fault and neither points at a purchase — there is no
  // checkout behind this panel (paidPlansOpen() is false), and a door that does not exist is not
  // something to offer somebody standing at it.
  if (error?.status === 429 && error?.code === 'coach-out-of-budget') {
    return { note: 'This account has reached the AI ceiling we set for a rolling 30 days. The coach answers again as that window rolls on — the rest of the log is untouched.' };
  }
  if (error?.status === 429) return { note: 'That’s a lot of questions at once. Try again shortly.' };
  return { note: 'The coach didn’t answer. Ask again in a moment.' };
}

// The thread the server is sent: every turn so far, oldest first, in the shape the wire takes. It is
// derived from what is on screen rather than kept beside it, because a second copy of a conversation
// is a second thing that can disagree with what the lifter is reading.
export function threadFor(turns, question) {
  return [...turns.map((turn) => ({ from: turn.from, text: turn.text })), { from: 'lifter', text: question }];
}
