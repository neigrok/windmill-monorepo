// Browser parity: the claim this whole sidecar exists to make, measured instead of asserted.
//
// The same five sentences go through the *shipped* worker — web/src/products/journal/search/neural/
// embedder.worker.js, served verbatim, its own env configuration, real onnxruntime-web on wasm, in
// real headless Chrome — and the vectors are compared against what this machine's sidecar produces
// for the same batch. If those two agree, a passage embedded on the server and the same passage
// embedded on the phone are the same point in the same space, and echoes retrieved server-side mean
// what on-device search means.
//
// Compared against this machine's own vectors, not against check/fixture.json: the fixture is bound
// to the platform that generated it (onnxruntime-node's macOS and Linux builds differ), while this
// check is asking a question about two runtimes here and now.
//
// Two deliberate differences from the page a reader loads, neither numeric:
//   · the worker module is imported into the page realm rather than started as a Worker (a module
//     worker gets no import map, and rewriting the import would stop this being the shipped file);
//   · onnxruntime's wasm is served from node_modules rather than fetched from jsdelivr, which is
//     where transformers.js points by default. Same version, same bytes, no third party in the loop.
//
// Run: node check/browser.mjs   (needs Chrome installed; nothing else)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedPassages, loadExtractor } from '../embedder.js';

const PORT = 8198;
const web = fileURLToPath(new URL('../../../web/', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => fs.existsSync(candidate));
assert.ok(CHROME, 'no Chrome found — this check needs a real browser, which is the entire point of it');

// The page mounts the shipped worker as a module and speaks its protocol: { id, kind, texts } in,
// { id, ok, vectors } out. Nothing here configures the model — the worker does, exactly as it does
// for a reader — beyond pointing the wasm at this origin.
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

const passages = ${JSON.stringify(fixture.passages)};

// The worker speaks through self.postMessage / self.onmessage. In a document both belong to the
// window, so a message posted out arrives straight back at the same handler and the worker answers
// its own replies forever. Standing in for the Worker port with a direct call in each direction
// breaks that loop and leaves the worker file itself untouched, which is the whole point.
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
console.log(`serving the shipped worker and the committed model files on ${PORT}`);

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
  const sidecar = await embedPassages(await loadExtractor(), fixture.passages);

  let worstCos = 1;
  let worstDelta = 0;
  answer.vectors.forEach((vector, row) => {
    const expected = sidecar[row];
    assert.equal(vector.length, expected.length, `row ${row} came back with the wrong dimension`);
    worstCos = Math.min(worstCos, cosine(vector, expected));
    vector.forEach((value, i) => (worstDelta = Math.max(worstDelta, Math.abs(value - expected[i]))));
  });

  // Two float32 unit vectors dot to about 0.9999995 against themselves, not 1 — that is the ceiling
  // these numbers are read against, not a suspiciously imperfect score.
  console.log(`\nbrowser (onnxruntime-web, wasm) vs sidecar (onnxruntime-node, ${process.platform}/${process.arch}), same batch of ${answer.vectors.length}:`);
  console.log(`  worst cosine        ${worstCos.toFixed(9)}   (self-dot ceiling ${cosine(sidecar[0], sidecar[0]).toFixed(9)})`);
  console.log(`  worst component |Δ| ${worstDelta.toExponential(3)}`);

  // The two runtimes are different builds of ONNX Runtime on different instruction sets, so bit
  // equality is not the bar and never was. The bar is that the difference is invisible next to the
  // signal: an echo corpus's genuine pair similarities run 0.3–0.9, and retrieval thresholds sit at
  // 0.80 / 0.85 / 0.97. Anything at 0.9999 is three orders of magnitude below the nearest decision.
  if (worstCos < 0.9999) {
    console.error('FAIL: the sidecar and the browser are not embedding into the same space');
    process.exitCode = 1;
  } else {
    console.log('\nOK — the server and the browser agree');
  }
}
