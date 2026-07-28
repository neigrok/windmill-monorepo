// The searchable corpus: every page's passages, each embedded on the device. Built from the delta
// feed and re-embedded only when a page's stamp changes. In-memory — journal-scale corpora are small
// (a decade of daily writing is a few thousand passages, which cosine in well under a frame), so the
// vectors and the query never touch the network, which is the whole promise. A neural embedder drops
// in behind embed() (embed.js) for true meaning-search without changing anything here.

import { embed } from './embed.js';
import { chunk } from './chunk.js';
import { cosine, topK } from './cosine.js';
import { contentWords } from './tokenize.js';

export class SearchIndex {
  constructor() {
    this.byDay = new Map();   // day -> { stamp, passages: [{ lo, hi, text, vector }] }
  }

  // Add or refresh pages. A page whose stamp is unchanged is already indexed and skipped.
  ingest(pages) {
    for (const page of pages) {
      const stamp = page.stamp || '';
      const existing = this.byDay.get(page.day);
      if (existing && existing.stamp === stamp) continue;
      const passages = chunk(page.body || '').map((p) => ({
        lo: p.lo, hi: p.hi, text: p.text, vector: embed(p.text),
      }));
      this.byDay.set(page.day, { stamp, passages });
    }
  }

  get size() {
    let total = 0;
    for (const { passages } of this.byDay.values()) total += passages.length;
    return total;
  }

  // Search a feeling. The query is embedded with a light hypothetical-answer expansion so it leans
  // toward the answer, not just the words typed; then cosine over every passage, one POSITION per day
  // (its best passage's [lo, hi] span), best first — each carrying an honest "why" naming a real
  // overlap, never an interpretation.
  query(text, { limit = 8, floor = 0.12 } = {}) {
    const q = queryVector(text);
    const queryWords = new Set(contentWords(text));
    const hits = [];
    for (const [day, { passages }] of this.byDay) {
      const best = topK(passages, (p) => cosine(q, p.vector), 1, floor)[0];
      if (!best) continue;
      hits.push({
        day, lo: best.item.lo, hi: best.item.hi, text: best.item.text,
        score: best.score, why: reason(best.item.text, queryWords),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// HyDE-lite: average the query with a tiny hypothetical expansion so a feeling reaches the passage
// that circled the same thing in other words.
function queryVector(text) {
  const plain = embed(text);
  const hypothetical = embed(`${text}. i felt ${text}. today was about ${text}.`);
  const out = new Float32Array(plain.length);
  for (let i = 0; i < out.length; i++) out[i] = plain[i] * 0.7 + hypothetical[i] * 0.3;
  return out;
}

// The content word the passage and the query share, else the passage's own strongest word —
// "close to · dread about the review". A real, countable overlap; it never interprets.
function reason(passageText, queryWords) {
  const passageWords = contentWords(passageText);
  const shared = passageWords.find((w) => queryWords.has(w));
  const anchor = shared || passageWords.find((w) => w.length > 4) || passageWords[0] || '';
  return anchor ? `close to · ${anchor}` : 'close to what you wrote';
}
