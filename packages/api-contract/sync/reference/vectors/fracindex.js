// fracindex/between.json (D-25 keys) and fracindex/drop.json (D-25 drop position).

import { between, compareMembers, dropKey } from '../core/fracindex.js';
import { Rng, vector } from './fixtures.js';

function betweenVector(name, a, b) {
  try {
    return vector(name, { a, b }, { key: between(a, b) });
  } catch {
    return vector(name, { a, b }, { error: true });
  }
}

const FIXED = [
  ['an empty list', null, null],
  ['before the first key', null, 'a0'],
  ['after the first key', 'a0', null],
  ['between adjacent integers', 'a0', 'a1'],
  ['between a key and its next integer', 'a0V', 'a1'],
  ['between an integer and a fraction', 'a0', 'a0V'],
  ['a deeper fraction', 'a1V', 'a1W'],
  ['across the negative-positive boundary', 'Zz', 'a0'],
  ['after the last one-digit positive integer rolls to two digits', 'az', null],
  ['before Zz', null, 'Zz'],
  ['before Z0 rolls the head down', null, 'Z0'],
  ['after b00', 'b00', null],
  ['different integer parts take the next integer', 'a0', 'a9'],
  ['equal keys are refused', 'a1', 'a1'],
  ['descending keys are refused', 'a2', 'a1'],
  ['a trailing zero is not a key', 'a10', null],
  ['a head outside [A-Za-z] is not a key', '!0', null],
  ['a character outside base 62 is not a key', 'a0!', null],
  ['a key shorter than its head demands is refused', 'a', null],
  ['the internal floor is not a key', `A${'0'.repeat(26)}`, null],
];

// Keys a list grows by inserting at random places, starting empty: each insert is one vector.
function chain(seed, count) {
  const rng = new Rng(seed);
  const keys = [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const at = rng.int(keys.length + 1);
    const a = at === 0 ? null : keys[at - 1];
    const b = at === keys.length ? null : keys[at];
    const key = between(a, b);
    out.push(vector(`chain ${seed}, insert ${i + 1}`, { a, b }, { key }));
    keys.splice(at, 0, key);
  }
  return out;
}

function drop(name, { stored, drawn = stored, moved, above }) {
  const key = dropKey({ stored, drawn, moved, above });
  const reorder = (list) => list.map((member) => (member.id === moved ? { ...member, key } : member)).sort(compareMembers).map((member) => member.id);
  const drawnAfter = drawn.some((member) => member.id === moved) ? drawn : [...drawn, { id: moved, key }];
  return vector(name, { stored, drawn, moved, above }, { key, drawn: reorder(drawnAfter), stored: reorder(stored) });
}

const A = { id: 'A', key: 'a0' };
const B = { id: 'B', key: 'a1' };
const C = { id: 'C', key: 'a2' };
const D = { id: 'D', key: 'a3' };

export function files() {
  return {
    'fracindex/between.json': [...FIXED.map(([name, a, b]) => betweenVector(name, a, b)), ...chain(7, 24), ...chain(11, 24)],
    'fracindex/drop.json': [
      drop('to the top: before the first stored row', { stored: [A, B, C], moved: 'C', above: null }),
      drop('to the bottom: after the last stored row', { stored: [A, B, C], moved: 'A', above: 'C' }),
      drop('into the middle', { stored: [A, B, C], moved: 'C', above: 'A' }),
      drop('down past its own old slot', { stored: [A, B, C, D], moved: 'A', above: 'C' }),
      drop('up past other rows', { stored: [A, B, C, D], moved: 'D', above: 'A' }),
      drop('dropped where it was keeps its key', { stored: [A, B, C], moved: 'B', above: 'A' }),
      drop('a held-deleted successor keeps its stored place', {
        stored: [A, { id: 'H', key: 'a1' }, C, D],
        drawn: [A, C, D],
        moved: 'D',
        above: 'A',
      }),
      drop('to the top above a held-deleted first row', {
        stored: [{ id: 'H', key: 'a0' }, B, C],
        drawn: [B, C],
        moved: 'C',
        above: null,
      }),
      drop('to the bottom of the drawn list: before a held-deleted last row, which keeps its place', {
        stored: [A, B, { id: 'H', key: 'a2' }],
        drawn: [A, B],
        moved: 'A',
        above: 'B',
      }),
      drop('after the first of two equal keys: between it and the next greater key', {
        stored: [{ id: 'A', key: 'a1' }, { id: 'B', key: 'a1' }, { id: 'D', key: 'a3' }, { id: 'C', key: 'a5' }],
        moved: 'C',
        above: 'A',
      }),
      drop('after the second of two equal keys', {
        stored: [{ id: 'A', key: 'a1' }, { id: 'B', key: 'a1' }, { id: 'D', key: 'a3' }, { id: 'C', key: 'a5' }],
        moved: 'C',
        above: 'B',
      }),
      drop('the only member', { stored: [A], moved: 'A', above: null }),
    ],
  };
}
