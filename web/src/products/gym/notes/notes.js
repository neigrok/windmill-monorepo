import { failureReason } from '../errors.js';
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
  return `${lengthIn(NoteRules.title.unit, title ?? '')} of ${NoteRules.title.max} characters`;
}

export function showsByteCount(body) {
  return lengthIn(NoteRules.body.unit, body ?? '') >= BODY_COUNT_FROM;
}

export function byteCountLabel(body) {
  return `${lengthIn(NoteRules.body.unit, body ?? '')} of ${NoteRules.body.max} bytes`;
}

// The room's title and what these are, in the lifter's own direction; then the one surprising fact,
// said in the panel under the head.
export const NOTES_TITLE = 'Notes';
export const HEAD_LINE = 'what you write for Coach';
export const HONESTY_LINE = 'Any agent you connect can read these too.';
export const PRECEDENCE_CAPTION = 'Top note wins.';
export const ADD_VERB = 'Add a note';
export const FULL_LINE = '10 of 10 notes. Delete one to add another.';

// Placeholder text inside empty rows, never stored notes; nothing is written until the lifter saves.
export const PLACEHOLDER_TITLES = ['How I want to be talked to', 'What I am training for'];

export const DELETE_VERB = 'Delete note';

// One press, and the way back is the window's Undo rather than a question in front of the act.
export const NOTE_DELETED = 'Note deleted.';

export const NOTES_FAILED = 'Your notes didn’t load.';

// The row's meta line is the body's first line: facts, never a sentence of this screen's own.
export function firstLineOf(body) {
  const line = (body ?? '').split('\n').find((each) => each.trim() !== '');
  return line ? line.trim() : '';
}

// A refusal speaks in the store's own words where it sent any; the store's sentence is never rewritten.
export function noteRefusal(error, verb) {
  if (error?.sentence) return error.sentence;
  return `That note wasn’t ${verb} — ${failureReason(error)}.`;
}
