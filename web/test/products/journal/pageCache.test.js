import test from 'node:test';
import assert from 'node:assert/strict';

import { PageCache, blankPage, isWritten, normalizePage, winnerOf } from '../../../src/products/journal/pageCache.js';

const KEY = 'wm.journal.pages.anon';

function memoryStorage(seed = null) {
  const map = new Map();
  if (seed) map.set(KEY, JSON.stringify(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function refusingStorage(readable = null) {
  return {
    getItem: () => (readable === null ? null : JSON.stringify(readable)),
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
}

function pageOn(day, body, stamp, extra = {}) {
  return { day, body, mood: null, energy: null, source: 'typed', stamp, ...extra };
}

test('an unreadable store opens EMPTY rather than throwing', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} };
  assert.deepEqual(new PageCache(null, blocked).pages(), []);

  const garbage = memoryStorage();
  garbage.setItem(KEY, 'not json at all');
  assert.deepEqual(new PageCache(null, garbage).pages(), []);

  assert.deepEqual(new PageCache(null, null).pages(), []);
});

test('a stored blob is normalised on the way in — the wire’s 0 is this module’s null', () => {
  const cache = new PageCache(null, memoryStorage({
    '2026-08-01': { page: { day: '2026-08-01', body: 'a', mood: 0, energy: 2, source: 'spoken', stamp: '9:0:x' }, needsPush: true, read: true },
    'junk': { needsPush: true },
  }));

  assert.deepEqual(cache.pages(), [
    { day: '2026-08-01', body: 'a', mood: null, energy: 2, source: 'spoken', stamp: '9:0:x' },
  ]);
  assert.equal(cache.hasRead('2026-08-01'), true);
  assert.equal(cache.owed().length, 1);
});

test('store — last writer wins by stamp, and a tie goes to the page already held', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.store(pageOn('2026-08-01', 'first', '100:0:a'));
  cache.store(pageOn('2026-08-01', 'older', '50:0:a'));
  assert.equal(cache.page('2026-08-01').body, 'first');

  cache.store(pageOn('2026-08-01', 'newer', '200:0:a'));
  assert.equal(cache.page('2026-08-01').body, 'newer');

  cache.store(pageOn('2026-08-01', 'the same write arriving twice', '200:0:a'));
  assert.equal(cache.page('2026-08-01').body, 'newer');
});

test('store — a remote page that loses leaves the local write still owed', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.store(pageOn('2026-08-01', 'mine', '200:0:a'), { needsPush: true, read: true });

  cache.store(pageOn('2026-08-01', 'theirs, older', '100:0:b'), { needsPush: false, read: true });
  assert.deepEqual(cache.owed().map((entry) => entry.page.body), ['mine']);

  cache.store(pageOn('2026-08-01', 'theirs, newer', '300:0:b'), { needsPush: false, read: true });
  assert.deepEqual(cache.owed(), []);
  assert.equal(cache.page('2026-08-01').body, 'theirs, newer');
});

test('hold — an unstamped draft replaces what was held, stays owed, stays unread', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.hold({ day: '2026-08-07', body: 'first words', mood: null, energy: null, source: 'typed' });
  cache.hold({ day: '2026-08-07', body: 'first words, then more', mood: 3, energy: null, source: 'typed' });

  assert.deepEqual(cache.page('2026-08-07'), {
    day: '2026-08-07', body: 'first words, then more', mood: 3, energy: null, source: 'typed', stamp: '',
  });
  assert.equal(cache.hasRead('2026-08-07'), false);
  assert.deepEqual(cache.owed().map((entry) => entry.page.body), ['first words, then more']);
});

test('markRead — a day the browser holds unread words for is left entirely alone', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.hold({ day: '2026-08-07', body: 'written on a plane', mood: null, energy: null, source: 'typed' });

  cache.markRead('2026-08-07', pageOn('2026-08-07', 'this morning’s real page', '500:0:phone'));

  assert.equal(cache.page('2026-08-07').body, 'written on a plane');
  assert.equal(cache.hasRead('2026-08-07'), false);
  assert.equal(cache.owed().length, 1);
});

test('markRead — a named day and an unnamed one both become read', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.markRead('2026-08-01', pageOn('2026-08-01', 'wrote', '100:0:a'));
  cache.markRead('2026-08-02', null);

  assert.equal(cache.hasRead('2026-08-01'), true);
  assert.equal(cache.hasRead('2026-08-02'), true);
  assert.deepEqual(cache.page('2026-08-02'), blankPage('2026-08-02'));
  assert.deepEqual(cache.owed(), []);
});

test('markPushed — a reply is a receipt for ONE write, and a newer draft stays owed', () => {
  const cache = new PageCache(null, memoryStorage());
  const first = pageOn('2026-08-07', 'one sentence', '100:0:web');
  cache.store(first, { needsPush: true, read: true });
  const second = pageOn('2026-08-07', 'one sentence, and another', '200:0:web');
  cache.store(second, { needsPush: true, read: true });

  cache.markPushed('2026-08-07', first);

  assert.deepEqual(cache.owed().map((entry) => entry.page.stamp), ['200:0:web']);
  assert.equal(cache.page('2026-08-07').body, 'one sentence, and another');
});

test('markPushed — the write that was acknowledged stops being owed, and the day is read', () => {
  const cache = new PageCache(null, memoryStorage());
  const sent = pageOn('2026-08-07', 'today', '100:0:web');
  cache.store(sent, { needsPush: true, read: false });

  cache.markPushed('2026-08-07', sent);

  assert.deepEqual(cache.owed(), []);
  assert.equal(cache.hasRead('2026-08-07'), true);
});

test('owed — oldest first, so a backlog replays in the order it was lived', () => {
  const cache = new PageCache(null, memoryStorage());
  cache.hold({ day: '2026-08-06', body: 'b', mood: null, energy: null, source: 'typed' });
  cache.hold({ day: '2026-08-04', body: 'a', mood: null, energy: null, source: 'typed' });
  cache.hold({ day: '2026-08-07', body: 'c', mood: null, energy: null, source: 'typed' });
  cache.store(pageOn('2026-08-05', 'read and settled', '1:0:a'), { needsPush: false, read: true });

  assert.deepEqual(cache.owed().map((entry) => entry.page.day), ['2026-08-04', '2026-08-06', '2026-08-07']);
});

test('flush — union by day with what is already on disk, so a second tab’s day survives', () => {
  const storage = memoryStorage();
  const cache = new PageCache(null, storage);
  cache.store(pageOn('2026-08-02', 'this tab', '9:0:a'), { needsPush: true, read: true });

  storage.setItem(KEY, JSON.stringify({
    '2026-08-01': { page: { day: '2026-08-01', body: 'the other tab', mood: 0, energy: 0, source: 'typed', stamp: '5:0:b' }, needsPush: true, read: false },
  }));

  assert.equal(cache.flush(), true);
  const written = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(Object.keys(written).sort(), ['2026-08-01', '2026-08-02']);
  assert.equal(written['2026-08-01'].page.body, 'the other tab');
  assert.equal(written['2026-08-02'].page.body, 'this tab');
});

test('flush — the disk keeps the newest days plus everything owed, and history never crowds it', () => {
  const dayAt = (index) => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
  const storage = memoryStorage();
  const cache = new PageCache(null, storage);
  for (let k = 0; k < 200; k += 1) {
    cache.store(pageOn(dayAt(k), `day ${k}`, `${k + 1}:0:a`), { needsPush: k === 3, read: true });
  }

  assert.equal(cache.flush(), true);
  assert.equal(cache.pages().length, 200, 'the session it was read in still holds all of it');

  const reopened = new PageCache(null, storage);
  const days = reopened.pages().map((page) => page.day);
  assert.equal(days.length, 121);                  // the newest 120, plus the one page still owed
  assert.equal(days[0], dayAt(3), 'an owed page survives whatever its age — it is somebody’s prose');
  assert.equal(days[1], dayAt(80));
  assert.equal(days[120], dayAt(199));
  assert.deepEqual(reopened.owed().map((entry) => entry.page.day), [dayAt(3)]);
});

test('flush — a browser that refuses the bytes answers false, and never pretends', () => {
  const cache = new PageCache(null, refusingStorage());
  cache.hold({ day: '2026-08-07', body: 'nowhere to put this', mood: null, energy: null, source: 'typed' });
  assert.equal(cache.flush(), false);
  assert.equal(new PageCache(null, null).flush(), false);
});

test('a flushed cache round-trips through a reload, marks and all', () => {
  const storage = memoryStorage();
  const first = new PageCache(null, storage);
  first.hold({ day: '2026-08-07', body: 'signed out, on this device', mood: 4, energy: null, source: 'typed' });
  first.store(pageOn('2026-08-05', 'read once', '3:0:a'), { needsPush: false, read: true });
  assert.equal(first.flush(), true);

  const reopened = new PageCache(null, storage);
  assert.equal(reopened.page('2026-08-07').body, 'signed out, on this device');
  assert.equal(reopened.page('2026-08-07').mood, 4);
  assert.equal(reopened.hasRead('2026-08-07'), false);
  assert.equal(reopened.hasRead('2026-08-05'), true);
  assert.deepEqual(reopened.owed().map((entry) => entry.page.day), ['2026-08-07']);
});

test('isWritten — a mood with no words was still a day someone showed up for', () => {
  assert.equal(isWritten(blankPage('2026-08-07')), false);
  assert.equal(isWritten({ ...blankPage('2026-08-07'), mood: 1 }), true);
  assert.equal(isWritten({ ...blankPage('2026-08-07'), body: 'x' }), true);
  assert.equal(isWritten(normalizePage({ day: '2026-08-07', mood: 0, energy: 0 })), false);
});

test('winnerOf — an absent incumbent means the arriving page, whatever its stamp', () => {
  const arriving = pageOn('2026-08-07', 'x', '');
  assert.equal(winnerOf(arriving, null), arriving);
});
