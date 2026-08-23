// Runtime parity for the shipped worker (web/src/products/journal/search/neural/embedder.worker.js):
// onnxruntime-web in real headless Chrome against onnxruntime-node here, one model, same batch.
// It is the BROWSER's model on both sides — the sidecar runs a different one on purpose
// (../embedder.js), so these two halves no longer share a space and check/fixture.json, which is
// the sidecar's, is no longer this check's corpus either. Compared against this machine's own
// vectors rather than anything committed, which would be bound to its build platform.
// Needs Chrome installed; nothing else.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@huggingface/transformers';

import { embedPassages } from '../embedder.js';

const PORT = 8198;
const web = fileURLToPath(new URL('../../../web/', import.meta.url));

// Whatever the worker names, byte for byte, or this check proves nothing about the worker.
const BROWSER_MODEL = 'Xenova/bge-small-en-v1.5';

// English on purpose: this is the model the browser ships, and the index it builds is English. A
// Cyrillic line in this batch drops the two runtimes to 0.9974 cosine — bge spends 0.88 pieces per
// Russian character, and q8 scales the whole padded batch off activations that long row dominates.
// Harmless where it lands (the browser embeds its queries and its passages in the same runtime) but
// it would make this check about ORT builds instead of about the worker.
const PASSAGES = [
  'i want to learn c++.',
  'i like c++.',
  'tired again today',
  'Told Marta I’d stop drinking — meant it this time.',
  'The rain didn’t stop. I walked to the river anyway and sat on the cold bench until my hands went numb.',
];

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => fs.existsSync(candidate));
assert.ok(CHROME, 'no Chrome found — this check needs a real browser, which is the entire point of it');

// The worker's protocol: { id, kind, texts } in, { id, ok, vectors } out.
const HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>windmill embedder parity</title>
<script type="importmap">
{"imports": {
  "@huggingface/transformers": "/vendor/tf/transformers.web.js",
  "onnxruntime-web": "/vendor/ort/ort.bundle.min.mjs",
  "onnxruntime-common": "/vendor/ort-common/index.js"
}}
</script>
<script type="module">
const report = (payload) => fetch('/result', { method: 'POST', body: JSON.stringify(payload) });
window.addEventListener('error', (e) => report({ error: String(e.message) }));
window.addEventListener('unhandledrejection', (e) => report({ error: String(e.reason) }));

const passages = ${JSON.stringify(PASSAGES)};

// The worker speaks through self.postMessage / self.onmessage; in a document both belong to the
// window, so an unstubbed postMessage loops the worker's replies back into its own handler.
window.postMessage = (data) => {
  if (data.ready) return window.onmessage({ data: { id: 1, kind: 'passages', texts: passages } });
  if (data.failed) return report({ error: 'worker failed: ' + data.error });
  if (data.ok) return report({ vectors: data.vectors.map((v) => Array.from(v)) });
  return report({ error: data.error });
};

try {
  const { env } = await import('@huggingface/transformers');
  env.backends.onnx.wasm.wasmPaths = '/vendor/tf/';
  await import('/worker.js');
} catch (error) {
  report({ error: String(error) });
}
</script>
`;

const MOUNTS = [
  ['/models/', path.join(web, 'public/models/')],
  ['/vendor/tf/', path.join(web, 'node_modules/@huggingface/transformers/dist/')],
  ['/vendor/ort/', path.join(web, 'node_modules/onnxruntime-web/dist/')],
  ['/vendor/ort-common/', path.join(web, 'node_modules/onnxruntime-common/dist/esm/')],
];
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
};

let settle;
const result = new Promise((resolve) => (settle = resolve));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && url === '/result') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(204).end();
      settle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
    return;
  }
  if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(HARNESS);
  if (url === '/worker.js') {
    const worker = path.join(web, 'src/products/journal/search/neural/embedder.worker.js');
    return res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(worker));
  }

  const mount = MOUNTS.find(([prefix]) => url.startsWith(prefix));
  if (!mount) return res.writeHead(404).end();
  const file = path.join(mount[1], url.slice(mount[0].length));
  if (!file.startsWith(mount[1]) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`serving the shipped worker and the fetched model files on ${PORT}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'windmill-parity-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${PORT}/`,
], { stdio: ['ignore', 'ignore', 'ignore'] });

const timeout = setTimeout(() => settle({ error: 'the browser did not answer within 120s' }), 120_000);
const answer = await result;
clearTimeout(timeout);
chrome.kill('SIGKILL');
server.close();
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

if (answer.error) {
  console.error(`FAIL: ${answer.error}`);
  process.exitCode = 1;
} else {
  const cosine = (a, b) => a.reduce((total, value, i) => total + value * b[i], 0);
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.join(web, 'public/models');
  const extractor = await pipeline('feature-extraction', BROWSER_MODEL, { dtype: 'q8' });
  const here = await embedPassages(extractor, PASSAGES);

  let worstCos = 1;
  let worstDelta = 0;
  answer.vectors.forEach((vector, row) => {
    const expected = here[row];
    assert.equal(vector.length, expected.length, `row ${row} came back with the wrong dimension`);
    worstCos = Math.min(worstCos, cosine(vector, expected));
    vector.forEach((value, i) => (worstDelta = Math.max(worstDelta, Math.abs(value - expected[i]))));
  });

  // A float32 unit vector dots to about 0.9999995 against itself, not 1: that is the ceiling here.
  console.log(`\n${BROWSER_MODEL}: browser (onnxruntime-web, wasm) vs node (onnxruntime-node, ${process.platform}/${process.arch}), same batch of ${answer.vectors.length}:`);
  console.log(`  worst cosine        ${worstCos.toFixed(9)}   (self-dot ceiling ${cosine(here[0], here[0]).toFixed(9)})`);
  console.log(`  worst component |Δ| ${worstDelta.toExponential(3)}`);

  // Different ONNX Runtime builds, so the bar is a cosine floor far below the nearest retrieval
  // threshold (0.80 / 0.85 / 0.97), not bit equality.
  if (worstCos < 0.9999) {
    console.error('FAIL: the shipped worker does not reproduce this model in a real browser');
    process.exitCode = 1;
  } else {
    console.log('\nOK — the worker embeds in Chrome what it embeds here');
  }
}
