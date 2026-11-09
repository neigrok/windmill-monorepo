import { failureReason } from '../errors.js';
import { t } from '../i18n/index.js';
import { agoLabel, shortDayLabel } from '../log.js';

const MONTH_NAMES = [
  t('gym.threads.months.january'), t('gym.threads.months.february'), t('gym.threads.months.march'),
  t('gym.threads.months.april'), t('gym.threads.months.may'), t('gym.threads.months.june'),
  t('gym.threads.months.july'), t('gym.threads.months.august'), t('gym.threads.months.september'),
  t('gym.threads.months.october'), t('gym.threads.months.november'), t('gym.threads.months.december'),
];

export const THREADS_TITLE = t('gym.threads.title');

const OUTCOME_CHIPS = {
  applied: t('gym.threads.chips.applied'),
  created: t('gym.threads.chips.created'),
  'read-only': t('gym.threads.chips.readOnly'),
  proposed: t('gym.threads.chips.proposed'),
  dismissed: t('gym.threads.chips.dismissed'),
  superseded: t('gym.threads.chips.superseded'),
};

export function outcomeChip(outcome) {
  return OUTCOME_CHIPS[outcome?.kind] ?? null;
}

export function outcomeLine(outcome) {
  if (outcome?.kind === 'created') return outcome.routine ?? t('gym.threads.routinesCreated', { count: outcome.changes });
  if (outcome?.kind === 'read-only') return t('gym.threads.noChanges');
  if (typeof outcome?.changes !== 'number') return null;
  const count = outcome.changes;
  if (outcome.kind === 'applied' && outcome.routine) return t('gym.threads.appliedTo', { count, routine: outcome.routine });
  if (outcome.kind === 'applied') return t('gym.threads.applied', { count });
  if (outcome.kind === 'proposed') return t('gym.threads.waiting', { count });
  if (outcome.kind === 'dismissed') return t('gym.threads.turnedDown', { count });
  if (outcome.kind === 'superseded') return t('gym.threads.superseded', { count });
  return null;
}

// Today is named by the word agoLabel gives today; every older day by its date.
export function askedLabel(ms, now = Date.now()) {
  const today = agoLabel(now, now);
  return agoLabel(ms, now) === today ? today : shortDayLabel(ms);
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
      label: year === thisYear ? MONTH_NAMES[at.getMonth()] : t('gym.threads.monthOfYear', { month: MONTH_NAMES[at.getMonth()], year }),
      threads: [thread],
    });
  }
  return months;
}

export const NO_THREADS = t('gym.threads.empty');
export const NEW_THREAD_VERB = t('gym.threads.askNew');

export const DELETE_VERB = t('gym.threads.deleteVerb');

// What deleting a conversation does NOT take with it, said at the moment of the act as the
// transient's detail rather than standing on every visit to every conversation. Six words, so the
// whole transient is two lines from 327px up. Byte-identical to Android's `Deletion.Thread.detail`.
export const THREAD_DELETE_DETAIL = t('gym.threads.deleteDetail');

// What the room's transient says while the window holds it. The delete is not on the wire yet, so
// the sentence is in the past tense a lifter reads it in and the Undo beside it is the truth.
export const THREAD_DELETED = t('gym.threads.deleted');

// Said only after the window closed and the store refused the send — by which time the screen that
// asked is long gone, which is why the room owns the voice and not the screen.
export function threadDeleteFailure(error) {
  return t('gym.threads.deleteRefused', { reason: failureReason(error) });
}

export const THREAD_ABSENT = t('gym.threads.absent');
export const THREAD_FAILED = t('gym.threads.failed');
export const THREADS_FAILED = t('gym.threads.listFailed');
