// This sidecar and the browser deliberately run different models. Nothing serves a vector across
// that line — the browser embeds page bodies on-device into an index of its own, and these vectors
// never leave the server — so each side owes only its own consistency. Here that buys Russian, which
// bge-small-en-v1.5 tokenizes near character level and then ranks by word-sharing; there it spares a
// phone a 135MB download of multilingual weights it would gain nothing from.
// This model is symmetric: passages and queries are embedded the same way, neither with a prefix.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@huggingface/transformers';

export const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const DTYPE = 'q8';
export const DIM = 384;

// Stamped on every span row the sweep writes so retrieval refuses to compare across versions;
// change any of the four facts it names and this string changes with them.
export const VERSION = 'paraphrase-multilingual-MiniLM-L12-v2.q8.mean.l2';

// The positions this model reads: config.json max_position_embeddings, which the tokenizer's own
// model_max_length agrees with. (The 128 in sentence_bert_config.json is not a file transformers.js
// reads.) Everything past it is dropped, not condensed.
export const MAX_PIECES = 512;

export const modelRoot = () =>
  process.env.MODEL_DIR || fileURLToPath(new URL('../../web/public/models', import.meta.url));

export const weightsPath = () => path.join(modelRoot(), MODEL, 'onnx', 'model_quantized.onnx');

export async function loadExtractor() {
  // allowLocalModels defaults differently per runtime, so both flags are set explicitly.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = modelRoot();

  if (!fs.existsSync(weightsPath())) throw new Error(`no model weights at ${weightsPath()}`);
  return pipeline('feature-extraction', MODEL, { dtype: DTYPE });
}

// A passage's vector is not independent of what it was batched with: q8 derives one activation
// scale from the whole padded batch tensor.
export async function embedPassages(extractor, passages) {
  // The pipeline truncates past MAX_PIECES without a word: a 962-piece passage comes back a unit
  // vector of the right width sitting 0.985 from its own first-512-piece prefix, which is to say it
  // stands for the opening and drops the rest. No error, no short row, nothing any caller can see.
  // So the batch dies here instead — EchoSweep reads a failed call as transport and leaves the page
  // for the next sweep, and has no way at all to read a vector that quietly means less than it says.
  const pieces = passages.map((passage) => extractor.tokenizer.encode(passage).length);
  const over = pieces.findIndex((count) => count > MAX_PIECES);
  if (over !== -1) {
    const detail = `passage ${over} is ${pieces[over]} tokenizer pieces, over the ${MAX_PIECES} this model reads`;
    throw Object.assign(new Error(detail), { status: 400 });
  }

  const output = await extractor(passages, { pooling: 'mean', normalize: true });
  const [rows, dim] = output.dims;
  if (rows !== passages.length) throw new Error(`expected ${passages.length} rows, got ${rows}`);
  if (dim !== DIM) throw new Error(`expected ${DIM} dims, got ${dim}`);

  const vectors = [];
  for (let row = 0; row < rows; row++) {
    vectors.push(Array.from(output.data.slice(row * dim, (row + 1) * dim)));
  }
  return vectors;
}
