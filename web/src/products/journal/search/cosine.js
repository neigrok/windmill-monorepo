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
