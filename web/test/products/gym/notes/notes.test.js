import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError } from '../../../../src/products/gym/gymApi.js';
import { BODY_COUNT_FROM as NAME_TWIN } from '../../../../src/products/gym/notes/notes.js';
import { NAME_COUNT_FROM, NAME_MAX } from '../../../../src/products/gym/log.js';
import {
  ADD_VERB, BODY_BYTES, BODY_COUNT_FROM, bodyBytes, byteCountLabel, DELETE_CONFIRM, DELETE_VERB,
  firstLineOf, FULL_LINE, HEAD_LINE, HONESTY_LINE, isBodyOverCap, isFull, mintNoteId, NOTE_PREFIX,
  noteRefusal, NOTES_MAX, orderOf, PLACEHOLDER_TITLES, PRECEDENCE_CAPTION, reorderNotes,
  EXPORT_NOTES_LINE, EXPORT_NOTES_VERB, isTitleOverCap, SETTINGS_LINE, showsByteCount, showsTitleCount,
  TITLE_COUNT_FROM, titleChars, titleCountLabel, TITLE_MAX,
} from '../../../../src/products/gym/notes/notes.js';

const note = (id, position, body = '') => ({ id, position, title: id, body, updatedAt: 0 });

test('the bounds are the store’s: ten notes, sixty characters, five hundred bytes', () => {
  assert.equal(NOTES_MAX, 10);
  assert.equal(TITLE_MAX, 60);
  assert.equal(BODY_BYTES, 500);
  assert.equal(isFull(Array.from({ length: 9 }, (_, i) => note(`note_${i}`, i))), false);
  assert.equal(isFull(Array.from({ length: 10 }, (_, i) => note(`note_${i}`, i))), true);
});

test('a note id is client-minted under its own prefix, the same discipline as a thread', () => {
  assert.equal(NOTE_PREFIX, 'note_');
  const id = mintNoteId();
  assert.match(id, /^note_[0-9a-f]{16}$/);
  assert.notEqual(mintNoteId(), id);
});

test('the body is measured in the bytes the store counts, not in characters', () => {
  assert.equal(bodyBytes('a'.repeat(500)), 500);
  assert.equal(bodyBytes('é'.repeat(250)), 500);
  assert.equal(bodyBytes('🏋'.repeat(125)), 500);
  assert.equal(bodyBytes(undefined), 0);
  assert.equal(isBodyOverCap('a'.repeat(500)), false);
  assert.equal(isBodyOverCap('a'.repeat(501)), true);
  assert.equal(isBodyOverCap('é'.repeat(251)), true);
});

test('the byte counter is drawn only from the last fifth, in the pinned form', () => {
  assert.equal(BODY_COUNT_FROM, 400);
  assert.equal(showsByteCount('a'.repeat(70)), false);
  assert.equal(showsByteCount('a'.repeat(399)), false);
  assert.equal(showsByteCount('a'.repeat(400)), true);
  assert.equal(byteCountLabel('a'.repeat(70)), '70 of 500 bytes');
  assert.equal(byteCountLabel('a'.repeat(512)), '512 of 500 bytes');
});

test('the name counter and the byte counter read one rule: the last fifth of their bound', () => {
  assert.equal(NAME_COUNT_FROM, 48);
  assert.equal(NAME_COUNT_FROM / NAME_MAX, 0.8);
  assert.equal(NAME_TWIN / BODY_BYTES, 0.8);
  assert.equal(TITLE_COUNT_FROM / TITLE_MAX, 0.8);
});

test('a title is counted in the code points the store counts, from the last fifth, and the sixty-first is taken and marked', () => {
  assert.equal(titleChars('🏋'.repeat(30)), 30);
  assert.equal(titleChars('é'.repeat(60)), 60);
  assert.equal(titleChars(undefined), 0);
  assert.equal(showsTitleCount('t'.repeat(47)), false);
  assert.equal(showsTitleCount('t'.repeat(48)), true);
  assert.equal(titleCountLabel('t'.repeat(48)), '48 of 60 characters');
  assert.equal(titleCountLabel('t'.repeat(61)), '61 of 60 characters');
  assert.equal(isTitleOverCap('t'.repeat(60)), false);
  assert.equal(isTitleOverCap('t'.repeat(61)), true);
  assert.equal(isTitleOverCap('🏋'.repeat(60)), false);
});

test('the notes export is offered in the words the other two exports use', () => {
  assert.equal(EXPORT_NOTES_VERB, 'Export notes');
  assert.equal(EXPORT_NOTES_LINE, 'every note as CSV · yours, always');
});

test('the head is one surprising fact and one line saying whose words these are, and nothing else', () => {
  assert.equal(HONESTY_LINE, 'Any agent you connect can read these too.');
  assert.equal(HEAD_LINE, 'what you write for Coach');
  assert.equal(HEAD_LINE.includes('about you'), false);
});

test('the ceilings are said at the moment they bite, in the pinned words', () => {
  assert.equal(FULL_LINE, '10 of 10 notes. Delete one to add another.');
  assert.equal(ADD_VERB, 'Add a note');
  assert.equal(PRECEDENCE_CAPTION, 'Top note wins.');
  assert.equal(SETTINGS_LINE, 'Coach reads your notes, not your settings.');
});

test('the two seeds are placeholders addressed to the agent, and a body is never one of them', () => {
  assert.deepEqual(PLACEHOLDER_TITLES, ['How I want to be talked to', 'What I am training for']);
  assert.equal(PLACEHOLDER_TITLES.some((title) => /body/i.test(title)), false);
});

test('deleting a note is confirmed, with a verb and a way to keep it', () => {
  assert.equal(DELETE_VERB, 'Delete note');
  assert.deepEqual(DELETE_CONFIRM, { title: 'Delete this note?', confirm: 'Delete', keep: 'Keep it' });
});

test('a row’s meta is the body’s first non-empty line, and nothing when there is none', () => {
  assert.equal(firstLineOf('Keep it blunt.\nNo cheering.'), 'Keep it blunt.');
  assert.equal(firstLineOf('\n\n  second line first  \nthird'), 'second line first');
  assert.equal(firstLineOf(''), '');
  assert.equal(firstLineOf(undefined), '');
});

test('reorderNotes moves one row, renumbers every position, and clamps to the list', () => {
  const notes = [note('note_a', 0), note('note_b', 1), note('note_c', 2)];
  assert.deepEqual(reorderNotes(notes, 2, 0).map((each) => [each.id, each.position]), [['note_c', 0], ['note_a', 1], ['note_b', 2]]);
  assert.deepEqual(reorderNotes(notes, 0, 9).map((each) => each.id), ['note_b', 'note_c', 'note_a']);
  assert.deepEqual(reorderNotes(notes, 1, -4).map((each) => each.id), ['note_b', 'note_a', 'note_c']);
  assert.equal(reorderNotes(notes, 1, 1), notes);
  assert.equal(reorderNotes(notes, 7, 0), notes);
  assert.deepEqual(orderOf(reorderNotes(notes, 2, 0)), ['note_c', 'note_a', 'note_b']);
});

test('a refusal speaks in the store’s own words where it sent any, and finishes itself otherwise', () => {
  assert.equal(noteRefusal(new GymError(400, 'a note runs to 500 bytes'), 'saved'), 'a note runs to 500 bytes');
  assert.equal(noteRefusal(new GymError(409, '10 of 10 notes. Delete one to add another.', 'notes-full'), 'saved'), '10 of 10 notes. Delete one to add another.');
  assert.equal(noteRefusal(new GymError(503, ''), 'saved'), 'That note wasn’t saved — the log didn’t answer. Try again when you have signal.');
  assert.equal(noteRefusal(undefined, 'deleted'), 'That note wasn’t deleted — the log didn’t answer. Try again when you have signal.');
});
