import { claim } from '../corpus-support.js';
// The browser core as a corpus runner: each vector's input through the browser modules, with
// the result compared to `expect` by jcs, exactly as a Swift or C++ runner does it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Clock, Offset } from '../../../../src/platform/sync/core/clock.js';
import { CONSTANTS } from '../../../../src/platform/sync/core/constants.js';
import { parseSeeded, seededId, derive } from '../../../../src/platform/sync/core/derive.js';
import { ZERO_DIGEST, replaceRow, rowHash, scopeDigest, toHex } from '../../../../src/platform/sync/core/digest.js';
import { between, compareMembers, dropKey } from '../../../../src/platform/sync/core/fracindex.js';
import { jcs } from '../../../../src/platform/sync/core/jcs.js';
import { INTENT_MACHINE, REPLICA_MACHINE, transition } from '../../../../src/platform/sync/core/machines.js';
import { joinBorn, joinFww, joinLife, joinLww, joinRanked, joinRecord } from '../../../../src/platform/sync/core/merge.js';
import { Stamp } from '../../../../src/platform/sync/core/stamp.js';
import { registry } from '../oracle-adapters/fixtures.js';
import { doubleOf } from '../oracle-adapters/jcs.js';

const load = (path) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../packages/api-contract/sync/corpus/${path}`, import.meta.url)), 'utf8'));
const attempt = (run) => {
  try {
    return run();
  } catch {
    return { error: true };
  }
};
const orNull = (value) => (value === undefined ? null : value);
const orAbsent = (value) => (value === null ? undefined : value);

const RUNNERS = {
  'stamp/order.json': ({ a, b }) => ({ order: Stamp.compare(a, b) }),
  'stamp/codec.json': ({ text }) => {
    if (!Stamp.isValid(text)) return { valid: false };
    const parsed = Stamp.parse(text);
    assert.equal(Stamp.encode(parsed), text);
    return { valid: true, ...parsed };
  },
  'hlc/tick.json': ({ actor, clock, physNow }) => {
    let now = 0;
    const running = new Clock(clock, actor, () => now);
    const stamps = physNow.map((p) => {
      now = p;
      return running.tick();
    });
    return { stamps, clock: running.pair };
  },
  'hlc/observe.json': ({ actor, clock, ops }) => {
    let now = 0;
    const running = new Clock(clock, actor, () => now);
    const stamps = [];
    for (const op of ops) {
      if (op.observe !== undefined) running.observe(op.observe);
      else {
        now = op.tick;
        stamps.push(running.tick());
      }
    }
    return { stamps, clock: running.pair };
  },
  'hlc/offset.json': ({ responses }) => {
    let kept = { samples: [], clockReading: undefined };
    for (const response of responses) kept = Offset.take(kept, response, CONSTANTS) ?? kept;
    return { samples: kept.samples, serverOffsetMs: Offset.choose(kept.samples), clockReading: kept.clockReading ?? null };
  },
  'hlc/jump.json': ({ before, after }) => ({ jumped: Offset.jumped(before, after, CONSTANTS) }),
  'jcs/values.json': (input) => attempt(() => ({ jcs: jcs(input.bits !== undefined ? doubleOf(input.bits) : JSON.parse(input.json)) })),
  'join/lww.json': ({ a, b }) => ({ join: orNull(joinLww(orAbsent(a), orAbsent(b))) }),
  'join/fww.json': ({ a, b }) => ({ join: orNull(joinFww(orAbsent(a), orAbsent(b))) }),
  'join/ranked.json': ({ rank, a, b }) => ({ join: orNull(joinRanked(orAbsent(a), orAbsent(b), rank)) }),
  'join/life.json': ({ a, b }) => ({ join: orNull(joinLife(orAbsent(a), orAbsent(b))) }),
  'join/born.json': ({ a, b }) => ({ join: orNull(joinBorn(orAbsent(a), orAbsent(b))) }),
  'join/record.json': ({ type, a, b }) => ({ join: joinRecord(registry.type(type), a, b) }),
  'derive/slug.json': ({ label, fallback, taken }) => ({ id: derive(label, fallback, new Set(taken)) }),
  'identity/seeded.json': (input) => (input.op === 'parse'
    ? { parsed: parseSeeded(input.id) }
    : attempt(() => ({ id: seededId(registry.type(input.type), input.seed, input.n) }))),
  'fracindex/between.json': ({ a, b }) => attempt(() => ({ key: between(a, b) })),
  'fracindex/drop.json': ({ stored, drawn, moved, above }) => {
    const key = dropKey({ stored, drawn, moved, above });
    const order = (list) => list.map((m) => (m.id === moved ? { ...m, key } : m)).sort(compareMembers).map((m) => m.id);
    const drawnAfter = drawn.some((m) => m.id === moved) ? drawn : [...drawn, { id: moved, key }];
    return { key, drawn: order(drawnAfter), stored: order(stored) };
  },
  'digest/row.json': ({ row }) => ({ hash: toHex(rowHash(row)) }),
  'digest/scope.json': (input) => (input.rows
    ? { digest: scopeDigest(input.rows) }
    : { digest: input.changes.reduce((d, { before, after }) => replaceRow(d, orAbsent(before), orAbsent(after)), input.start) }),
  'machine/intent.json': ({ from, event, to }) => attempt(() => ({ to: transition(INTENT_MACHINE, from, event, to) })),
  'machine/replica.json': ({ from, event, to }) => attempt(() => ({ to: transition(REPLICA_MACHINE, from, event, to) })),

};

for (const [path, run] of Object.entries(RUNNERS)) {
  claim(path);
  test(`corpus ${path}`, () => {
    const vectors = load(path);
    assert.ok(vectors.length > 0);
    assert.equal(new Set(vectors.map((v) => v.name)).size, vectors.length, 'names are unique');
    for (const { name, input, expect } of vectors) assert.equal(jcs(run(structuredClone(input))), jcs(expect), name);
  });
}

test('the digest vectors start from and sum to 64 hex characters', () => {
  for (const { expect } of load('digest/scope.json')) assert.match(expect.digest, /^[0-9a-f]{64}$/);
  assert.equal(load('digest/scope.json')[0].expect.digest, ZERO_DIGEST);
});
