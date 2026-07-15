// Golden-vector runner. Executes the shared corpus against the reference convergence
// semantics every Windmill replica must reproduce. Today the reference lives here; when
// sync/lattice.js lands, its test imports these same fixtures and checks the real
// implementation against them. See SCHEMA.md.
//
//   node test/golden/run.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

// --- the reference semantics (mirror domain/Ids.h + domain/Crdt.h) ---

function parseHlc(text) {
  const first = text.indexOf(':');
  const second = text.indexOf(':', first + 1);
  return {
    physicalMs: Number(text.slice(0, first)),
    counter: Number(text.slice(first + 1, second)),
    actor: text.slice(second + 1),
  };
}

function toString(hlc) {
  return `${hlc.physicalMs}:${hlc.counter}:${hlc.actor}`;
}

function isSet(hlc) {
  return hlc.physicalMs !== 0 || hlc.counter !== 0 || hlc.actor !== '';
}

// -1 / 0 / 1 for a vs b, ordered by (physicalMs, counter, actor).
function compareHlc(a, b) {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

function greatest(stamps) {
  return stamps.map(parseHlc).reduce((max, s) => (compareHlc(s, max) > 0 ? s : max), parseHlc('0:0:'));
}

function elementSetPresent(adds, removes) {
  const addedAt = greatest(adds);
  const removedAt = greatest(removes);
  return isSet(addedAt) && !(compareHlc(removedAt, addedAt) > 0);
}

function vectorCovers(marks, query) {
  const stamp = parseHlc(query);
  if (!isSet(stamp)) return true;
  const frontier = new Map();  // actor -> greatest stamp, as VersionVector::observe folds them
  for (const m of marks.map(parseHlc)) {
    const seen = frontier.get(m.actor);
    if (seen === undefined || compareHlc(m, seen) > 0) frontier.set(m.actor, m);
  }
  const mark = frontier.get(stamp.actor);
  return mark !== undefined && compareHlc(stamp, mark) <= 0;
}

// --- the runner ---

let passed = 0;
let failed = 0;
const expectSign = { lt: -1, eq: 0, gt: 1 };

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

for (const c of load('hlc.json').compare) {
  check(`hlc.compare: ${c.name}`, () =>
    assert.equal(Math.sign(compareHlc(parseHlc(c.a), parseHlc(c.b))), expectSign[c.expect]));
}
for (const c of load('hlc.json').sentinel) {
  check(`hlc.sentinel: ${c.name}`, () => assert.equal(isSet(parseHlc(c.text)), c.isSet));
}
for (const c of load('hlc.json').codec) {
  check(`hlc.codec: ${c.name}`, () => assert.equal(toString(parseHlc(c.text)), c.text));
}
for (const c of load('element-set.json').cases) {
  check(`element-set: ${c.name}`, () => assert.equal(elementSetPresent(c.adds, c.removes), c.present));
}
for (const c of load('version-vector.json').cases) {
  check(`version-vector: ${c.name}`, () => assert.equal(vectorCovers(c.marks, c.query), c.covers));
}

console.log(`\n${passed}/${passed + failed} golden vectors passed`);
process.exit(failed === 0 ? 0 : 1);
