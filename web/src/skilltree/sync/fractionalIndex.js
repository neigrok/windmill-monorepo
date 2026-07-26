// Jitterless fractional indexing (LexoRank / Figma style): an order key is a string that
// sorts by plain lexicographic `<`, and between any two distinct keys there is always room
// for another — so a reorder is a single write of one key, never a renumber of siblings.
// A key is an integer part (length-prefixed by its head char) plus a fractional tail; the
// alphabet is base-62 in ascending char-code order (`0-9A-Za-z`), so string comparison over
// keys equals comparison over digit indices. This is the standard rocicorp/fractional-indexing
// algorithm; its correctness is pinned exhaustively in test/skilltree/sync/fractionalIndex.test.js.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const LAST = DIGITS[DIGITS.length - 1];
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);  // integerLength('A') - 1 zeros — the internal floor, never a valid key

// The integer part's length, encoded by its head char: heads a..z hold positives of length
// 2..27, heads A..Z hold negatives of length 27..2. This is how a key carries an unbounded
// integer magnitude without a separator.
function integerLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order-key head: ${head}`);
}

function integerPart(key) {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function validateInteger(int) {
  if (int.length !== integerLength(int[0])) throw new Error(`invalid integer part of order key: ${int}`);
}

function validateKey(key) {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  const int = integerPart(key);
  const frac = key.slice(int.length);
  if (frac.slice(-1) === ZERO) throw new Error(`invalid order key (trailing zero): ${key}`);
}

// A fractional string strictly between `a` and `b` (fractional parts only, no integer part).
// `a` may be '' (open start), `b` may be null (open end); `a < b` when `b` is non-null.
function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error('trailing zero');
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;  // share the common prefix, padding `a` with zeros
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);  // consecutive digits — descend into `a`
}

function incrementInteger(x) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) { digs[i] = ZERO; continue; }
    digs[i] = DIGITS[d];
    carry = false;
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digs.push(ZERO); else digs.pop();
  return next + digs.join('');
}

function decrementInteger(x) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) { digs[i] = LAST; continue; }
    digs[i] = DIGITS[d];
    borrow = false;
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < 'Z') digs.push(LAST); else digs.pop();
  return prev + digs.join('');
}

// A key strictly between `a` and `b` under plain string `<`. Either end may be null (open):
// keyBetween(null, null) is a mid key, keyBetween(a, null) sits after a, keyBetween(null, b)
// before b. Requires a < b when both are given.
export function keyBetween(a = null, b = null) {
  if (a != null) validateKey(a);
  if (b != null) validateKey(b);
  if (a != null && b != null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a == null) {
    if (b == null) return 'a' + ZERO;
    const int = integerPart(b);
    const frac = b.slice(int.length);
    if (int === SMALLEST_INTEGER) return int + midpoint('', frac);
    if (int < b) return int;
    const decremented = decrementInteger(int);
    if (decremented == null) throw new Error('cannot decrement any more');
    return decremented;
  }

  if (b == null) {
    const int = integerPart(a);
    const frac = a.slice(int.length);
    const incremented = incrementInteger(int);
    return incremented == null ? int + midpoint(frac, null) : incremented;
  }

  const intA = integerPart(a);
  const fracA = a.slice(intA.length);
  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const incremented = incrementInteger(intA);
  if (incremented == null) throw new Error('cannot increment any more');
  if (incremented < b) return incremented;
  return intA + midpoint(fracA, null);
}

// n evenly-spaced keys strictly between `a` and `b`, ascending — for seeding a whole group in
// one shot. Splits the range recursively so the keys stay short and balanced.
export function nKeysBetween(a = null, b = null, n) {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b == null) {
    let current = keyBetween(a, b);
    const keys = [current];
    for (let i = 0; i < n - 1; i++) { current = keyBetween(current, b); keys.push(current); }
    return keys;
  }
  if (a == null) {
    let current = keyBetween(a, b);
    const keys = [current];
    for (let i = 0; i < n - 1; i++) { current = keyBetween(a, current); keys.push(current); }
    keys.reverse();
    return keys;
  }
  const half = Math.floor(n / 2);
  const mid = keyBetween(a, b);
  return [...nKeysBetween(a, mid, half), mid, ...nKeysBetween(mid, b, n - half - 1)];
}
