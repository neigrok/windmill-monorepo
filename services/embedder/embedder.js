// The model, configured once. Every value in this file must equal the browser's
// (web/src/products/journal/search/neural/embedder.worker.js), because the vectors this process
// computes and the vectors that worker computes are compared to each other: the server embeds a
// journal passage for echoes, the browser embeds the same prose for on-device search, and one index
// is seeded from the other. A divergence here raises no error anywhere — it just makes retrieval
// quietly worse forever. That is the whole reason this sidecar exists instead of an ONNX call from
// C++: identity with the browser is held by running the same library over the same files, not by
// reimplementing mean pooling and L2 normalisation in another language and hoping.
//
// The browser prefixes QUERIES ("Represent this sentence for searching relevant passages: ") and
// leaves PASSAGES bare. This sidecar embeds passages only, so nothing is prefixed here — adding a
// prefix would put the server's vectors in a different corner of the space than the browser's.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@huggingface/transformers';

export const MODEL = 'Xenova/bge-small-en-v1.5';
export const DTYPE = 'q8';
export const DIM = 384;

// Stamped on every span row the sweep writes, so retrieval can refuse to compare across versions:
// cosine between two embedding spaces is not degraded, it is meaningless, and nothing about it looks
// like an error. Change any of the four facts it names and this string changes with them.
export const VERSION = 'bge-small-en-v1.5.q8.mean.l2';

// The default is the model the web app serves. In the container this is a read-only mount of the
// built site's own models/ directory — same bytes the browser downloads, not a copy of them.
export const modelRoot = () =>
  process.env.MODEL_DIR || fileURLToPath(new URL('../../web/public/models', import.meta.url));

// Where dtype q8 resolves to on disk — the one file whose absence must be a loud startup failure
// rather than a fallback to something else.
export const weightsPath = () => path.join(modelRoot(), MODEL, 'onnx', 'model_quantized.onnx');

export async function loadExtractor() {
  // allowLocalModels defaults differently per runtime (false in the browser build, true in node), so
  // both flags are set explicitly: read from disk, and never reach the Hugging Face hub — a silent
  // remote fetch would serve a model nobody in this repo has ever seen.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = modelRoot();

  if (!fs.existsSync(weightsPath())) throw new Error(`no model weights at ${weightsPath()}`);
  return pipeline('feature-extraction', MODEL, { dtype: DTYPE });
}

// One forward pass for the whole batch. Note what that costs: a passage's vector is NOT independent
// of what it was batched with. The q8 model quantizes activations dynamically, deriving one scale
// from the whole padded batch tensor, so co-batched sentences nudge each other — measured at cos
// 0.995–0.998 against the same passage embedded alone (check/server.mjs pins that bound).
//
// Batching anyway, deliberately. The browser does the same thing (32 passages per round trip), so
// its index carries the identical wobble; it is small next to a corpus whose real pair similarities
// run 0.3–0.9; and the alternative costs 2–3× for vectors that are no closer to the browser's.
export async function embedPassages(extractor, passages) {
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
