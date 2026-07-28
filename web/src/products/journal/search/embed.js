// The on-device embedder: a passage becomes a fixed-dimension unit vector by hashing each of its
// features (words + trigrams) into the vector and L2-normalizing. No model download, no network, no
// dependency — instant, private, offline, and deterministic (a test can pin it exactly). It matches
// on shared vocabulary and morphology, which is already well past keyword: two passages that circle
// the same thing in different words land close. The interface — embed(text) -> Float32Array(DIM) —
// is the seam a neural model (transformers.js / WebGPU) drops behind for true meaning-search, the
// production upgrade the canon calls for (§8.2); nothing else in the search path would move.

import { features } from './tokenize.js';

export const DIM = 256;

// A small stable string hash (FNV-1a), folded to a bucket + a sign so features can cancel as well as
// add — a cheap approximation of a learned projection.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text) {
  const vector = new Float32Array(DIM);
  for (const [feature, weight] of features(text)) {
    const h = hash(feature);
    const bucket = h % DIM;
    const sign = (h & 0x100) ? -1 : 1;
    vector[bucket] += sign * weight;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) vector[i] /= norm;
  }
  return vector;
}
