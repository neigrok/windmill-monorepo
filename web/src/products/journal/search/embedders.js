// An Embedder turns text into unit vectors the index ranks by cosine. `floor` rides with the embedder:
// the cosine below which a match is "nothing close" depends on that embedder's score distribution. The
// lexical one needs no model and stays the fallback while the neural model loads.

import { embed } from './embed.js';

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
