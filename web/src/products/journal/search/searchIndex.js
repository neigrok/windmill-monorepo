import { contentWords } from './tokenize.js';

// Passage vectors stay on the device and are rebuilt only when a page stamp changes.
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

// Every passage keeps its exact half-open [lo, hi) span into the page body.
export function chunk(body) {
  const passages = [];
  let start = 0;

  const flush = (end) => {
    let lo = start;
    let hi = end;
    while (lo < hi && /\s/.test(body[lo])) lo++;
    while (hi > lo && /\s/.test(body[hi - 1])) hi--;
    const text = body.slice(lo, hi);
    if (text.length >= 2) passages.push({ text, lo, hi });
    start = end;
  };

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n') flush(i + 1);
  }
  if (start < body.length) flush(body.length);
  return passages;
}

// Cosine similarity with a zero-norm guard, so it holds for any input, not only unit vectors.

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// The best k of `items` by `scoreOf`, highest first, dropping anything not above `floor`.
export function topK(items, scoreOf, k, floor = 0) {
  return items
    .map((item) => ({ item, score: scoreOf(item) }))
    .filter((scored) => scored.score > floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
