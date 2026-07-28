import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex } from '../../../../src/products/journal/search/searchIndex.js';
import { contentWords } from '../../../../src/products/journal/search/tokenize.js';

// A deterministic stand-in for a real embedder: a passage becomes a unit vector over a fixed content
// vocabulary, so cosine is just shared-content-word overlap — enough to pin the index's ranking, its
// batching, and its stamp-dedup without loading a model. It records every embedAll batch it's handed.
const VOCAB = ['calm', 'lake', 'felt', 'deadline', 'anxious', 'passed', 'walk', 'quiet'];

class FakeEmbedder {
  floor = 0.1;
  batches = [];

  vector(text) {
    const present = new Set(contentWords(text));
    const raw = VOCAB.map((word) => (present.has(word) ? 1 : 0));
    const norm = Math.sqrt(raw.reduce((sum, x) => sum + x, 0)) || 1;
    return Float32Array.from(raw, (x) => x / norm);
  }

  async embedAll(texts) {
    this.batches.push(texts);
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text) {
    return this.vector(text);
  }
}

const PAGES = [
  { day: '2026-07-20', body: 'I felt calm by the lake.', stamp: '10' },
  { day: '2026-07-21', body: 'The deadline made me anxious. Then it passed.', stamp: '20' },
];

test('ingest — every new passage is embedded once, in a single batch', async () => {
  const embedder = new FakeEmbedder();
  const index = new SearchIndex(embedder);
  await index.ingest(PAGES);
  assert.equal(index.size, 3);
  assert.equal(embedder.batches.length, 1);
  assert.deepEqual(embedder.batches[0], ['I felt calm by the lake.', 'The deadline made me anxious.', 'Then it passed.']);
});

test('ingest — an unchanged stamp is skipped, a changed one re-embeds only its page', async () => {
  const embedder = new FakeEmbedder();
  const index = new SearchIndex(embedder);
  await index.ingest(PAGES);
  await index.ingest(PAGES);
  assert.equal(embedder.batches.length, 1, 'no new batch when nothing changed');
  await index.ingest([{ day: '2026-07-21', body: 'Still anxious about the deadline.', stamp: '30' }]);
  assert.equal(embedder.batches.length, 2);
  assert.deepEqual(embedder.batches[1], ['Still anxious about the deadline.']);
});

test('query — one position per day, best passage, above the floor, ranked, with an honest why', async () => {
  const index = new SearchIndex(new FakeEmbedder());
  await index.ingest(PAGES);
  const hits = await index.query('anxious');
  assert.equal(hits.length, 1, 'the calm day scores zero and is dropped by the floor');
  assert.equal(hits[0].day, '2026-07-21');
  assert.equal(hits[0].text, 'The deadline made me anxious.');
  assert.equal(hits[0].why, 'close to · anxious');
  assert.equal(index.byDay.get('2026-07-21').passages.length, 2);
});

test('query — the floor comes from the embedder, and an explicit floor overrides it', async () => {
  const index = new SearchIndex(new FakeEmbedder());
  await index.ingest(PAGES);
  const wide = await index.query('walk', { floor: -1 });
  assert.equal(wide.length, 2, 'a floor below every score keeps a hit for both days');
  const none = await index.query('walk');
  assert.equal(none.length, 0, 'the embedder floor drops everything that shares nothing');
});
