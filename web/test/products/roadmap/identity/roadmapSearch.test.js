import test from 'node:test';
import assert from 'node:assert/strict';
import { roadmapMatch, SEARCH_THRESHOLD } from '../../../../src/products/roadmap/identity/roadmapSearch.js';

test('roadmap search begins above eight and matches the first title run case-insensitively', () => {
  assert.equal(SEARCH_THRESHOLD, 8);
  assert.deepEqual(roadmapMatch('Learn to code', 'CO'), { start: 9, end: 11 });
  assert.deepEqual(roadmapMatch('Coastal coast', 'co'), { start: 0, end: 2 });
  assert.equal(roadmapMatch('Learn to sail', 'code'), null);
});

test('roadmap search trims outside whitespace and preserves internal spaces', () => {
  assert.deepEqual(roadmapMatch('Learn to sail', ' \tTO SAIL\n'), { start: 6, end: 13 });
  assert.equal(roadmapMatch('Learn to sail', 'to  sail'), null);
  for (const query of ['', ' ', '\t\n', '\u2003']) {
    assert.deepEqual(roadmapMatch('Learn to sail', query), { start: 0, end: 0 });
    assert.deepEqual(roadmapMatch('', query), { start: 0, end: 0 });
  }
});

test('expanded lowercase runs map back to whole original title characters', () => {
  assert.deepEqual(roadmapMatch('İstanbul coast', 'COAST'), { start: 9, end: 14 });
  assert.deepEqual(roadmapMatch('İstanbul', 'i'), { start: 0, end: 1 });
  assert.deepEqual(roadmapMatch('İstanbul', 'İS'), { start: 0, end: 2 });
  assert.deepEqual(roadmapMatch('İİ coast', 'İ coast'), { start: 1, end: 8 });
  assert.deepEqual(roadmapMatch('İ', '\u0307'), { start: 0, end: 1 });
});

test('Unicode casing uses the whole title and preserves UTF-16 slice offsets', () => {
  assert.deepEqual(roadmapMatch('ΟΣ coast', 'ΟΣ'), { start: 0, end: 2 });
  assert.deepEqual(roadmapMatch('🧭 İ coast', 'COAST'), { start: 5, end: 10 });
  assert.deepEqual(roadmapMatch('Learn 𐐀 next', '𐐨'), { start: 6, end: 8 });
  assert.deepEqual(roadmapMatch('MÉTÉO', 'météo'), { start: 0, end: 5 });
  assert.equal(roadmapMatch('MÉTÉO', 'meteo'), null);
  assert.equal(roadmapMatch('Straße', 'STRASSE'), null);
});
