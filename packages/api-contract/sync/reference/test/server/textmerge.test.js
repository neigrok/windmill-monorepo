import assert from 'node:assert/strict';
import test from 'node:test';
import { diff3, editScript, hunksOf, mergeText, tokenize } from '../../server/textmerge.js';
import { Rng } from '../../vectors/fixtures.js';

const WORDS = ['a', 'b', 'c', 'dd', 'e', 'fox'];
const SPACES = [' ', ' ', ' ', '  ', '\n', '\n\n'];

function textOf(rng, length) {
  const parts = [];
  for (let i = 0; i < length; i += 1) parts.push(rng.pick(WORDS), rng.pick(SPACES));
  return parts.join('').slice(0, rng.chance(0.5) ? undefined : -1);
}

// An edit of `base` by token: deletions, replacements and insertions at random places.
function editOf(rng, base) {
  const tokens = tokenize(base);
  const out = [];
  for (const token of tokens) {
    const roll = rng.next();
    if (roll < 0.1) continue;
    if (roll < 0.2) out.push(rng.pick(WORDS));
    else out.push(token);
    if (rng.chance(0.1)) out.push(rng.pick(SPACES), rng.pick(WORDS));
  }
  return out.join('');
}

function lcs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? 1 + table[i + 1][j + 1] : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  return table[0][0];
}

const SYMBOL = { keep: 'a', delete: 'b', insert: 'c' };

// Every shortest script, spelled keep a < delete b < insert c, by exhaustive search on tiny inputs.
function allShortest(a, b) {
  const target = a.length + b.length - 2 * lcs(a, b);
  const found = [];
  const walk = (i, j, edits, spelled) => {
    if (edits > target) return;
    if (i === a.length && j === b.length) {
      if (edits === target) found.push(spelled);
      return;
    }
    if (i < a.length) walk(i + 1, j, edits + 1, `${spelled}b`);
    if (j < b.length) walk(i, j + 1, edits + 1, `${spelled}c`);
    if (i < a.length && j < b.length && a[i] === b[j]) walk(i + 1, j + 1, edits, `${spelled}a`);
  };
  walk(0, 0, 0, '');
  return found.sort();
}

test('§6.11: the edit script is the lexicographically least shortest script (keep < delete < insert)', () => {
  const rng = new Rng(611);
  for (let i = 0; i < 400; i += 1) {
    const a = tokenize(textOf(rng, rng.int(4)));
    const b = tokenize(textOf(rng, rng.int(4)));
    const script = editScript(a, b).map((step) => SYMBOL[step.op]).join('');
    assert.equal(script, allShortest(a, b)[0], JSON.stringify([a, b]));
  }
});

test('an edit script rebuilds both sides', () => {
  const rng = new Rng(612);
  for (let i = 0; i < 400; i += 1) {
    const base = textOf(rng, 1 + rng.int(8));
    const side = editOf(rng, base);
    const script = editScript(tokenize(base), tokenize(side));
    assert.equal(script.filter((s) => s.op !== 'insert').map((s) => s.token).join(''), base);
    assert.equal(script.filter((s) => s.op !== 'delete').map((s) => s.token).join(''), side);
    const hunks = hunksOf(script);
    for (let k = 1; k < hunks.length; k += 1) assert.ok(hunks[k - 1].end < hunks[k].start, 'hunks of one side never touch');
  }
});

// INV-12 as a multiset: a word occurs in the merge at least as often as the base occurrences both sides
// kept plus the larger of the two sides' insertions of it, so a merge that drops a duplicate fails.
test('INV-12: the text merge keeps every inserted token and every base token no side deleted', () => {
  const rng = new Rng(12);
  const isWord = (token) => /\S/.test(token);
  const tally = (map, token) => map.set(token, (map.get(token) ?? 0) + 1);
  for (let i = 0; i < 1500; i += 1) {
    const base = textOf(rng, 1 + rng.int(8));
    const sides = [editOf(rng, base), editOf(rng, base)];
    const result = new Map();
    for (const token of tokenize(diff3(base, sides[0], sides[1]).text)) if (isWord(token)) tally(result, token);
    const baseTokens = tokenize(base);
    const inserted = [new Map(), new Map()];
    const keptBy = sides.map((side, index) => {
      const kept = new Set();
      let position = 0;
      for (const step of editScript(baseTokens, tokenize(side))) {
        if (step.op === 'insert') {
          if (isWord(step.token)) tally(inserted[index], step.token);
          continue;
        }
        if (step.op === 'keep') kept.add(position);
        position += 1;
      }
      return kept;
    });
    const required = new Map();
    baseTokens.forEach((token, index) => {
      if (isWord(token) && keptBy[0].has(index) && keptBy[1].has(index)) tally(required, token);
    });
    for (const token of new Set([...inserted[0].keys(), ...inserted[1].keys()])) {
      required.set(token, (required.get(token) ?? 0) + Math.max(inserted[0].get(token) ?? 0, inserted[1].get(token) ?? 0));
    }
    for (const [token, count] of required) {
      assert.ok((result.get(token) ?? 0) >= count, `${JSON.stringify({ base, sides })} keeps ${token} ${result.get(token) ?? 0} times, needs ${count}`);
    }
  }
});

test('the multiset INV-12 check fails a merge that drops one of two equal words', () => {
  const merged = tokenize('a a b').filter((token) => /\S/.test(token));
  const dropped = tokenize('a b').filter((token) => /\S/.test(token));
  const count = (tokens, word) => tokens.filter((token) => token === word).length;
  assert.equal(count(merged, 'a'), 2);
  assert.ok(count(dropped, 'a') < 2);
  assert.equal(diff3('a b', 'a a b', 'a b').text, 'a a b');
});

test('diff3 is the identity on unchanged sides, and symmetric up to conflict order', () => {
  const rng = new Rng(3);
  for (let i = 0; i < 500; i += 1) {
    const base = textOf(rng, 1 + rng.int(6));
    const side = editOf(rng, base);
    assert.deepEqual(diff3(base, side, base), { text: side, conflict: false });
    assert.deepEqual(diff3(base, base, side), { text: side, conflict: false });
    assert.deepEqual(diff3(base, side, side), { text: side, conflict: false });
    const other = editOf(rng, base);
    assert.equal(diff3(base, side, other).conflict, diff3(base, other, side).conflict);
  }
});

test('§6.11 step 1: base resolution and the three shortcuts', () => {
  const stored = { text: 'x y', rev: 5, merged: false };
  const revisionText = (rev) => (rev === 2 ? 'x' : undefined);
  assert.deepEqual(mergeText({ stored, base: { rev: 9 }, mine: 'z', revisionText }), { refuse: 'base-unknown' });
  assert.deepEqual(mergeText({ stored, base: { rev: 5 }, mine: 'z', revisionText }), { text: 'z', conflict: false, baseText: 'x y' });
  assert.deepEqual(mergeText({ stored, base: { rev: 2 }, mine: 'x y', revisionText }), { text: 'x y', conflict: false, baseText: 'x' });
  assert.deepEqual(mergeText({ stored, base: { text: 'x' }, mine: 'x', revisionText }), { text: 'x y', conflict: false, baseText: 'x' });
  assert.deepEqual(mergeText({ stored, base: { text: '' }, mine: 'x', revisionText }), { text: 'x y', conflict: false, baseText: 'x' });
  assert.deepEqual(mergeText({ stored, base: { text: '' }, mine: 'x y z', revisionText }), { text: 'x y z', conflict: false, baseText: 'x y' });
});
