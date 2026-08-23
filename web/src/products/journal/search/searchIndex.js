// Every page's passages, embedded on the device and re-embedded only when a page's stamp changes.
// In-memory: the vectors and the query never touch the network. The vectors come from whatever Embedder
// it was built with.

import { chunk } from './chunk.js';
import { cosine, topK } from './cosine.js';
import { contentWords } from './tokenize.js';

export class SearchIndex {
  constructor(embedder) {
    this.embedder = embedder;
    this.byDay = new Map();   // day -> { stamp, passages: [{ lo, hi, text, vector }] }
  }

  // A page whose stamp is unchanged is skipped; every new passage is embedded in one batch.
  async ingest(pages) {
    const pending = [];
    for (const page of pages) {
      const stamp = page.stamp || '';
      const existing = this.byDay.get(page.day);
      if (existing && existing.stamp === stamp) continue;
      const passages = chunk(page.body || '').map((p) => ({ lo: p.lo, hi: p.hi, text: p.text, vector: null }));
      this.byDay.set(page.day, { stamp, passages });
      for (const passage of passages) pending.push(passage);
    }
    if (pending.length === 0) return;
    const vectors = await this.embedder.embedAll(pending.map((p) => p.text));
    pending.forEach((passage, i) => { passage.vector = vectors[i]; });
  }

  get size() {
    let total = 0;
    for (const { passages } of this.byDay.values()) total += passages.length;
    return total;
  }

  // Embedded by the same embedder as the passages: one position per day, its best passage's [lo, hi]
  // span, best first.
  async query(text, { limit = 8, floor = this.embedder.floor } = {}) {
    const q = await this.embedder.embedQuery(text);
    const queryWords = new Set(contentWords(text));
    const hits = [];
    for (const [day, { passages }] of this.byDay) {
      const ready = passages.filter((p) => p.vector);
      const best = topK(ready, (p) => cosine(q, p.vector), 1, floor)[0];
      if (!best) continue;
      hits.push({
        day, lo: best.item.lo, hi: best.item.hi, text: best.item.text,
        score: best.score, why: reason(best.item.text, queryWords),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// The content word the passage and the query share, else the passage's own strongest word. One token,
// never a phrase, and lexical even under the neural embedder.
function reason(passageText, queryWords) {
  const passageWords = contentWords(passageText);
  const shared = passageWords.find((w) => queryWords.has(w));
  const anchor = shared || passageWords.find((w) => w.length > 4) || passageWords[0] || '';
  return anchor ? `close to · ${anchor}` : 'close to what you wrote';
}
