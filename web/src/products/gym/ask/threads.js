// ASK HAS A PAST (§O) — the words and the rules behind the list of conversations, kept out of the
// screens because nearly all of them are PROMISES about what a row may say.
//
// THE TITLE IS THE LIFTER'S FIRST MESSAGE, VERBATIM, and it is the reason the list is worth having:
// somebody coming back six weeks later is looking for the question they asked, in the words they
// asked it in. So there is no titling function in this file and there is nothing to write one from
// — no summariser, no truncation, no ellipsis. The wire carries the sentence and the screen draws
// it.
//
// AND EVERY ROW'S SECOND LINE IS SOMETHING THE SERVER OBSERVED. `outcome` is DERIVED by the server
// from the proposals riding with the thread, so each of these sentences is a count of documents that
// exist, and every one of them can be checked by opening the routine underneath it. The board draws
// a dismissed row reading `built it myself instead`; nothing observes WHY a lifter dismissed a
// proposal and this product does not ask, so that line would be us narrating a motive onto somebody's
// evening — one line under a rule about never summarising a person. A dismissed row says WHAT was
// dismissed and nothing about why. (Reported to the design canon's drift ledger; the wire ships no
// field a motive could be written into, which is the other half of making it impossible.)
//
// IT IS NOT AN INBOX. No unread count, no badge, no notification, nothing waiting — a threads screen
// is the most natural place in this product to grow one, and this is the file where it would be
// written, so its absence is stated here rather than left to be noticed.

import { agoLabel, shortDayLabel } from '../log.js';
import { changeLabel } from '../proposals.js';

// Spelled in full and in order, like every other date in gym: the divider is a month somebody
// trained in, not a locale's idea of one.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const THREADS_TITLE = 'Threads';

// The list is bounded at the server (`kThreadList`, §6) with no total and no "there are more" flag,
// so a client may print `N conversations` ONLY while it holds fewer rows than the ceiling: at the
// ceiling the count is a floor wearing a count's clothes, which is halfway to the badge §O forbids.
export const THREAD_LIST_CEILING = 200;

// The subhead, and the second half of it is the whole of what this screen offers besides reading:
// they are yours, and deleting one is a thing you can do. A count of nothing is not drawn at all —
// the empty room says its own sentence instead — and neither is a count AT THE CEILING: the rows
// still say what they can, and that is that they are yours to delete.
export function conversationsLine(count) {
  if (count >= THREAD_LIST_CEILING) return 'yours to delete';
  const list = count === 1 ? '1 conversation' : `${count} conversations`;
  return `${list} · yours to delete`;
}

// The chip: what became of the conversation, in one word, and `read only` is a state as good as the
// others rather than the absence of one — most questions worth asking do not want a change made.
const OUTCOME_CHIPS = {
  applied: 'applied',
  'read-only': 'read only',
  proposed: 'proposed',
  dismissed: 'dismissed',
  superseded: 'superseded',
};

export function outcomeChip(outcome) {
  return OUTCOME_CHIPS[outcome?.kind] ?? null;
}

// THE ROW'S SECOND LINE. Every branch is a fact the store holds: a count of changes, and — when they
// all landed in one routine — that routine's name. Both come off the wire; nothing here counts
// anything, and there is no branch that could say why.
//
// The count is spelled by `changeLabel`, the way a change is spelled everywhere else in this product,
// so one change reads as one change rather than as `1 changes`. A kind this build does not know
// draws NOTHING rather than a guess — a row with a title and no subtitle is honest, and a row
// captioned by a word this file invented is not.
export function outcomeLine(outcome) {
  if (outcome?.kind === 'read-only') return 'no changes proposed';
  if (typeof outcome?.changes !== 'number') return null;
  const changes = changeLabel(outcome.changes);
  if (outcome.kind === 'applied' && outcome.routine) return `${changes} → ${outcome.routine}`;
  if (outcome.kind === 'applied') return changes;
  if (outcome.kind === 'proposed') return `${changes} waiting`;
  if (outcome.kind === 'dismissed') return `${changes} dismissed`;
  if (outcome.kind === 'superseded') return `${changes} superseded`;
  return null;
}

// WHEN IT WAS LAST ASKED, on the right of the row — today by its word, everything older by its date.
// `logWhenLabel`'s rule for the log's rows, for its reason: the day is what a lifter is looking for
// once it is not this one, and the month divider above carries the rest.
export function askedLabel(ms, now = Date.now()) {
  if (agoLabel(ms, now) === 'today') return 'today';
  return shortDayLabel(ms);
}

// THE MONTHS, folded over the list the server already ordered — newest first, and a run of adjacent
// rows is a month for the same reason a run of them is a week in the log (`weeksOf`). Nothing is
// sorted here: the order is the wire's, and a fold that re-sorted would be a second opinion about
// which conversation is the newest.
//
// A MONTH OUTSIDE THIS YEAR CARRIES ITS YEAR. `July` over conversations from two different Julys is
// the same failure `arrivedLabel` refuses on a weekday — the reader supplies the wrong one — and a
// conversation worth keeping for six weeks is worth keeping for eighteen months.
export function monthsOf(threads, now = Date.now()) {
  const thisYear = new Date(now).getFullYear();
  const months = [];
  for (const thread of threads ?? []) {
    const at = new Date(thread.askedAt);
    const key = `${at.getFullYear()}-${at.getMonth()}`;
    const open = months[months.length - 1];
    if (open && open.key === key) {
      open.threads.push(thread);
      continue;
    }
    const year = at.getFullYear();
    months.push({
      key,
      label: year === thisYear ? MONTH_NAMES[at.getMonth()] : `${MONTH_NAMES[at.getMonth()]} ${year}`,
      threads: [thread],
    });
  }
  return months;
}

// The room's own copy. The empty state does not sell the feature it is the empty state of: Ask does
// not speak first (§L), and a list of nothing says what it is and offers the one door out.
export const NO_THREADS = 'Nothing here yet. Ask something and the conversation stays.';
export const NEW_THREAD_VERB = 'Ask something new';

// WHAT DELETE MEANS, said before it is tapped rather than in a toast after. Both halves are §O's:
// the messages go, and the change you applied does not, because that is a fact about your program.
export const DELETE_VERB = 'Delete this conversation';
export const DELETE_CONFIRM = 'Delete it — this cannot be undone';
export const DELETE_NOTE =
  'Deleting a conversation deletes the messages. A change you applied stays in the routine’s '
  + 'history, because that is a fact about your program rather than a message.';
export const DELETE_FAILED = 'That wasn’t deleted. Try again in a moment.';

export const THREAD_ABSENT = 'That conversation isn’t here any more.';
export const THREAD_FAILED = 'The conversation didn’t load.';
export const THREADS_FAILED = 'Your conversations didn’t load.';

// The file, offered where the conversations are. Every turn, nothing omitted, no parameters — the
// same terms the sets export has, said in the same voice.
export const EXPORT_THREADS_VERB = 'Export conversations';
export const EXPORT_THREADS_LINE = 'every message as CSV · yours, always';
