// Off the main thread: bge-small-en-v1.5 int8, loaded once, turning batches of text into 384-dim unit
// vectors. The model is served from our own origin, so no writer data leaves the device.
// Runs on wasm (CPU), never WebGPU: onnxruntime-web's WebGPU path miscomputes this quantized model.
// Protocol: the main thread posts { id, kind: 'passages' | 'query', texts } and gets back
// { id, ok, vectors } or { id, ok: false, error }; a one-time { ready } / { failed } says whether the
// model came up at all.
//
// TODO: `env.backends.onnx.wasm.wasmPaths` is left at its default jsdelivr CDN URL, so onnxruntime-web
// fetches its .wasm from a third party at first use. To close it, copy the ORT wasm files into public/
// and set `wasmPaths` beside the env lines below.

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
