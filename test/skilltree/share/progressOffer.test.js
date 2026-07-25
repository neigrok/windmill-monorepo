// The week offer's rules (brief #20, reconciled to canon C7). A recurring offer earns its place
// only if it cannot turn into nagging, so every gate is pinned here — including the two that decide
// whether it can exist at all: it rides the RETURN (once per period, never on the first, never
// twice), and two declines in a row retire it for that tree permanently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { considerProgressShare } from '../../../src/skilltree/share/progressOffer.js';
import { ShareLedger } from '../../../src/skilltree/persistence/ShareLedger.js';
import { PERIOD_MS, DAY_MS, DAY_UNIT } from '../../../src/skilltree/share/progressPeriod.js';

const PLANTED = 1_700_000_000_000;

function fakeStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
}

// A tree planted at PLANTED, last posted about in `postedInWeek`, opened in `openInWeek`.
function scenario({
  postedIds = ['a'],
  postedInWeek = 1,
  count = 1,
  openInWeek = 2,
  completedIds = ['a', 'b'],
  plantedAt = PLANTED,
  posted = true,
  unit,
} = {}) {
  const storage = fakeStorage();
  if (posted) new ShareLedger(storage).save('t_1', { completed: postedIds, at: PLANTED + (postedInWeek - 1) * PERIOD_MS, count });
  const now = PLANTED + (openInWeek - 1) * PERIOD_MS + DAY_MS;
  const states = new Map(completedIds.map((id) => [id, 'complete']));
  return {
    storage,
    args: { treeId: 't_1', plantedAt, completed: new Set(completedIds), states, completedAt: {}, unit, now, storage },
  };
}

test('the first open of a new period, with new work, is the offer — labelled and diffed', () => {
  const { args } = scenario({ postedIds: ['a'], count: 3, completedIds: ['a', 'b', 'c'], openInWeek: 3 });
  const decision = considerProgressShare(args);

  assert.equal(decision.offer, true);
  assert.deepEqual(decision.lit, ['b', 'c']);
  assert.equal(decision.period.label, 'Week 3');
  assert.equal(decision.period.ordinal, 4);
  assert.equal(decision.sinceAt, PLANTED); // week 1 posted, week 2 skipped — the card carries both
});

test('one step is enough — the rhythm is the period, never a quota of steps', () => {
  const { args } = scenario({ completedIds: ['a', 'b'] });
  assert.equal(considerProgressShare(args).offer, true);
});

test('the day label rides the same decision, so the toast and the hashtag agree', () => {
  const { args } = scenario({ openInWeek: 3, unit: DAY_UNIT });
  assert.equal(considerProgressShare(args).period.label, 'Day 16');
});

test('never on the first period — a tree gets a week to itself before anything asks it to post', () => {
  const { args } = scenario({ openInWeek: 1 });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('never twice in one period: the ask goes out once and the rest of the week is quiet', () => {
  const { storage, args } = scenario({ openInWeek: 2 });
  considerProgressShare(args).commit();

  assert.deepEqual(considerProgressShare({ ...args, now: args.now + DAY_MS }), { offer: false });
  // …and the next period asks again, because a period is exactly what it is counting.
  const nextWeek = { ...args, now: args.now + PERIOD_MS, storage };
  assert.equal(considerProgressShare(nextWeek).offer, true);
});

test('two declines in a row retire the offer for that tree — permanently, silently', () => {
  const { storage, args } = scenario({ openInWeek: 2 });

  considerProgressShare(args).commit();                                    // week 2: asked, ignored
  const second = { ...args, now: args.now + PERIOD_MS, storage };
  assert.equal(considerProgressShare(second).offer, true);
  considerProgressShare(second).commit();                                  // week 3: asked, ignored

  assert.deepEqual(considerProgressShare({ ...args, now: args.now + PERIOD_MS * 2, storage }), { offer: false });
  assert.deepEqual(considerProgressShare({ ...args, now: args.now + PERIOD_MS * 40, storage }), { offer: false });
});

test('an ask made where no share menu exists spends the period but never counts as a refusal', () => {
  const { storage, args } = scenario({ openInWeek: 2 });

  // A phone owner has no Share door to change their mind at, so a toast that fades there is the
  // only door closing — not a refusal. The period's one ask is still spent.
  considerProgressShare(args).commit({ countsAsDecline: false });
  assert.deepEqual(considerProgressShare({ ...args, now: args.now + DAY_MS, storage }), { offer: false });

  for (let week = 1; week <= 6; week += 1) {
    const later = { ...args, now: args.now + PERIOD_MS * week, storage };
    assert.equal(considerProgressShare(later).offer, true); // …and it can never strand them
    considerProgressShare(later).commit({ countsAsDecline: false });
  }
});

test('taking the offer clears the count — a poster is never two quiet weeks from retirement', () => {
  const { storage, args } = scenario({ openInWeek: 2 });

  const week2 = considerProgressShare(args);
  week2.commit();                                                          // week 2: asked…
  assert.equal(considerProgressShare({ ...args, now: args.now + 60_000, storage }).offer, false); // …once, and only once
  week2.accept();                                                          // …and taken

  const week3 = { ...args, now: args.now + PERIOD_MS, storage };
  assert.equal(considerProgressShare(week3).offer, true);
  considerProgressShare(week3).commit();                                   // one decline on a clean slate
  assert.equal(considerProgressShare({ ...args, now: args.now + PERIOD_MS * 2, storage }).offer, true);
});

test('an offer that never fires costs nothing — the ask is spent by commit(), not by deciding', () => {
  const { args } = scenario({ openInWeek: 2 });

  assert.equal(considerProgressShare(args).offer, true);  // decided, then dropped for a milestone
  assert.equal(considerProgressShare(args).offer, true);
  assert.equal(considerProgressShare({ ...args, now: args.now + 60_000 }).offer, true);
});

test('a quiet period is never dressed up as a post', () => {
  const { args } = scenario({ postedIds: ['a', 'b'], completedIds: ['a', 'b'] });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('a step whose node was since deleted can never be the thing that earns an offer', () => {
  const { args } = scenario({ postedIds: ['a'], completedIds: ['a', 'gone'] });
  args.states.delete('gone');
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('a tree never posted about is never offered — the first share is not a card about a diff', () => {
  const { args } = scenario({ posted: false, completedIds: ['a', 'b', 'c'], openInWeek: 4 });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('no planting time, no offer — the clock the card counts on is the planting one', () => {
  const { args } = scenario({ plantedAt: 0, openInWeek: 4 });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('storage that refuses reads as an un-retired, never-posted tree and commits without throwing', () => {
  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const args = {
    treeId: 't_1',
    plantedAt: PLANTED,
    completed: new Set(['a']),
    states: new Map([['a', 'complete']]),
    now: PLANTED + PERIOD_MS,
    storage: hostile,
  };
  assert.deepEqual(considerProgressShare(args), { offer: false });
});
