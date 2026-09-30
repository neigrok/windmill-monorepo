// digest/row.json (a row's hash) and digest/scope.json (sums and incremental changes), §6.12.

import { ZERO_DIGEST, replaceRow, rowHash, scopeDigest, toHex } from '../core/digest.js';
import { row, st, vector } from './fixtures.js';

const CARD = row({ t: 'card', id: 'card0001', life: ['alive', st(5)], born: st(5), f: { title: ['Hi', st(5)], tier: ['draft', st(5)] }, seq: 1 });
const TAG = row({ t: 'tag', id: 'learn-rust', life: ['alive', st(6)], born: st(6), f: { label: ['Learn Rust', st(6)] }, seq: 2 });
const LINK = row({ t: 'link', id: ['learn-rust', 'ship-it'], life: ['alive', st(7)], seq: 3 });
const MARK = row({ t: 'mark', id: 'learn-rust', f: { done: [true, st(8)] }, x: { memo: { text: 'first draft ✓', rev: 4, merged: false } }, seq: 4 });
const META = row({ t: 'meta', id: 'meta', f: { title: ['Plan', st(9)], visibility: ['public', st(9, 0, 'srv')] }, seq: 5 });
const LAP = row({ t: 'lap', id: 'lap00001', life: ['alive', st(10)], born: st(10), f: { runId: ['run00001', st(10)], weight: [0.30000000000000004, st(10)] }, v: { no: 3 }, seq: 6 });
const UNKNOWN_FIELD = row({ t: 'card', id: 'card0002', life: ['alive', st(5)], born: st(5), f: { shine: ['gold', st(5)], title: ['Hi', st(5)] }, seq: 7 });
const UNKNOWN_TYPE = row({ t: 'widget', id: 'w1', f: { size: [3, st(5)] }, seq: 8 });
const DEAD_THIN = row({ t: 'card', id: 'card0003', life: ['dead', st(11)], born: st(5), seq: 9 });
const DEAD_REVIVABLE = row({ t: 'tag', id: 'old-tag', life: ['dead', st(12)], born: st(6), f: { label: ['Old', st(6)] }, seq: 10 });

const ROWS = [
  ['a minted row', CARD],
  ['a derived row', TAG],
  ['a keyed row whose id is an array', LINK],
  ['a keyed row without life, with a text value', MARK],
  ['a singleton row', META],
  ['a row with a serial value and a float', LAP],
  ['a field the registry does not know is hashed as received', UNKNOWN_FIELD],
  ['a type the registry does not know is hashed as received', UNKNOWN_TYPE],
  ['a dead thin row contributes nothing', DEAD_THIN],
  ['a dead revivable row with fields contributes nothing', DEAD_REVIVABLE],
];

// The first rows of a deterministic family whose hashes each exceed 2^255, so any two sum past 2^256.
function largeRows(count) {
  const found = [];
  for (let n = 1; found.length < count; n += 1) {
    const candidate = row({ t: 'card', id: `wrap${String(n).padStart(4, '0')}`, life: ['alive', st(5)], born: st(5), seq: 1 });
    if (rowHash(candidate) >= 1n << 255n) found.push(candidate);
  }
  return found;
}

function incremental(name, start, changes) {
  const digest = changes.reduce((current, { before, after }) => replaceRow(current, before ?? undefined, after ?? undefined), start);
  return vector(name, { start, changes }, { digest });
}

export function files() {
  const [W1, W2, W3] = largeRows(3);
  const CARD_V2 = row({ ...CARD, f: { ...CARD.f, title: ['Hello', st(13)] }, seq: 11 });
  const CARD_DEAD = row({ t: 'card', id: 'card0001', life: ['dead', st(14)], born: st(5), seq: 12 });
  const wrapped = scopeDigest([W1, W2]);
  return {
    'digest/row.json': ROWS.map(([name, input]) => vector(name, { row: input }, { hash: toHex(rowHash(input)) })),
    'digest/scope.json': [
      vector('an empty scope', { rows: [] }, { digest: ZERO_DIGEST }),
      vector('one row', { rows: [CARD] }, { digest: scopeDigest([CARD]) }),
      vector('rows of every identity class, in any order', { rows: [META, LINK, CARD, MARK, TAG, LAP] }, { digest: scopeDigest([META, LINK, CARD, MARK, TAG, LAP]) }),
      vector('dead rows are outside the sum', { rows: [CARD, DEAD_THIN, DEAD_REVIVABLE] }, { digest: scopeDigest([CARD, DEAD_THIN, DEAD_REVIVABLE]) }),
      vector('two large hashes wrap past 2^256', { rows: [W1, W2] }, { digest: wrapped }),
      vector('three large hashes wrap', { rows: [W1, W2, W3] }, { digest: scopeDigest([W1, W2, W3]) }),
      incremental('inserts from zero', ZERO_DIGEST, [{ before: null, after: CARD }, { before: null, after: TAG }]),
      incremental('a replacement swaps one hash for another', scopeDigest([CARD, TAG]), [{ before: CARD, after: CARD_V2 }]),
      incremental('a death removes the row\'s hash', scopeDigest([CARD, TAG]), [{ before: CARD, after: CARD_DEAD }]),
      incremental('a spent row\'s removal: after is absent', scopeDigest([CARD, TAG]), [{ before: CARD, after: null }]),
      incremental('a revival adds the hash back', scopeDigest([TAG]), [{ before: DEAD_REVIVABLE, after: row({ ...DEAD_REVIVABLE, life: ['alive', st(15)], seq: 13 }) }]),
      incremental('removing from a wrapped sum wraps back below zero', wrapped, [{ before: W1, after: null }]),
      incremental('a sequence ends where a recount ends', ZERO_DIGEST, [
        { before: null, after: W1 },
        { before: null, after: CARD },
        { before: null, after: W2 },
        { before: CARD, after: CARD_V2 },
        { before: W1, after: null },
        { before: CARD_V2, after: CARD_DEAD },
      ]),
    ],
  };
}
