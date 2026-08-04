// The sidecar as the C++ backend sees it: a process, a port, and two doors. Spawns server.js on a
// scratch port and drives it — warmup, dimensions, determinism, batch independence, and every way a
// caller can hand it something absurd.
//
// The batch-independence case is the one that protects the feature. The server embeds a page's
// passages together and the browser embeds a query alone; if a vector depended on what it was
// batched with, the two would live in slightly different spaces and nothing would ever say so.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { embedPassages, loadExtractor } from '../embedder.js';

const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

const embed = (passages) =>
  fetch(`${BASE}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passages }),
  });

const server = spawn('node', ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  // The port opens in the same tick the model starts loading, so the first answer this door ever
  // gives is a warming one — provided we ask the instant it opens. Retry with no delay; a sleep here
  // is how this assertion turns flaky.
  let warming = null;
  for (let attempt = 0; attempt < 4000 && !warming; attempt++) {
    warming = await fetch(`${BASE}/health`).catch(() => null);
  }
  assert.ok(warming, 'the server never opened its port');
  const warmingBody = await warming.json();
  assert.equal(warming.status, 503, 'health must refuse readiness while the weights are still loading');
  assert.equal(warmingBody.status, 'loading');
  assert.equal(warmingBody.version, fixture.version, 'the version is knowable before the model is');
  console.log('health during warmup: 503 loading — honest');

  // A request that arrives mid-warmup waits for the model rather than failing; the backend's timeout
  // is sized for exactly this.
  const first = await embed(fixture.passages);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.version, fixture.version);
  assert.equal(firstBody.vectors.length, fixture.passages.length);
  for (const vector of firstBody.vectors) assert.equal(vector.length, 384);
  console.log(`embed during warmup: 200, ${firstBody.vectors.length} vectors of 384`);

  const ready = await fetch(`${BASE}/health`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, 'ready');
  console.log('health after the model is up: 200 ready');

  // JSON must carry float32 back unchanged, or every vector in the database is a rounded copy of the
  // one the browser holds. Compared against this machine's own embedder rather than the committed
  // fixture, so the assertion is about the wire and nothing else — the fixture is bound to the
  // platform that generated it, the wire is not.
  const local = await embedPassages(await loadExtractor(), fixture.passages);
  assert.deepEqual(firstBody.vectors, local, 'HTTP must not perturb a single component');
  console.log('wire response is bit-equal to this machine’s own vectors');

  const again = await embed(fixture.passages);
  assert.deepEqual((await again.json()).vectors, firstBody.vectors, 'identical input must give identical vectors');
  console.log('two identical requests: identical vectors');

  // A passage's vector is NOT independent of what it was batched with, and no configuration makes it
  // so: the q8 model quantizes activations dynamically, computing one scale from the whole padded
  // batch tensor, so every co-batched sentence nudges every other. Measured at cos 0.995–0.998 —
  // small next to a corpus whose genuine pair similarities run 0.3–0.9, and a property the browser's
  // own index already has (it embeds passages 32 at a time and queries alone). So this asserts the
  // bound rather than an identity that was never true; a regression past it means something changed
  // about the model, not about the batch.
  let closest = 1;
  for (const [row, passage] of fixture.passages.entries()) {
    const alone = (await (await embed([passage])).json()).vectors[0];
    const batched = firstBody.vectors[row];
    closest = Math.min(closest, alone.reduce((total, value, i) => total + value * batched[i], 0));
  }
  assert.ok(closest > 0.99, `batching moved a passage too far: cos ${closest}`);
  console.log(`batch of five vs five batches of one: worst cosine ${closest.toFixed(6)}`);

  const refusals = [
    ['empty batch', { passages: [] }, 400],
    ['not an array', { passages: 'hello' }, 400],
    ['not strings', { passages: [1, 2] }, 400],
    ['too many passages', { passages: Array(513).fill('x') }, 400],
    ['no passages field', {}, 400],
  ];
  for (const [name, body, expected] of refusals) {
    const response = await fetch(`${BASE}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, expected, `${name} should be ${expected}`);
  }
  const malformed = await fetch(`${BASE}/embed`, { method: 'POST', body: 'not json' });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  console.log('refusals: empty, non-array, non-string, oversized batch, malformed JSON, unknown path');

  // 3MB of passages against a 2MB cap. Either answer is correct — a 413 or a hang-up — as long as
  // the process is still standing afterwards, which is the property that actually matters.
  const flood = await embed([Array(3_000_000).fill('a').join('')]).catch((error) => ({ status: `hung up (${error.cause?.code || error.message})` }));
  console.log(`3MB body: ${flood.status}`);
  const alive = await fetch(`${BASE}/health`);
  assert.equal(alive.status, 200, 'the server must survive an oversized body');
  console.log('still serving after the oversized body');

  console.log('\nOK');
} finally {
  // SIGKILL: onnxruntime-node aborts noisily in its own teardown, and a red herring in the last line
  // of a passing check is worth avoiding.
  server.kill('SIGKILL');
}
