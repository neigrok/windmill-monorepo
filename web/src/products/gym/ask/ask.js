// ASK'S WORDS AND ITS RULES, kept out of the room because most of them are PROMISES and a promise is
// worth a test. The promise: a model reaches this log through the same tools your own AI tools reach
// it through, it holds the reads plus the two that mint a proposal, and every answer says what it
// read — the tools, and how many rows they served.
//
// THE COUNT IS THE SERVER'S AND NOTHING HERE COMPUTES ONE. `read` arrives on the wire because the
// server SERVED those rows to this connection; a number this file summed would be a number the model
// could have made up, dressed as an audit. So `readLine` reads three fields and does arithmetic on
// none of them — the plural is the only thing it decides.
//
// AND NOTHING IN HERE SAYS COACH. There is no coach in this product: there is your agent, and Ask is
// the door onto it for a lifter who has not got one of their own. The coach SHARE is a different
// object and keeps its name honestly (share/).

// What each tool actually did, in the lifter's language rather than the wire's. It is exhaustive
// over the grant Ask holds — the seven gym reads, plus the two tools that mint a proposal (backend
// AskTools: Access::read ∪ mintsProposal) — and nothing else is offered to the model, so nothing
// else can appear in a step. A name that somehow arrives without an entry is shown verbatim rather
// than dropped, because a step nobody can read is still a step that happened and hiding it is the
// one thing this line must not do.
export const TOOL_PHRASE = {
  list_sessions: 'read your recent workouts',
  get_session: 'read one workout',
  last_time: 'read the last time you trained a movement',
  list_exercises: 'read your movement list',
  list_routines: 'read your program',
  get_stats: 'read your movement history',
  get_preferences: 'read how your gym is set up',
  propose_routine_change: 'wrote a proposal for one of your routines',
  propose_routine_removal: 'wrote a proposal to remove a routine',
};

// Ask always opens with a read of your newest workouts before the model says anything — that read is
// welded to the first turn and is not a step, because Ask made it and not the model. So an answer
// with no steps is not an answer from nowhere, and this is the sentence that says which.
export const NO_STEPS = 'Answered from your recent workouts alone.';

// One line under an answer: what it read, in call order, said once each. Repeats collapse because
// "read your movement history, read your movement history, read your movement history" tells a
// lifter nothing a single mention does not, and a failed read is named as failed rather than hidden.
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

// THE RECEIPT — canon §L's `read 214 sets · 12 weeks · 34 sessions`, and the reason the whole design
// exists: a claim you can check without trusting it. Every number in it was counted by the server
// over the rows it actually served, deduped by id across the whole exchange, so two calls that
// overlap count once (backend domain/ReadReceipt).
//
// A `read` that is absent, or one with a field missing, is answered with NOTHING rather than with a
// zero: silence is an omission and a zero would be an assertion, and the only assertion this line
// could make wrongly is that a model answered off nothing. `answerTurn` below turns that nothing
// into no answer at all — an unreceipted line is not a line this room prints under prose it drew.
// Zero across all three IS an answer, and it gets words rather than three noughts: an answer built
// from no rows of yours is exactly what a lifter wants to know.
export function readLine(read) {
  if (!read) return null;
  const { sets, sessions, weeks } = read;
  if (typeof sets !== 'number' || typeof sessions !== 'number' || typeof weeks !== 'number') return null;
  if (sets === 0 && sessions === 0 && weeks === 0) return 'read nothing from your log';
  return `read ${rowCount(sets, 'set')} · ${rowCount(weeks, 'week')} · ${rowCount(sessions, 'session')}`;
}

// AND A REPLY WITH NO RECEIPT IN IT IS NOT AN ANSWER THIS ROOM MAY DRAW. §L's rule is that EVERY
// answer states what it read, so prose nothing can be checked against is prose that does not go on
// screen — drawn anyway, the rule would be a coincidence of what the server happens to send rather
// than a rule, and this door is the one place model prose could reach a lifter uncheckable.
//
// It fails the way a model that did not answer fails, in the same sentence, because that is the
// honest description of what happened: nothing arrived that this surface is allowed to show. Both
// phones already fail closed on exactly this body — iOS decodes `read` strictly and Android leaves
// it without a default — and a third client that drew it would be the divergence.
//
// This is `threadFor` from the other side: that one decides what may go out, this one what may come
// back. Nothing else in the room makes a turn out of a reply, and nothing here computes a count —
// `read` is passed through whole, exactly as the server counted it.
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

// The room's own copy. TERMS is the honest description of the capability — what it may do and what
// it may not — and it sits under the title before anything is typed, not in a tooltip after.
export const ASK_TITLE = 'Ask';
export const ASK_TERMS = 'reads your log · proposes only';
export const ASK_PLACEHOLDER = 'Ask about your training';

// THE EMPTY STATE POINTS AT THE FREE DOOR, and it is the strongest thing this product can say about
// itself: the log is yours, the tools are open, and the agent you already pay for reads it better
// than ours can — because it knows the rest of your life. A chat that hides that door would be the
// retreat, so it is the FIRST thing an empty room says and it costs one paragraph.
export const FREE_DOOR_LINE =
  'If you already use Claude or ChatGPT, connect them instead — it’s free, and it’s better, because '
  + 'it knows the rest of your life.';
export const FREE_DOOR_VERB = 'Connect your own tools';

// Said under a proposal Ask minted, in canon's own words. Both halves matter: the tap is on the diff
// and not here, and a proposal cannot touch a set you lifted at all.
export const PROPOSAL_NOTE =
  'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.';

// AND WHAT IT HANDS BACK. Ask can read what you lifted and cannot edit it — no tool at any grant
// level touches a logged set (W6) — so the room says where the correction lives rather than leaving
// a lifter to discover the refusal by asking for one. The door is §G18's: every set in a workout is
// a door onto its fix.
export const FIX_IS_YOURS =
  'Correcting a set is yours, not Ask’s. Open the workout in your log and tap the set.';

// The wire takes at most eight turns, strictly alternating, first and last from the lifter — so four
// answers is a whole conversation and a fifth question would be a ninth turn. The room says that out
// loud and offers a fresh thread rather than letting the send button 400.
export const MAX_TURNS = 8;

export function threadFull(turns) {
  const answered = turns.filter((turn) => turn.from === 'ask').length;
  return answered * 2 + 1 > MAX_TURNS;
}

// THE CAP IS IN BYTES AND THE FIELD COUNTS CHARACTERS, which are not the same number the moment a
// question carries an emoji or an accent. Counting it here is what keeps a long question on screen
// instead of sending it to be refused — nothing a lifter typed disappears into a 400.
export const QUESTION_BYTES = 1000;

export function questionTooLong(question) {
  return new TextEncoder().encode(question).length > QUESTION_BYTES;
}

export const TOO_LONG_NOTE = 'That question is too long to send. Shorten it and ask again.';

// A DEPLOYMENT WITH NO MODEL NEVER MOUNTS THE ROUTE, so the absence arrives as the framework's own
// 404 and there is nothing to configure from here. The room retires rather than apologising twice.
export const ASK_ABSENT_NOTE = 'Ask isn’t switched on here.';

// NEVER MID-SESSION (§L). The room says this before a word is typed when a workout is open, and the
// server says it again as a 409 if one opens on the phone while the room is up — three clients each
// getting it right is not a rule, so this sentence has two sources and one wording.
export const MID_SESSION_NOTE = 'Finish your workout first — Ask reads a log that has stopped moving.';

// Why an ask did not come back, in the sentence the room prints. Every branch reads the STATUS and
// the machine word — never the English, which may be reworded any day. `gone` means the room retires
// its composer: asking again is not the repair, and a box that still takes typing would be a lie.
//
//   401                     the account went; the log is behind a sign-in and so is this
//   404 (no code)           the route was never mounted — this deployment has no model wired
//   503                     the same fact said by a deployment that mounted it anyway
//   409 ask-session-open    a workout is running; Ask reads a log that has stopped moving
//   429 ask-daily-limit     the pace cap, and it is a design artifact rather than an ops detail
//   429 ask-out-of-budget   our own AI ceiling for this account's rolling 30 days
//   400                     the thread or the question was unreadable — terminal, never retried
//   everything else         the model did not answer, and asking again is the whole repair
//
// The last one is a sentence rather than a branch, because it is said twice: for a request that came
// back wrong, and for a 200 whose body carried no receipt (`answerTurn`). Both are the same fact
// from the lifter's side — nothing arrived that this room may put on screen.
//
// NOT ONE OF THESE OFFERS A PURCHASE. Ask is open to everyone with a plainly-worded cap; there is no
// upgrade behind either 429 and there is no checkout in this product at all (paidPlansOpen() is
// false), so a door that does not exist is not something to offer somebody standing at a limit.
export const NO_ANSWER_NOTE = 'Ask didn’t answer. Try again in a moment.';

export function askFailure(error) {
  if (error?.status === 401) return { note: 'Sign in to open your training log.', gone: true };
  if (error?.status === 404 || error?.status === 503) return { note: ASK_ABSENT_NOTE, gone: true };
  if (error?.status === 409 && error?.code === 'ask-session-open') return { note: MID_SESSION_NOTE };
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

// The thread the server is sent: every turn so far, oldest first, in the shape the wire takes. It is
// derived from what is on screen rather than kept beside it, because a second copy of a conversation
// is a second thing that can disagree with what the lifter is reading.
//
// A LIFTER'S TURN THAT NOTHING ANSWERED IS DROPPED FROM THE THREAD AND KEPT ON THE SCREEN. The ask
// carrying it failed, so the model never saw it — and the wire wants strict alternation, where two
// lifter turns in a row is a 400 that takes the whole conversation down. Keeping it visible is the
// other half of the same rule: nothing a lifter wrote disappears quietly.
export function threadFor(turns, question) {
  const thread = [];
  turns.forEach((turn, index) => {
    if (turn.from === 'lifter' && turns[index + 1]?.from !== 'ask') return;
    thread.push({ from: turn.from, text: turn.text });
  });
  thread.push({ from: 'lifter', text: question });
  return thread;
}
