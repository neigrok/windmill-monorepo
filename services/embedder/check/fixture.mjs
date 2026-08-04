// The pinned corpus. Five sentences go through the sidecar's own embedding path and are compared
// against the vectors committed in fixture.json — component by component, not by eye.
//
// Run it after any dependency bump: `node check/fixture.mjs`. A drift means the vectors this service
// writes tonight are not the vectors it wrote last night, and every span row already in the database
// was computed in the old space. That is exactly the failure the version stamp exists to catch, and
// exactly the failure nobody notices without a fixture, because bad vectors are still vectors.
//
// Two bars, because there are two different claims to make. On the platform the fixture was built
// on, the demand is bit equality: same weights, same library, same machine, so anything else is a
// change somebody made. Off it, the demand is a cosine floor: onnxruntime-node's macOS and Linux
// builds do not agree to the bit, and measured across arm64 they sit at cos 0.9972 — a real
// difference, smaller than the wobble batching already introduces (0.9956), and far below the
// nearest retrieval threshold. Demanding bit equality everywhere would be demanding something that
// was never true and calling the truth a failure.
//
// `--write` regenerates. Only ever do that deliberately, alongside a new VERSION string.

import crypto from 'node:crypto';
import fs from 'node:fs';

import { DIM, DTYPE, MODEL, VERSION, embedPassages, loadExtractor, weightsPath } from '../embedder.js';

const FIXTURE = new URL('./fixture.json', import.meta.url);
const FLOOR = 0.995;
const PLATFORM = `${process.platform}/${process.arch}`;

const cosine = (a, b) => a.reduce((total, value, i) => total + value * b[i], 0);

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const extractor = await loadExtractor();
const vectors = await embedPassages(extractor, fixture.passages);

// Never process.exit() with the model loaded: onnxruntime-node aborts in its own teardown when the
// process is torn down under it, and an abort trailing a passing check reads like a failure.
if (process.argv.includes('--write')) {
  const weights = crypto.createHash('sha256').update(fs.readFileSync(weightsPath())).digest('hex');
  const transformers = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .dependencies['@huggingface/transformers'];
  const head = {
    note: fixture.note,
    version: VERSION,
    model: MODEL,
    dtype: DTYPE,
    pooling: 'mean',
    normalize: true,
    dim: DIM,
    transformers,
    weights_sha256: weights,
    generated_by: 'check/fixture.mjs --write',
    generated_at: new Date().toISOString().slice(0, 10),
    generated_on: PLATFORM,
    passages: fixture.passages,
  };
  const body = Object.entries(head)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(',\n');
  const rows = vectors.map((vector) => `    ${JSON.stringify(vector)}`).join(',\n');
  fs.writeFileSync(FIXTURE, `{\n${body},\n  "vectors": [\n${rows}\n  ]\n}\n`);
  console.log(`wrote ${vectors.length} vectors to check/fixture.json (weights ${weights.slice(0, 12)}…)`);
} else {
  let worst = 0;
  let closest = 1;
  vectors.forEach((vector, row) => {
    const expected = fixture.vectors[row];
    if (!expected || expected.length !== vector.length) throw new Error(`fixture row ${row} has the wrong shape`);
    vector.forEach((value, i) => (worst = Math.max(worst, Math.abs(value - expected[i]))));
    closest = Math.min(closest, cosine(vector, expected));
  });
  const native = PLATFORM === fixture.generated_on;

  // The model is the model, not a plausible-looking array of floats: the two C++ lines must sit
  // closer together than either sits to a passage about being tired. Mis-wired pooling, or weights
  // that never loaded, still produce unit vectors and still pass a shape check.
  const [wantsCpp, likesCpp, tired] = vectors;
  const related = cosine(wantsCpp, likesCpp);
  const unrelated = cosine(wantsCpp, tired);

  console.log(`rows=${vectors.length} dim=${vectors[0].length} version=${VERSION}`);
  console.log(`here ${PLATFORM}, fixture built on ${fixture.generated_on}` + (native ? '' : ' — cosine is the bar, not bits'));
  console.log(`worst cosine vs fixture: ${closest.toFixed(9)}   worst component |Δ|: ${worst.toExponential(3)}`);
  console.log(`cos(c++ wanted, c++ liked)=${related.toFixed(4)}  cos(c++ wanted, tired)=${unrelated.toFixed(4)}`);

  if (native && worst !== 0) {
    console.error('FAIL: same platform, different vectors — something in this build changed');
    process.exitCode = 1;
  } else if (closest < FLOOR) {
    console.error(`FAIL: this build does not reproduce the committed vectors (floor ${FLOOR})`);
    process.exitCode = 1;
  } else if (related <= unrelated) {
    console.error('FAIL: the embedding space is not behaving like a sentence model');
    process.exitCode = 1;
  } else {
    console.log('OK');
  }
}
