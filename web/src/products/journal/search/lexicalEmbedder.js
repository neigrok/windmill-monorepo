import { features } from './tokenize.js';

export const DIM = 256;

// The model-free fallback carries its own similarity floor.
export class LexicalEmbedder {
  floor = 0.12;

  async embedAll(texts) {
    return texts.map(embed);
  }

  // HyDE-lite: average the query with a small hypothetical expansion. The lexical embedder's alone.
  async embedQuery(text) {
    const plain = embed(text);
    const hypothetical = embed(`${text}. i felt ${text}. today was about ${text}.`);
    const out = new Float32Array(plain.length);
    for (let i = 0; i < out.length; i++) out[i] = plain[i] * 0.7 + hypothetical[i] * 0.3;
    return out;
  }
}

// FNV-1a, folded to a bucket plus a sign so features can cancel as well as add.
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
