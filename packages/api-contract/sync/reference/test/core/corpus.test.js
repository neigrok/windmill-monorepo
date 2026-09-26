// The reference as a corpus runner for the core files: each vector's input through the reference, with
// the result compared to `expect` by jcs, exactly as a Swift or C++ runner does it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Clock, Offset } from '../../core/clock.js';
import { CONSTANTS } from '../../core/constants.js';
import { parseSeeded, seededId, derive } from '../../core/derive.js';
import { ZERO_DIGEST, replaceRow, rowHash, scopeDigest, toHex } from '../../core/digest.js';
import { between, compareMembers, dropKey } from '../../core/fracindex.js';
import { jcs } from '../../core/jcs.js';
import { INTENT_MACHINE, REPLICA_MACHINE, SCOPE_MACHINE, transition } from '../../core/machines.js';
import { joinBorn, joinFww, joinLife, joinLww, joinRanked, joinRecord } from '../../core/merge.js';
import { Stamp } from '../../core/stamp.js';
import { decide, opOf } from '../../server/identity.js';
import { diff3, editScript, mergeText, mergedFlag, tokenize } from '../../server/textmerge.js';
import { registry } from '../../vectors/fixtures.js';
import { doubleOf } from '../../vectors/jcs.js';

const load = (path) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../corpus/${path}`, import.meta.url)), 'utf8'));
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
  'hlc/offset.json': ({ samples }) => {
    let kept = [];
    for (const response of samples) kept = Offset.record(kept, Offset.sample(response), CONSTANTS);
    return { samples: kept, serverOffsetMs: Offset.choose(kept) };
  },
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
  'identity/table.json': ({ type, delta, idState }) => {
    const def = registry.type(type);
    const op = opOf(def, delta);
    const { verdict, code } = decide(def, op, idState, delta.born);
    return code === undefined ? { op, verdict } : { op, verdict, code };
  },
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
  'machine/scope.json': ({ from, event, to }) => attempt(() => ({ to: transition(SCOPE_MACHINE, from, event, to) })),
  'text/tokens.json': ({ text }) => ({ tokens: tokenize(text) }),
  'text/script.json': ({ a, b }) => ({ script: editScript(tokenize(a), tokenize(b)).map((step) => [step.op, step.token]) }),
  'text/diff3.json': ({ base, head, mine }) => diff3(base, head, mine),
  'text/merge.json': ({ stored, base, mine, revisions }) => {
    const outcome = mergeText({ stored, base, mine, revisionText: (rev) => revisions.find((r) => r.rev === rev)?.text });
    if (outcome.refuse) return { refuse: outcome.refuse };
    return { text: outcome.text, conflict: outcome.conflict, merged: mergedFlag(stored, outcome), baseText: outcome.baseText };
  },
};

for (const [path, run] of Object.entries(RUNNERS)) {
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
