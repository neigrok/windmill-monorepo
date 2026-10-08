import test from 'node:test';
import assert from 'node:assert/strict';

import { CommitError } from '../../../../../packages/api-contract/sync/reference/client/commit.js';
import { GymRefusal } from '../../../../src/products/gym/errors.js';
import { BODY_COUNT_FROM as NAME_TWIN } from '../../../../src/products/gym/notes/notes.js';
import { NoteRules } from '../../../../src/products/gym/domain/notes.js';
import { NAME_COUNT_FROM, NAME_MAX } from '../../../../src/products/gym/log.js';
import {
  ADD_VERB, BODY_COUNT_FROM, byteCountLabel, DELETE_VERB,
  firstLineOf, FULL_LINE, HEAD_LINE, HONESTY_LINE, NOTES_TITLE, NOTE_DELETED,
  noteRefusal, PLACEHOLDER_TITLES, PRECEDENCE_CAPTION,
  showsByteCount, showsTitleCount,
  TITLE_COUNT_FROM, titleCountLabel,
} from '../../../../src/products/gym/notes/notes.js';

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
  assert.equal(NAME_TWIN / NoteRules.body.max, 0.8);
  assert.equal(TITLE_COUNT_FROM / NoteRules.title.max, 0.8);
});

test('a title is counted in the code points the store counts, from the last fifth, and the sixty-first is taken and marked', () => {
  assert.equal(showsTitleCount('t'.repeat(47)), false);
  assert.equal(showsTitleCount('t'.repeat(48)), true);
  assert.equal(titleCountLabel('t'.repeat(48)), '48 of 60 characters');
  assert.equal(titleCountLabel('t'.repeat(61)), '61 of 60 characters');
});

test('the head is one surprising fact and one line saying whose words these are, and nothing else', () => {
  assert.equal(NOTES_TITLE, 'Notes');
  assert.equal(HONESTY_LINE, 'Any agent you connect can read these too.');
  assert.equal(HEAD_LINE, 'what you write for Coach');
  assert.equal(HEAD_LINE.includes('about you'), false);
});

test('the ceilings are said at the moment they bite, in the pinned words', () => {
  assert.equal(FULL_LINE, '10 of 10 notes. Delete one to add another.');
  assert.equal(ADD_VERB, 'Add a note');
  assert.equal(PRECEDENCE_CAPTION, 'Top note wins.');
});

test('the two seeds are placeholders addressed to the agent, and a body is never one of them', () => {
  assert.deepEqual(PLACEHOLDER_TITLES, ['How I want to be talked to', 'What I am training for']);
  assert.equal(PLACEHOLDER_TITLES.some((title) => /body/i.test(title)), false);
});

test('deleting a note is one press, and the window says what left', () => {
  assert.equal(DELETE_VERB, 'Delete note');
  assert.equal(NOTE_DELETED, 'Note deleted.');
});

test('a row’s meta is the body’s first non-empty line, and nothing when there is none', () => {
  assert.equal(firstLineOf('Keep it blunt.\nNo cheering.'), 'Keep it blunt.');
  assert.equal(firstLineOf('\n\n  second line first  \nthird'), 'second line first');
  assert.equal(firstLineOf(''), '');
  assert.equal(firstLineOf(undefined), '');
});

test('a refusal speaks in the store’s own words where it sent any, and finishes itself otherwise', () => {
  assert.equal(noteRefusal(new GymRefusal('invalid', { sentence: 'a note runs to 500 bytes' }), 'saved'), 'a note runs to 500 bytes');
  assert.equal(noteRefusal(new GymRefusal('cap', { sentence: '10 of 10 notes. Delete one to add another.' }), 'saved'), '10 of 10 notes. Delete one to add another.');
  assert.equal(noteRefusal(new CommitError('the device store did not commit', 'store', { cause: new DOMException('storage refused', 'QuotaExceededError') }), 'saved'), 'That note wasn’t saved — this device couldn’t store it.');
  assert.equal(noteRefusal(undefined, 'deleted'), 'That note wasn’t deleted — the log didn’t answer. Try again when you have signal.');
});
