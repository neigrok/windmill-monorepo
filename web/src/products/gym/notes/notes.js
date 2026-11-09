import { failureReason } from '../errors.js';
import { t } from '../i18n/index.js';
import { lengthIn } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { NoteRules } from '../domain/notes.js';

// The counters are chrome a short note does not need: each is drawn from the last fifth of its
// bound, the same rule `NAME_COUNT_FROM` (log.js) reads for a name.
export const BODY_COUNT_FROM = NoteRules.body.max * 0.8;
export const TITLE_COUNT_FROM = NoteRules.title.max * 0.8;

export function showsTitleCount(title) {
  return lengthIn(NoteRules.title.unit, title ?? '') >= TITLE_COUNT_FROM;
}

export function titleCountLabel(title) {
  return t('gym.notes.titleCount', { count: lengthIn(NoteRules.title.unit, title ?? ''), max: NoteRules.title.max });
}

export function showsByteCount(body) {
  return lengthIn(NoteRules.body.unit, body ?? '') >= BODY_COUNT_FROM;
}

export function byteCountLabel(body) {
  return t('gym.notes.byteCount', { count: lengthIn(NoteRules.body.unit, body ?? ''), max: NoteRules.body.max });
}

// The room's title and what these are, in the lifter's own direction; then the one surprising fact,
// said in the panel under the head.
export const NOTES_TITLE = t('gym.notes.title');
export const HEAD_LINE = t('gym.notes.headLine');
export const HONESTY_LINE = t('gym.notes.honestyLine');
export const PRECEDENCE_CAPTION = t('gym.notes.precedence');
export const ADD_VERB = t('gym.notes.add');
export const FULL_LINE = t('gym.notes.full');

// Placeholder text inside empty rows, never stored notes; nothing is written until the lifter saves.
export const PLACEHOLDER_TITLES = [t('gym.notes.placeholderVoice'), t('gym.notes.placeholderGoal')];

export const DELETE_VERB = t('gym.notes.delete');

// One press, and the way back is the window's Undo rather than a question in front of the act.
export const NOTE_DELETED = t('gym.notes.deleted');

export const NOTES_FAILED = t('gym.notes.failed');

// The row's meta line is the body's first line: facts, never a sentence of this screen's own.
export function firstLineOf(body) {
  const line = (body ?? '').split('\n').find((each) => each.trim() !== '');
  return line ? line.trim() : '';
}

// A refusal speaks in the store's own words where it sent any; the store's sentence is never rewritten.
export function noteRefusal(error, verb) {
  if (error?.sentence) return error.sentence;
  return t('gym.notes.notDone', { verb, reason: failureReason(error) });
}
