// Spawns server.js on a scratch port and drives it as the C++ backend does.

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
  // The port opens in the same tick the model starts loading, so retry with no delay: a sleep here
  // makes this assertion flaky.
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

  // Compared against this machine's own embedder, not the committed fixture, so the assertion is
  // about the wire alone.
  const local = await embedPassages(await loadExtractor(), fixture.passages);
  assert.deepEqual(firstBody.vectors, local, 'HTTP must not perturb a single component');
  console.log('wire response is bit-equal to this machine’s own vectors');

  const again = await embed(fixture.passages);
  assert.deepEqual((await again.json()).vectors, firstBody.vectors, 'identical input must give identical vectors');
  console.log('two identical requests: identical vectors');

  // A passage's vector is not independent of what it was batched with, so this asserts a bound
  // rather than an identity.
  let closest = 1;
  for (const [row, passage] of fixture.passages.entries()) {
    const alone = (await (await embed([passage])).json()).vectors[0];
    const batched = firstBody.vectors[row];
    closest = Math.min(closest, alone.reduce((total, value, i) => total + value * batched[i], 0));
  }
  // 0.9918 here on darwin/arm64: the floor sits below that with room for another ORT build, and far
  // below the nearest retrieval threshold (0.80).
  assert.ok(closest > 0.98, `batching moved a passage too far: cos ${closest}`);
  console.log(`one batch of ${fixture.passages.length} vs ${fixture.passages.length} batches of one: worst cosine ${closest.toFixed(6)}`);

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

  // The one refusal no character or passage count can stand in for: a passage the model would read
  // only the first 512 pieces of. It must take the whole batch down — a truncated vector comes back
  // unit-length and 384-dimensional, and nothing downstream could ever tell. The complaint names an
  // index and a count and never a byte of the passage.
  const overLength = Array(60).fill('Сегодня опять весь день ушёл на рефактор, который никому не нужен.').join(' ');
  assert.ok(overLength.length < 20_000, 'this passage must be refused for its pieces, not its characters');
  const truncating = await embed(['tired again today', overLength]);
  assert.equal(truncating.status, 400, 'an over-length passage must be refused, never silently truncated');
  const complaint = (await truncating.json()).error;
  assert.match(complaint, /^passage 1 is \d+ tokenizer pieces, over the 512 this model reads$/, complaint);
  console.log(`over-length passage: 400 — ${complaint}`);

  // 3MB against a 2MB cap: either a 413 or a hang-up is correct, as long as the process survives.
  const flood = await embed([Array(3_000_000).fill('a').join('')]).catch((error) => ({ status: `hung up (${error.cause?.code || error.message})` }));
  console.log(`3MB body: ${flood.status}`);
  const alive = await fetch(`${BASE}/health`);
  assert.equal(alive.status, 200, 'the server must survive an oversized body');
  console.log('still serving after the oversized body');

  console.log('\nOK');
} finally {
  // SIGKILL: onnxruntime-node aborts noisily in its own teardown.
  server.kill('SIGKILL');
}
