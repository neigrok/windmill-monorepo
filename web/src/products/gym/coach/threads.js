import { agoLabel, shortDayLabel } from '../log.js';
import { changeLabel } from '../proposals.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const THREADS_TITLE = 'Threads';

// The server bounds the list and sends no total, so at the ceiling a count would be a floor.
export const THREAD_LIST_CEILING = 200;

export function conversationsLine(count) {
  if (count >= THREAD_LIST_CEILING) return 'yours to delete';
  const list = count === 1 ? '1 conversation' : `${count} conversations`;
  return `${list} · yours to delete`;
}

const OUTCOME_CHIPS = {
  applied: 'applied',
  'read-only': 'read only',
  proposed: 'proposed',
  dismissed: 'turned down',
  superseded: 'superseded',
};

export function outcomeChip(outcome) {
  return OUTCOME_CHIPS[outcome?.kind] ?? null;
}

export function outcomeLine(outcome) {
  if (outcome?.kind === 'read-only') return 'no changes proposed';
  if (typeof outcome?.changes !== 'number') return null;
  const changes = changeLabel(outcome.changes);
  if (outcome.kind === 'applied' && outcome.routine) return `${changes} → ${outcome.routine}`;
  if (outcome.kind === 'applied') return changes;
  if (outcome.kind === 'proposed') return `${changes} waiting`;
  if (outcome.kind === 'dismissed') return `${changes} turned down`;
  if (outcome.kind === 'superseded') return `${changes} superseded`;
  return null;
}

export function askedLabel(ms, now = Date.now()) {
  if (agoLabel(ms, now) === 'today') return 'today';
  return shortDayLabel(ms);
}

// Folds the wire's order, newest first; nothing is re-sorted here.
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

export const NO_THREADS = 'Nothing here yet. Ask something and the conversation stays.';
export const NEW_THREAD_VERB = 'Ask something new';

export const DELETE_VERB = 'Delete this conversation';
export const DELETE_CONFIRM = 'Delete it — this cannot be undone';
export const DELETE_NOTE =
  'Deleting a conversation deletes the messages. A change you applied stays in the routine’s '
  + 'history, because that is a fact about your program rather than a message.';
export const DELETE_FAILED = 'That wasn’t deleted. Try again in a moment.';

export const THREAD_ABSENT = 'That conversation isn’t here any more.';
export const THREAD_FAILED = 'The conversation didn’t load.';
export const THREADS_FAILED = 'Your conversations didn’t load.';

export const EXPORT_THREADS_VERB = 'Export conversations';
export const EXPORT_THREADS_LINE = 'every message as CSV · yours, always';
