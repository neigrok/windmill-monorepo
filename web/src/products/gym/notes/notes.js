// The pure rules behind the notes screen. A note is a title and a body, stored verbatim; the bounds
// are the store's (`gym_notes`): ten per account, a title of sixty characters, a body of five hundred
// UTF-8 bytes. Notes are their own resource, never a field of the preferences document.

import { failureReason } from '../gymApi.js';
import { mintId } from '../mint.js';

export const NOTE_PREFIX = 'note_';

export function mintNoteId() {
  return mintId(NOTE_PREFIX);
}

export const NOTES_MAX = 10;
export const TITLE_MAX = 60;
export const BODY_BYTES = 500;

// The counters are chrome a short note does not need: each is drawn from the last fifth of its
// bound, the same rule `NAME_COUNT_FROM` (log.js) reads for a name.
export const BODY_COUNT_FROM = 400;
export const TITLE_COUNT_FROM = 48;

// The store counts a title in code points, so a title is measured here the same way.
export function titleChars(title) {
  return [...(title ?? '')].length;
}

export function showsTitleCount(title) {
  return titleChars(title) >= TITLE_COUNT_FROM;
}

export function titleCountLabel(title) {
  return `${titleChars(title)} of ${TITLE_MAX} characters`;
}

// The field takes the keystroke and the counter goes alarm; the store's refusal is shown in place.
export function isTitleOverCap(title) {
  return titleChars(title) > TITLE_MAX;
}

export function bodyBytes(body) {
  return new TextEncoder().encode(body ?? '').length;
}

export function showsByteCount(body) {
  return bodyBytes(body) >= BODY_COUNT_FROM;
}

export function byteCountLabel(body) {
  return `${bodyBytes(body)} of ${BODY_BYTES} bytes`;
}

export function isBodyOverCap(body) {
  return bodyBytes(body) > BODY_BYTES;
}

export function isFull(notes) {
  return notes.length >= NOTES_MAX;
}

// The one surprising fact, at the head; then what these are, in the lifter's own direction.
export const HONESTY_LINE = 'Any agent you connect can read these too.';
export const HEAD_LINE = 'what you write for Coach';
export const PRECEDENCE_CAPTION = 'Top note wins.';
export const ADD_VERB = 'Add a note';
export const FULL_LINE = '10 of 10 notes. Delete one to add another.';

// Placeholder text inside empty rows, never stored notes; nothing is written until the lifter saves.
export const PLACEHOLDER_TITLES = ['How I want to be talked to', 'What I am training for'];

export const DELETE_VERB = 'Delete note';
export const DELETE_CONFIRM = { title: 'Delete this note?', confirm: 'Delete', keep: 'Keep it' };

export const NOTES_FAILED = 'Your notes didn’t load.';

export const EXPORT_NOTES_VERB = 'Export notes';
export const EXPORT_NOTES_LINE = 'every note as CSV · yours, always';

// Beside the dials in settings, naming what it excludes rather than pointing at a control.
export const SETTINGS_LINE = 'Coach reads your notes, not your settings.';

// The row's meta line is the body's first line: facts, never a sentence of this screen's own.
export function firstLineOf(body) {
  const line = (body ?? '').split('\n').find((each) => each.trim() !== '');
  return line ? line.trim() : '';
}

// Order is precedence. Positions are renumbered here so the list on screen agrees with the write.
export function reorderNotes(notes, from, to) {
  const target = Math.max(0, Math.min(notes.length - 1, to));
  if (from === target || !notes[from]) return notes;
  const next = [...notes];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next.map((note, position) => ({ ...note, position }));
}

// The whole order, every note exactly once; the store refuses anything else.
export function orderOf(notes) {
  return notes.map((note) => note.id);
}

// A refusal speaks in the store's own words where it sent any; the store's sentence is never rewritten.
export function noteRefusal(error, verb) {
  if (error?.detail) return error.detail;
  return `That note wasn’t ${verb} — ${failureReason(error)}.`;
}
