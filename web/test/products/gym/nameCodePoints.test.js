// One fixture, three surfaces. The same sixty-character name is pinned here, in
// `NameCodePointTests.swift` (iOS) and in `NameCodePointTests.kt` (Android): thirty emoji and thirty
// accented letters. It reads as sixty characters on all three because a character is a CODE POINT —
// the unit Postgres `char_length` counts — and it weighs 180 bytes, under the store's 240.
// The three units this name tells apart: 60 code points · 90 UTF-16 units · 180 UTF-8 bytes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import {
  cappedName, isNameOverCap, NAME_MAX, nameChars, nameCountLabel, showsNameCount,
} from '../../../src/products/gym/log.js';
import { duplicateRoutine } from '../../../src/products/gym/routines.js';
import {
  isTitleOverCap, titleChars, titleCountLabel, TITLE_MAX,
} from '../../../src/products/gym/notes/notes.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle } from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const SIXTY = '😀'.repeat(30) + 'ü'.repeat(30);
const SIXTY_ONE = `${SIXTY}ü`;

// The other half of the fixture, and the shape that tells a code point from what the eye counts: one
// lifter is ONE thing on screen and five code points underneath. Sixty of these would weigh 960
// bytes, four times the store's ceiling; twelve of them are the sixty characters this cap allows.
const LIFTER = '🏋️‍♀️';
const bytesOf = (text) => new TextEncoder().encode(text).length;

test('the shared fixture is sixty code points, ninety UTF-16 units and one hundred eighty bytes', () => {
  assert.equal(nameChars(SIXTY), 60);
  assert.equal(SIXTY.length, 90);
  assert.equal(bytesOf(SIXTY), 180);
  assert.equal(nameChars(SIXTY_ONE), 61);
});

test('a name of sixty code points is accepted whole, and counts sixty', () => {
  assert.equal(nameCountLabel(SIXTY), '60/60');
  assert.equal(showsNameCount(SIXTY), true);
  assert.equal(isNameOverCap(SIXTY), false);
  assert.equal(cappedName(SIXTY), SIXTY);
  assert.equal(bytesOf(cappedName(SIXTY)) <= 240, true, 'sixty code points always fit the store');
});

test('the sixty-first code point is the only one refused, and the cut never halves a character', () => {
  assert.equal(nameCountLabel(SIXTY_ONE), '61/60');
  assert.equal(isNameOverCap(SIXTY_ONE), true);
  assert.equal(cappedName(SIXTY_ONE), SIXTY);

  const emoji = '😀'.repeat(61);
  assert.equal(cappedName(emoji), '😀'.repeat(NAME_MAX));
  assert.equal(bytesOf(cappedName(emoji)), 240, 'the heaviest sixty characters there are');
  assert.equal(/\p{Surrogate}/u.test(cappedName(emoji)), false, 'no half of a character survives the cut');
});

test('a duplicate’s name is cut in code points too, so no copy carries half a character', () => {
  const copy = duplicateRoutine({ id: 'rt_1', name: '😀'.repeat(60), position: 0, entries: [] }, { id: 'rt_2', position: 1 });
  assert.equal(copy.name, `${'😀'.repeat(55)} copy`);
  assert.equal(nameChars(copy.name), NAME_MAX);
  assert.equal(/\p{Surrogate}/u.test(copy.name), false);
});

test('one thing on screen can be five characters, and the cap counts all five', () => {
  assert.equal(nameChars(LIFTER), 5);
  assert.equal(LIFTER.length, 6, 'six UTF-16 units');
  assert.equal(bytesOf(LIFTER), 16);

  const twelve = LIFTER.repeat(12);
  assert.equal(nameChars(twelve), 60);
  assert.equal(nameCountLabel(twelve), '60/60');
  assert.equal(isNameOverCap(twelve), false);
  assert.equal(cappedName(twelve), twelve);
  assert.equal(bytesOf(twelve), 192, 'under the store\u2019s 240');

  assert.equal(nameChars(LIFTER.repeat(13)), 65);
  assert.equal(isNameOverCap(LIFTER.repeat(13)), true);
  assert.equal(cappedName(LIFTER.repeat(13)), twelve);
  assert.equal(titleChars(twelve), 60);
  assert.equal(isTitleOverCap(LIFTER.repeat(13)), true);
});

test('a note’s title counts the same fixture the same way, against the column’s own char_length', () => {
  assert.equal(titleChars(SIXTY), 60);
  assert.equal(titleCountLabel(SIXTY), '60 of 60 characters');
  assert.equal(isTitleOverCap(SIXTY), false);
  assert.equal(titleChars(SIXTY_ONE), 61);
  assert.equal(isTitleOverCap(SIXTY_ONE), true);
  assert.equal(TITLE_MAX, NAME_MAX);
});

// The finish card mints a routine in passing, so it takes the editor's CAP and its UNIT — and NOT
// its counter. A counter is drawn where a name is worked on (`15-the-routine.md`); adding one to a
// receipt would be chrome, so its absence here is a decision and not an omission.
test('the finish card cuts a typed routine name at sixty code points, and draws no counter', async (t) => {
  browserWith();
  const session = { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000 };
  const sets = [{ id: 'st_1', exerciseId: 'squat', kind: 'working', weightKg: 100, reps: 5 }];
  global.fetch = async (url) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [{ id: 'squat', name: 'Squat' }] }) };
    if (path === '/sessions?limit=2') return { ok: true, status: 200, json: async () => ({ sessions: [session] }) };
    if (path === '/sessions/ses_1') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets }) };
    if (path === '/sessions/ses_1/review') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ slight: false, stats: { durationMs: 3_600_000, workingSets: 1, topE1rm: null }, record: null, against: null }),
      };
    }
    throw new Error(`unexpected GET ${path}`);
  };

  const { FinishScreen } = await loadScreen('products/gym/Finish.jsx');
  // The card is a child component, so the harness does not render it: it is rendered here, inside
  // the same pass, which is what gives its own hooks a dispatcher.
  const view = renderHook(t, () => {
    const screen = FinishScreen({ id: 'ses_1', log: roomLog() });
    const card = elementsOf(screen).find((each) => typeof each.type === 'function' && each.type.name === 'KeepAsRoutine');
    return card ? card.type(card.props) : null;
  });
  await settle();

  const field = () => findByClass(view.tree, 'gym-keep-input')[0];
  assert.equal(field().props.maxLength, undefined, 'UTF-16 units are not this room’s unit');
  field().props.onChange({ target: { value: SIXTY_ONE } });
  assert.equal(field().props.value, SIXTY);
  assert.equal(nameChars(field().props.value), NAME_MAX);
  assert.equal(/\p{Surrogate}/u.test(field().props.value), false, 'no half of a character survives the cut');

  field().props.onChange({ target: { value: LIFTER.repeat(13) } });
  assert.equal(field().props.value, LIFTER.repeat(12), 'twelve of these are the sixty characters');
  assert.equal(findByClass(view.tree, 'gym-name-count').length, 0, 'the cap comes to the receipt; the counter does not');
});
