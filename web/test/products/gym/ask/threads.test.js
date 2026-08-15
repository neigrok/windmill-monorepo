// ASK HAS A PAST (§O). Two promises are pinned here and they are the whole section:
//
//   1. A thread is titled by the lifter's FIRST MESSAGE, VERBATIM. There is no titling function in
//      the module under test, and this file asserts that there is nothing that could become one.
//   2. EVERY ROW'S SECOND LINE IS SOMETHING THE SERVER OBSERVED. The board draws a dismissed row
//      reading `built it myself instead`; nothing observes why a lifter dismissed a proposal and this
//      product does not ask, so a row saying it would be us narrating a motive onto somebody's
//      evening — one line under the rule about never summarising a person. What ships is what was
//      dismissed and nothing about why.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  askedLabel, conversationsLine, DELETE_NOTE, monthsOf, NO_THREADS, outcomeChip, outcomeLine,
  THREAD_LIST_CEILING, THREADS_TITLE,
} from '../../../../src/products/gym/ask/threads.js';

const AUGUST = (day, hour = 9) => new Date(2026, 7, day, hour, 0).getTime();

test('the subhead counts the conversations and says they are yours to delete', () => {
  assert.equal(THREADS_TITLE, 'Threads');
  assert.equal(conversationsLine(9), '9 conversations · yours to delete');
  assert.equal(conversationsLine(1), '1 conversation · yours to delete');
});

// THE COUNT STOPS AT THE CEILING. The list is bounded at 200 with no total and no "more" flag (§6),
// so two hundred rows is a floor and not a count — "200 conversations" over a log of three hundred
// is a number the wire never sent, and §6 forbids printing one at the ceiling.
test('the subhead prints no count while the list holds as many rows as the server will send', () => {
  assert.equal(THREAD_LIST_CEILING, 200);
  assert.equal(conversationsLine(199), '199 conversations · yours to delete');
  assert.equal(conversationsLine(200), 'yours to delete');
  assert.equal(conversationsLine(201), 'yours to delete');
});

// ── The outcome, which is the reason a row is worth coming back to ──────────────────────────────

// THE COUNT AND THE ROUTINE ARE BOTH FACTS, and the server derived them from the proposals the
// thread minted rather than storing a second copy of them — so every one of these sentences can be
// checked by opening the routine underneath it.
test('an applied row names how much moved and where it moved', () => {
  assert.equal(outcomeChip({ kind: 'applied', changes: 4, routine: 'Push A' }), 'applied');
  assert.equal(outcomeLine({ kind: 'applied', changes: 4, routineId: 'rt_1', routine: 'Push A' }), '4 changes → Push A');
  // One change reads as one change — the spelling every other surface in gym uses (`changeLabel`).
  assert.equal(outcomeLine({ kind: 'applied', changes: 1, routine: 'Legs' }), '1 change → Legs');
  // Changes that spanned more than one routine carry NO routine at all, and the line says the half
  // it knows rather than naming one of the two.
  assert.equal(outcomeLine({ kind: 'applied', changes: 6 }), '6 changes');
});

// A CONVERSATION THAT CHANGED NOTHING IS NOT A LESSER ONE. Most questions worth asking do not want a
// change made, so `read only` is a state with its own words rather than an empty subtitle.
test('a read-only row says no changes were proposed, and that is the whole of it', () => {
  assert.equal(outcomeChip({ kind: 'read-only', changes: 0 }), 'read only');
  assert.equal(outcomeLine({ kind: 'read-only', changes: 0 }), 'no changes proposed');
});

// THE LINE THE BOARD GOT WRONG. `built it myself instead` is a motive, and nothing in this product
// observes one: there is no field for it on the wire, no question that asks for it, and no place a
// model could write one. So a dismissed row carries the COUNT and stops.
test('a dismissed row says what was dismissed and never why', () => {
  assert.equal(outcomeChip({ kind: 'dismissed', changes: 4 }), 'dismissed');
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 4 }), '4 changes dismissed');
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 1 }), '1 change dismissed');
  // AND THE WHOLE VOCABULARY OF SUBTITLES IS THIS, over every outcome the wire can send: a count, a
  // routine when there is one, and one word for what became of the changes. There is no branch left
  // for a reason to be written into, which is the only way this rule stays true — a scan for the
  // board's sentence would pass the day somebody wrote a different one.
  const said = ['read-only', 'applied', 'proposed', 'dismissed', 'superseded']
    .map((kind) => outcomeLine({ kind, changes: 4, routineId: 'rt_1', routine: 'Push A' }));
  assert.deepEqual(said, [
    'no changes proposed', '4 changes → Push A', '4 changes waiting', '4 changes dismissed',
    '4 changes superseded',
  ]);
  // The module holds no words a motive could be spelled with, either.
  const spoken = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/products/gym/ask/threads.js'),
    'utf8',
  ).replace(/^[ \t]*\/\/.*$/gm, '');
  for (const motive of ['instead', 'myself', 'you decided', 'preferred', 'didn’t want']) {
    assert.equal(spoken.includes(motive), false, motive);
  }
});

test('a proposal still waiting, and one the program moved past, each say which', () => {
  assert.equal(outcomeLine({ kind: 'proposed', changes: 3 }), '3 changes waiting');
  assert.equal(outcomeChip({ kind: 'proposed', changes: 3 }), 'proposed');
  assert.equal(outcomeLine({ kind: 'superseded', changes: 2 }), '2 changes superseded');
  assert.equal(outcomeChip({ kind: 'superseded', changes: 2 }), 'superseded');
});

// A KIND THIS BUILD DOES NOT KNOW DRAWS NOTHING. A row with a title and no subtitle is honest; one
// captioned by a word this file invented is the failure the whole section exists to prevent.
test('an outcome this build cannot read is drawn as nothing rather than as a guess', () => {
  assert.equal(outcomeChip({ kind: 'brand-new', changes: 2 }), null);
  assert.equal(outcomeLine({ kind: 'brand-new', changes: 2 }), null);
  assert.equal(outcomeChip(undefined), null);
  assert.equal(outcomeLine(undefined), null);
  // `changes` is always sent and a 0 is real; a count that did not arrive is not turned into one.
  assert.equal(outcomeLine({ kind: 'applied' }), null);
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 0 }), '0 changes dismissed');
});

// ── The list itself ────────────────────────────────────────────────────────────────────────────

// The months are a fold over the order the server sent, exactly as the log's weeks are a fold over
// its page: nothing here sorts, so this screen can never disagree with the wire about which
// conversation is the newest.
test('monthsOf groups adjacent rows and keeps the order it was handed', () => {
  const threads = [
    { id: 'thr_1', askedAt: AUGUST(11) },
    { id: 'thr_2', askedAt: AUGUST(7) },
    { id: 'thr_3', askedAt: new Date(2026, 6, 21).getTime() },
    { id: 'thr_4', askedAt: new Date(2026, 6, 14).getTime() },
  ];
  const months = monthsOf(threads, AUGUST(11, 18));
  assert.equal(months.length, 2);
  assert.equal(months[0].label, 'August');
  assert.deepEqual(months[0].threads.map((thread) => thread.id), ['thr_1', 'thr_2']);
  assert.equal(months[1].label, 'July');
  assert.deepEqual(months[1].threads.map((thread) => thread.id), ['thr_3', 'thr_4']);
  assert.deepEqual(monthsOf([], AUGUST(11)), []);
  assert.deepEqual(monthsOf(undefined, AUGUST(11)), []);
});

// A MONTH OUTSIDE THIS YEAR CARRIES ITS YEAR — the same rule `arrivedLabel` keeps for a weekday, for
// the same reason: two Julys under one heading leave the reader supplying the wrong one, and a
// conversation kept for six weeks is a conversation kept for eighteen months.
test('a month from another year is named with it, and this year’s is not', () => {
  const months = monthsOf([
    { id: 'thr_1', askedAt: AUGUST(3) },
    { id: 'thr_2', askedAt: new Date(2025, 6, 21).getTime() },
  ], AUGUST(11, 18));
  assert.deepEqual(months.map((month) => month.label), ['August', 'July 2025']);
  // Two different Julys are two headings and never one group.
  const twoJulys = monthsOf([
    { id: 'a', askedAt: new Date(2026, 6, 2).getTime() },
    { id: 'b', askedAt: new Date(2025, 6, 2).getTime() },
  ], AUGUST(11));
  assert.equal(twoJulys.length, 2);
});

test('the right of a row is today by its word and every older day by its date', () => {
  assert.equal(askedLabel(AUGUST(11, 7), AUGUST(11, 21)), 'today');
  assert.equal(askedLabel(AUGUST(7), AUGUST(11)), '7 Aug');
  assert.equal(askedLabel(new Date(2026, 6, 21).getTime(), AUGUST(11)), '21 Jul');
});

// ── Not an inbox, and delete deletes the conversation and not the consequence ───────────────────

// A THREADS SCREEN IS THE MOST NATURAL PLACE IN THIS PRODUCT TO GROW A BADGE, and it must not. The
// scan is over the module that holds every word this screen says: an unread count would need a
// vocabulary, and there is none here to write it in.
test('nothing in the threads vocabulary is an unread count, a badge or a notification', () => {
  const rules = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/products/gym/ask/threads.js'),
    'utf8',
  ).replace(/^[ \t]*\/\/.*$/gm, '');
  for (const inbox of ['unread', 'badge', 'notif', 'new message', 'waiting for you', 'pinned', 'search']) {
    assert.equal(rules.toLowerCase().includes(inbox), false, inbox);
  }
  // And the empty room does not speak first either: it says what it is, and offers the one door out.
  assert.equal(NO_THREADS, 'Nothing here yet. Ask something and the conversation stays.');
});

// §O IN ONE SENTENCE, said before the tap rather than in a toast after: an applied change stays in
// the routine's history, because that is a fact about your program rather than a message.
test('the delete says the messages go and the change does not', () => {
  assert.match(DELETE_NOTE, /deletes the messages/);
  assert.match(DELETE_NOTE, /stays in the routine’s history/);
  assert.match(DELETE_NOTE, /fact about your program rather than a message/);
});
