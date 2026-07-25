import test from 'node:test';
import assert from 'node:assert/strict';

import { GalleryIndex, cardMark, galleryHeader, CHIPS_AT, SEARCH_AT } from '../../../src/skilltree/browse/galleryIndex.js';

function entry(id, extra = {}) {
  return { id, title: id, forks: 0, sourceTitle: '', mine: false, forked: false, copyId: '', ...extra };
}

test('galleryHeader — the count speaks, and stays silent at zero', () => {
  assert.deepEqual(galleryHeader(0), { line: '', chips: false, search: false });
  assert.deepEqual(galleryHeader(1), { line: '1 tree planted in public', chips: false, search: false });
  assert.deepEqual(galleryHeader(7), { line: '7 trees planted in public', chips: false, search: false });
});

test('galleryHeader — canon §5: chips at 24, search at 100, never a step before', () => {
  assert.equal(CHIPS_AT, 24);
  assert.equal(SEARCH_AT, 100);
  assert.deepEqual(galleryHeader(23), { line: '23 trees planted in public', chips: false, search: false });
  assert.deepEqual(galleryHeader(24), { line: '24 trees planted in public', chips: true, search: false });
  assert.deepEqual(galleryHeader(99), { line: '99 trees planted in public', chips: true, search: false });
  assert.deepEqual(galleryHeader(100), { line: '100 trees planted in public', chips: true, search: true });
});

test('GalleryIndex — opens empty and loading, with nothing to page and nothing to say', () => {
  const index = new GalleryIndex();
  assert.deepEqual(index.entries, []);
  assert.equal(index.count, 0);
  assert.equal(index.cursor, '');
  assert.equal(index.status, 'loading');
  assert.equal(index.hasMore, false);
  assert.equal(index.isBare, false);
});

test('GalleryIndex — joining the first page carries the whole index count and the cursor', () => {
  const index = new GalleryIndex().join({ entries: [entry('t_1'), entry('t_2')], count: 9, nextCursor: 't_2' });
  assert.deepEqual(index.entries.map((row) => row.id), ['t_1', 't_2']);
  assert.equal(index.count, 9);
  assert.equal(index.cursor, 't_2');
  assert.equal(index.status, 'ready');
  assert.equal(index.hasMore, true);
  assert.equal(index.isBare, false);
});

test('GalleryIndex — joining a second page appends in the order the server ranked it', () => {
  const index = new GalleryIndex()
    .join({ entries: [entry('t_1'), entry('t_2')], count: 4, nextCursor: 't_2' })
    .paging()
    .join({ entries: [entry('t_3'), entry('t_4')], count: 4, nextCursor: '' });
  assert.deepEqual(index.entries.map((row) => row.id), ['t_1', 't_2', 't_3', 't_4']);
  assert.equal(index.count, 4);
  assert.equal(index.cursor, '');
  assert.equal(index.status, 'ready');
  assert.equal(index.hasMore, false);
});

test('GalleryIndex — a tree that shifted between pages is never shown twice', () => {
  const index = new GalleryIndex()
    .join({ entries: [entry('t_1'), entry('t_2')], count: 3, nextCursor: 't_2' })
    .join({ entries: [entry('t_2'), entry('t_3')], count: 3, nextCursor: '' });
  assert.deepEqual(index.entries.map((row) => row.id), ['t_1', 't_2', 't_3']);
});

test('GalleryIndex — an empty answer is bare, not loading', () => {
  const index = new GalleryIndex().join({ entries: [], count: 0, nextCursor: '' });
  assert.deepEqual(index.entries, []);
  assert.equal(index.status, 'ready');
  assert.equal(index.isBare, true);
  assert.equal(index.hasMore, false);
});

test('GalleryIndex — paging and failing keep every row already on screen', () => {
  const arrived = new GalleryIndex().join({ entries: [entry('t_1')], count: 2, nextCursor: 't_1' });

  const paging = arrived.paging();
  assert.deepEqual(paging.entries.map((row) => row.id), ['t_1']);
  assert.equal(paging.count, 2);
  assert.equal(paging.cursor, 't_1');
  assert.equal(paging.status, 'paging');

  const failed = paging.failed();
  assert.deepEqual(failed.entries.map((row) => row.id), ['t_1']);
  assert.equal(failed.cursor, 't_1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.isBare, false);
});

test('GalleryIndex — a fork marks its source, names the copy, and counts itself', () => {
  const index = new GalleryIndex()
    .join({ entries: [entry('t_1', { forks: 2 }), entry('t_2')], count: 2, nextCursor: '' })
    .forked('t_1', 't_copy');
  assert.deepEqual(index.entries[0], {
    id: 't_1', title: 't_1', forks: 3, sourceTitle: '', mine: false, forked: true, copyId: 't_copy',
  });
  assert.deepEqual(index.entries[1], {
    id: 't_2', title: 't_2', forks: 0, sourceTitle: '', mine: false, forked: false, copyId: '',
  });
  assert.equal(index.status, 'ready');
});

test('cardMark — a stranger’s tree opens read-only and offers the fork', () => {
  assert.deepEqual(cardMark(entry('t_1')), { badge: '', fork: 'offer', href: '#/t/t_1' });
});

test('cardMark — your own listed tree says so, opens in your editor, and is never offered back', () => {
  assert.deepEqual(cardMark(entry('t_1', { mine: true })), { badge: 'Listed by you', fork: 'none', href: '#/app/t_1' });
});

test('cardMark — a tree you already forked cannot be forked twice by accident', () => {
  assert.deepEqual(cardMark(entry('t_1', { forked: true })), { badge: 'Forked', fork: 'done', href: '#/t/t_1' });
});

test('cardMark — the fork you just made offers the copy it planted', () => {
  assert.deepEqual(cardMark(entry('t_1', { forked: true, copyId: 't_copy' })), { badge: 'Forked', fork: 'copy', href: '#/t/t_1' });
});

test('cardMark — yours wins over forked: a tree you own is yours before it is a copy', () => {
  assert.deepEqual(cardMark(entry('t_1', { mine: true, forked: true, copyId: 't_copy' })), {
    badge: 'Listed by you', fork: 'none', href: '#/app/t_1',
  });
});
