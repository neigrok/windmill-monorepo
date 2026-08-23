import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expiryLine, SHARE_OFFER, SHARE_OFFER_LINE, SHARE_TERMS, SHARED_ABSENT, SHARED_TERMS, sharedGroups,
  shareLink,
} from '../../../../src/products/gym/share/share.js';
import { sharedTokenOf } from '../../../../src/products/gym/log.js';

const TOKEN = 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0';

test('shareLink — the whole link, and the parse at the other end reads the same token back', () => {
  assert.equal(shareLink(TOKEN, 'https://windmill.works'), `https://windmill.works/#/gym/shared/${TOKEN}`);
  assert.equal(sharedTokenOf(`#/gym/shared/${TOKEN}`), TOKEN);
  assert.equal(shareLink(TOKEN, 'http://localhost:5173'), `http://localhost:5173/#/gym/shared/${TOKEN}`);
  assert.equal(shareLink(TOKEN), `/#/gym/shared/${TOKEN}`);
});

test('expiryLine — the lifter is told the day the link ends, because that side knows it', () => {
  assert.equal(expiryLine(new Date(2026, 7, 6, 9, 30).getTime()), 'Expires Thu 6 Aug.');
});

test('the share terms describe the capability, and never call it public', () => {
  assert.deepEqual(SHARE_TERMS, [
    'Anyone holding this link can read this one workout.',
    'It opens nothing else — no other session, no account, no name.',
    'You can revoke it here at any time, and the link stops working.',
  ]);
  assert.equal(SHARE_OFFER, 'Share with a coach');
  assert.equal(
    SHARE_OFFER_LINE,
    'A link to this one workout. It expires, you can revoke it here, and sharing again hands back the same link rather than a second one.',
  );
  const everyWord = [SHARE_OFFER, SHARE_OFFER_LINE, ...SHARE_TERMS, ...SHARED_TERMS, SHARED_ABSENT.title, SHARED_ABSENT.body]
    .join(' ').toLowerCase();
  assert.equal(everyWord.includes('public'), false);
  assert.equal(everyWord.includes('share sheet'), false);
});

test('SHARED_ABSENT — the page does not guess which of the three it is looking at', () => {
  assert.equal(SHARED_ABSENT.title, 'This link doesn’t open a workout.');
  assert.equal(
    SHARED_ABSENT.body,
    'It may have expired, been revoked, or never existed. The log answers all three the same way, so there is nothing more to tell you.',
  );
});

test('SHARED_TERMS — what the coach is told, with no date it cannot see', () => {
  assert.deepEqual(SHARED_TERMS, [
    'One workout, shared by the person who trained it.',
    'The link expires, and they can revoke it at any time.',
    'It carries no name and opens nothing else in their log.',
    'Weights are in kilograms.',
  ]);
  assert.equal(SHARED_TERMS.join(' ').includes('Expires'), false);
});

test('sharedGroups — the same order the owner sees, keyed on the name the wire carries', () => {
  const groups = sharedGroups([
    { exercise: 'Bench Press', setNumber: 1, weightKg: 80, reps: 8, kind: 'working', note: '', completedAt: 300 },
    { exercise: 'Back Squat', setNumber: 1, weightKg: 100, reps: 5, kind: 'working', note: '', completedAt: 100 },
    { exercise: 'Bench Press', setNumber: 2, weightKg: 80, reps: 7, kind: 'working', note: '', completedAt: 400 },
    { exercise: 'Back Squat', setNumber: 2, weightKg: 105, reps: 5, kind: 'working', note: '', completedAt: 200 },
  ]);
  assert.deepEqual(groups.map(([exercise]) => exercise), ['Back Squat', 'Bench Press']);
  assert.deepEqual(groups.map(([, sets]) => sets.map((set) => set.setNumber)), [[1, 2], [1, 2]]);
  assert.deepEqual(groups[1][1].map((set) => set.reps), [8, 7]);
});
