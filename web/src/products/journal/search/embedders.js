// An Embedder turns text into unit vectors the index ranks by cosine. Two entry points, because a
// corpus is embedded in bulk while a query is often framed differently (an expansion, a retrieval
// prefix). `floor` rides with the embedder: the cosine below which a match is "nothing close" depends
// on the embedder's score distribution — the lexical hash and the neural model live on different scales.
//
// The lexical embedder is the instant one: pure, synchronous under the hood, no model, no network. It
// answers ⌘K the moment search opens and stays the fallback while the neural model loads. The neural
// embedder (neural/neuralEmbedder.js) is the same shape over a Web Worker, and swaps in behind it.

import { embed } from './embed.js';

export class LexicalEmbedder {
  floor = 0.12;

  async embedAll(texts) {
    return texts.map(embed);
  }

  // HyDE-lite: average the query with a tiny hypothetical expansion so a feeling reaches the passage
  // that circled the same thing in other words. Neural models don't need the crutch — they overlap
  // meaning directly — so this expansion is the lexical embedder's alone.
  async embedQuery(text) {
    const plain = embed(text);
    const hypothetical = embed(`${text}. i felt ${text}. today was about ${text}.`);
    const out = new Float32Array(plain.length);
    for (let i = 0; i < out.length; i++) out[i] = plain[i] * 0.7 + hypothetical[i] * 0.3;
    return out;
  }
}
