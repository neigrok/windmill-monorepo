// The searchable corpus: every page's passages, each embedded on the device. Built from the delta
// feed and re-embedded only when a page's stamp changes. In-memory — journal-scale corpora are small
// (a decade of daily writing is a few thousand passages, which cosine in well under a frame), so the
// vectors and the query never touch the network, which is the whole promise.
//
// The index is embedder-agnostic: it chunks pages into passages and ranks them by cosine, but the
// vectors come from whatever Embedder it was built with — the instant lexical hash or the neural model
// (embedders.js). Building a second index with a different embedder and swapping it in is how search
// sharpens from vocabulary-match to meaning-match without this file changing at all.

import { chunk } from './chunk.js';
import { cosine, topK } from './cosine.js';
import { contentWords } from './tokenize.js';

export class SearchIndex {
  constructor(embedder) {
    this.embedder = embedder;
    this.byDay = new Map();   // day -> { stamp, passages: [{ lo, hi, text, vector }] }
  }

  // Add or refresh pages. A page whose stamp is unchanged is already indexed and skipped; every new
  // passage across all changed pages is embedded in one batch, which is what makes the neural embedder
  // (one worker round-trip, one model call) affordable.
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

  // Search a feeling. The query is embedded by the same embedder as the passages, then cosine over
  // every passage, one POSITION per day (its best passage's [lo, hi] span), best first — each carrying
  // an honest "why" naming a real word overlap, never an interpretation.
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

// The content word the passage and the query share, else the passage's own strongest word —
// "close to · dread about the review". A real, countable overlap; it never interprets. Stays a lexical
// signal even under the neural embedder: the score is the meaning, the why is the honest anchor.
function reason(passageText, queryWords) {
  const passageWords = contentWords(passageText);
  const shared = passageWords.find((w) => queryWords.has(w));
  const anchor = shared || passageWords.find((w) => w.length > 4) || passageWords[0] || '';
  return anchor ? `close to · ${anchor}` : 'close to what you wrote';
}
