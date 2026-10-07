// identity/seeded.json (D-8 seeded ids) and identity/table.json (§4.1 shapes and every §4.3 cell).

import assert from 'node:assert/strict';
import { parseSeeded, seededId } from '../core/derive.js';
import { decide, opOf } from '../server/identity.js';
import { registry, st, vector } from './fixtures.js';

const LAP = registry.type('lap');

function make(name, seed, n) {
  try {
    return vector(name, { op: 'make', type: 'lap', seed, n }, { id: seededId(LAP, seed, n) });
  } catch {
    return vector(name, { op: 'make', type: 'lap', seed, n }, { error: true });
  }
}

function parse(name, id) {
  return vector(name, { op: 'parse', id }, { parsed: parseSeeded(id) });
}

const BORN = st(5);
const OTHER_BORN = st(4);
const SHAPES = {
  create: { life: ['alive', BORN], born: BORN },
  update: { born: BORN },
  delete: { life: ['dead', st(9)], born: BORN },
  revive: { life: ['alive', st(9)], born: BORN },
};
const STATES = {
  none: { state: 'none' },
  foreign: { state: 'foreign' },
  'alive=': { state: 'alive', born: BORN },
  'alive≠': { state: 'alive', born: OTHER_BORN },
  'dead=': { state: 'dead', born: BORN },
  'dead≠': { state: 'dead', born: OTHER_BORN },
};

function cell(name, type, delta, idState) {
  const def = registry.type(type);
  const op = opOf(def, delta);
  const decision = decide(def, op, idState, delta.born);
  if (op === 'delete' && idState.state === 'none') assert.deepEqual(decision, { verdict: 'apply' }, 'an absent delete must survive a later replayed create');
  if (op === 'delete' && idState.state === 'alive' && idState.born !== delta.born)
    assert.deepEqual(decision, { verdict: 'refuse', code: 'unknown-record' }, 'a changed incarnation must retain the delete in a notice');
  const expect = { op, verdict: decision.verdict };
  if (decision.code) expect.code = decision.code;
  return vector(name, { type, delta, idState }, expect);
}

function grid(type, states) {
  const out = [];
  for (const [op, delta] of Object.entries(SHAPES)) {
    for (const state of states) out.push(cell(`${type} ${op} on ${state}`, type, delta, STATES[state]));
  }
  return out;
}

export function files() {
  return {
    'identity/seeded.json': [
      make('a seed and an ordinal', 'abcdefgh', 1),
      make('a 58-character seed takes the largest ordinal within 64', 'S'.repeat(58), 99999),
      make('a seed holding dashes', 'ab-cd-ef-1', 2),
      make('a seed over seedMax is refused', 'S'.repeat(59), 1),
      make('a seed outside the id pattern is refused', 'abc.defgh', 1),
      make('a seed shorter than the id pattern allows is refused', 'short', 1),
      make('ordinal 0 is refused', 'abcdefgh', 0),
      make('an ordinal over ordinalMax is refused', 'abcdefgh', 100000),
      make('a fractional ordinal is refused', 'abcdefgh', 1.5),
      parse('seed and ordinal split at the last dash', 'abcdefgh-1'),
      parse('a seed holding dashes keeps them', 'ab-cd-ef-12'),
      parse('no dash is not seeded', 'abcdefgh'),
      parse('an empty ordinal is not seeded', 'abcdefgh-'),
      parse('an ordinal with a leading zero is not seeded', 'abcdefgh-01'),
      parse('ordinal 0 is not seeded', 'abcdefgh-0'),
      parse('an empty seed is not seeded', '-5'),
      parse('a non-decimal ordinal is not seeded', 'abcdefgh-1a'),
    ],
    'identity/table.json': [
      ...grid('card', Object.keys(STATES)),
      ...grid('tag', ['none', 'alive=', 'alive≠', 'dead=', 'dead≠']),
      cell('link put alive on none', 'link', { life: ['alive', st(9)] }, STATES.none),
      cell('link put alive on alive', 'link', { life: ['alive', st(9)] }, { state: 'alive' }),
      cell('link put alive on dead', 'link', { life: ['alive', st(9)] }, { state: 'dead' }),
      cell('link put dead on alive', 'link', { life: ['dead', st(9)] }, { state: 'alive' }),
      cell('link put dead on none', 'link', { life: ['dead', st(9)] }, STATES.none),
      cell('link put dead on dead', 'link', { life: ['dead', st(9)] }, { state: 'dead' }),
      cell('mark write on none', 'mark', {}, STATES.none),
      cell('mark write on alive', 'mark', {}, { state: 'alive' }),
      cell('meta write on none', 'meta', {}, STATES.none),
      cell('meta write on alive', 'meta', {}, { state: 'alive' }),
      cell('invalid: a minted delta without born', 'card', { life: ['alive', BORN] }, STATES.none),
      cell('invalid: a minted delta with neither life nor born', 'card', {}, STATES['alive=']),
      cell('invalid: a keyed-with-life delta without life', 'link', {}, { state: 'alive' }),
      cell('invalid: a keyed delta carrying born', 'link', { life: ['alive', BORN], born: BORN }, STATES.none),
      cell('invalid: a keyed-without-life delta carrying life', 'mark', { life: ['alive', BORN] }, STATES.none),
      cell('invalid: a singleton delta carrying life', 'meta', { life: ['alive', BORN] }, STATES.none),
      cell('invalid: a singleton delta carrying born', 'meta', { born: BORN }, STATES.none),
    ],
  };
}
