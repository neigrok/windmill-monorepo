import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  askedLabel, conversationsLine, DELETE_NOTE, monthsOf, NO_THREADS, outcomeChip, outcomeLine,
  THREAD_LIST_CEILING, THREADS_TITLE,
} from '../../../../src/products/gym/coach/threads.js';

const AUGUST = (day, hour = 9) => new Date(2026, 7, day, hour, 0).getTime();

test('the subhead counts the conversations and says they are yours to delete', () => {
  assert.equal(THREADS_TITLE, 'Threads');
  assert.equal(conversationsLine(9), '9 conversations · yours to delete');
  assert.equal(conversationsLine(1), '1 conversation · yours to delete');
});

test('the subhead prints no count while the list holds as many rows as the server will send', () => {
  assert.equal(THREAD_LIST_CEILING, 200);
  assert.equal(conversationsLine(199), '199 conversations · yours to delete');
  assert.equal(conversationsLine(200), 'yours to delete');
  assert.equal(conversationsLine(201), 'yours to delete');
});

test('an applied row names how much moved and where it moved', () => {
  assert.equal(outcomeChip({ kind: 'applied', changes: 4, routine: 'Push A' }), 'applied');
  assert.equal(outcomeLine({ kind: 'applied', changes: 4, routineId: 'rt_1', routine: 'Push A' }), '4 changes → Push A');
  assert.equal(outcomeLine({ kind: 'applied', changes: 1, routine: 'Legs' }), '1 change → Legs');
  assert.equal(outcomeLine({ kind: 'applied', changes: 6 }), '6 changes');
});

test('a read-only row says no changes were proposed, and that is the whole of it', () => {
  assert.equal(outcomeChip({ kind: 'read-only', changes: 0 }), 'read only');
  assert.equal(outcomeLine({ kind: 'read-only', changes: 0 }), 'no changes proposed');
});

test('a turned-down row says what was turned down — never “dismissed”, never why', () => {
  assert.equal(outcomeChip({ kind: 'dismissed', changes: 4 }), 'turned down');
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 4 }), '4 changes turned down');
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 1 }), '1 change turned down');
  const said = ['read-only', 'applied', 'proposed', 'dismissed', 'superseded']
    .map((kind) => outcomeLine({ kind, changes: 4, routineId: 'rt_1', routine: 'Push A' }));
  assert.deepEqual(said, [
    'no changes proposed', '4 changes → Push A', '4 changes waiting', '4 changes turned down',
    '4 changes superseded',
  ]);
  const spoken = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/products/gym/coach/threads.js'),
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

test('an outcome this build cannot read is drawn as nothing rather than as a guess', () => {
  assert.equal(outcomeChip({ kind: 'brand-new', changes: 2 }), null);
  assert.equal(outcomeLine({ kind: 'brand-new', changes: 2 }), null);
  assert.equal(outcomeChip(undefined), null);
  assert.equal(outcomeLine(undefined), null);
  assert.equal(outcomeLine({ kind: 'applied' }), null);
  assert.equal(outcomeLine({ kind: 'dismissed', changes: 0 }), '0 changes turned down');
});

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

test('a month from another year is named with it, and this year’s is not', () => {
  const months = monthsOf([
    { id: 'thr_1', askedAt: AUGUST(3) },
    { id: 'thr_2', askedAt: new Date(2025, 6, 21).getTime() },
  ], AUGUST(11, 18));
  assert.deepEqual(months.map((month) => month.label), ['August', 'July 2025']);
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

test('nothing in the threads vocabulary is an unread count, a badge or a notification', () => {
  const rules = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/products/gym/coach/threads.js'),
    'utf8',
  ).replace(/^[ \t]*\/\/.*$/gm, '');
  for (const inbox of ['unread', 'badge', 'notif', 'new message', 'waiting for you', 'pinned', 'search']) {
    assert.equal(rules.toLowerCase().includes(inbox), false, inbox);
  }
  assert.equal(NO_THREADS, 'Nothing here yet. Ask something and the conversation stays.');
});

test('the delete says the messages go and the change does not', () => {
  assert.match(DELETE_NOTE, /deletes the messages/);
  assert.match(DELETE_NOTE, /stays in the routine’s history/);
  assert.match(DELETE_NOTE, /fact about your program rather than a message/);
});
