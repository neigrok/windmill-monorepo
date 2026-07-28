import test from 'node:test';
import assert from 'node:assert/strict';

import { words, contentWords, trigrams, features } from '../../../../src/products/journal/search/tokenize.js';

test('words — lowercased, punctuation dropped, single characters ignored', () => {
  assert.deepEqual(words('The walk, it did NOT happen.'), ['the', 'walk', 'it', 'did', 'not', 'happen']);
  assert.deepEqual(words('a I of'), ['of']);
});

test('contentWords — function words drop out so only meaning-bearing words remain', () => {
  assert.deepEqual(contentWords('The walk did not happen in the quiet'), ['walk', 'happen', 'quiet']);
});

test('trigrams — character 3-grams within a single word', () => {
  assert.deepEqual(trigrams('walk'), ['wal', 'alk']);
});

test('features — content words weigh heavier than their trigrams; stopwords contribute nothing', () => {
  const f = features('the walk');
  assert.ok(f.some(([key, weight]) => key === 'w:walk' && weight === 1.0));
  const gram = f.find(([key]) => key.startsWith('t:'));
  assert.ok(gram && gram[1] < 1.0);
  assert.ok(f.every(([key]) => key !== 'w:the'));
});
