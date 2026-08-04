// The neural embedder's engine room, off the main thread. It loads a small sentence-embedding model
// (bge-small-en-v1.5, int8) once and turns batches of text into 384-dim unit vectors. The model is
// served from our own origin (env below), so building the index and running a query never send a byte
// about the writer anywhere.
//
// KNOWN GAP, and the sentence above is narrower than it looks. No writer data leaves — but the
// WASM RUNTIME does not come from our origin. `env.backends.onnx.wasm.wasmPaths` is left at its
// default, which is a jsdelivr CDN URL, so onnxruntime-web fetches its .wasm from a third party at
// first use. Proven by blocking DNS: "no available backend found. ERR: [wasm] Failed to fetch
// dynamically imported module: https://cdn.jsdelivr.net/npm/@huggingface/transformers@.../
// ort-wasm-simd-threaded.jsep.mjs". If jsdelivr is unreachable the neural index silently never
// builds and search falls back to lexical with no visible failure. Closing it: copy the two ORT
// wasm files into public/ and set `env.backends.onnx.wasm.wasmPaths` beside the lines below.
//
// Runs on wasm (CPU), deliberately not WebGPU: onnxruntime-web's WebGPU path miscomputes this
// quantized model — it returns plausible but wrong embeddings that collapse the ranking (verified
// in-browser: unrelated lines outscored real matches under WebGPU, matched node exactly under wasm).
// A 33MB int8 model on wasm loads in a few hundred ms and embeds a diary in well under a second, so
// there's nothing to gain and correctness to lose. WebGPU only pays off with an fp16/fp32 model 4× the
// download — a trade to revisit if inference ever feels slow, never at the cost of a wrong result.
//
// Protocol: the main thread posts { id, kind: 'passages' | 'query', texts }, and gets back
// { id, ok, vectors } or { id, ok: false, error }. A one-time { ready } / { failed } announces whether
// the model came up at all, so the client can stay on the instant lexical embedder if it didn't.

import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;            // load from our origin — off by default in the browser build
env.allowRemoteModels = false;          // the promise, enforced: never reach a third-party host for the model
env.localModelPath = '/models/';        // served same-origin from dist/ (public/models/)
env.backends.onnx.wasm.numThreads = 1;  // single-threaded wasm needs no SharedArrayBuffer / COOP-COEP headers

const MODEL = 'Xenova/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const extractorPromise = pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  .then((extractor) => { self.postMessage({ ready: true }); return extractor; })
  .catch((error) => { self.postMessage({ failed: true, error: String(error) }); throw error; });

self.onmessage = async (event) => {
  const { id, kind, texts } = event.data;
  try {
    const extractor = await extractorPromise;
    const input = kind === 'query' ? texts.map((t) => QUERY_PREFIX + t) : texts;
    const output = await extractor(input, { pooling: 'mean', normalize: true });
    const [rows, dim] = output.dims;
    const flat = output.data;
    const vectors = [];
    for (let row = 0; row < rows; row++) vectors.push(flat.slice(row * dim, (row + 1) * dim));
    self.postMessage({ id, ok: true, vectors });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error) });
  }
};
