// D-25 fractional order keys: jitterless base-62 keys that sort bytewise, and the drop position over
// the `stored` and `drawn` lists.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const LAST = DIGITS[DIGITS.length - 1];
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

export class OrderKeyError extends Error {}

function integerLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new OrderKeyError(`invalid order-key head: ${head}`);
}

function integerPart(key) {
  const length = integerLength(key[0]);
  if (length > key.length) throw new OrderKeyError(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function checkKey(key) {
  if (typeof key !== 'string' || key === '' || key === SMALLEST_INTEGER) throw new OrderKeyError(`invalid order key: ${key}`);
  if ([...key].some((char) => !DIGITS.includes(char))) throw new OrderKeyError(`invalid order-key digit: ${key}`);
  const integer = integerPart(key);
  if (key.slice(integer.length).endsWith(ZERO)) throw new OrderKeyError(`invalid order key (trailing zero): ${key}`);
}

export function isOrderKey(key) {
  try {
    checkKey(key);
    return true;
  } catch (error) {
    if (error instanceof OrderKeyError) return false;
    throw error;
  }
}

function midpoint(a, b) {
  if (b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new OrderKeyError('trailing zero');
  if (b !== null) {
    let shared = 0;
    while ((a[shared] || ZERO) === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function stepInteger(integer, direction) {
  const [head, ...digits] = integer.split('');
  const overflowDigit = direction > 0 ? ZERO : LAST;
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i -= 1) {
    const next = DIGITS.indexOf(digits[i]) + direction;
    if (next === DIGITS.length || next === -1) {
      digits[i] = overflowDigit;
      continue;
    }
    digits[i] = DIGITS[next];
    carry = false;
  }
  if (!carry) return head + digits.join('');
  if (direction > 0) {
    if (head === 'Z') return `a${ZERO}`;
    if (head === 'z') return null;
    const next = String.fromCharCode(head.charCodeAt(0) + 1);
    if (next > 'a') digits.push(ZERO);
    else digits.pop();
    return next + digits.join('');
  }
  if (head === 'a') return `Z${LAST}`;
  if (head === 'A') return null;
  const previous = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previous < 'Z') digits.push(LAST);
  else digits.pop();
  return previous + digits.join('');
}

export function between(a, b) {
  if (a !== null) checkKey(a);
  if (b !== null) checkKey(b);
  if (a !== null && b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);
  if (a === null && b === null) return `a${ZERO}`;
  if (a === null) {
    const integer = integerPart(b);
    const fraction = b.slice(integer.length);
    if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction);
    if (integer < b) return integer;
    const lower = stepInteger(integer, -1);
    if (lower === null) throw new OrderKeyError('cannot decrement any more');
    return lower;
  }
  if (b === null) {
    const integer = integerPart(a);
    const fraction = a.slice(integer.length);
    const higher = stepInteger(integer, +1);
    return higher === null ? integer + midpoint(fraction, null) : higher;
  }
  const integerA = integerPart(a);
  const integerB = integerPart(b);
  const fractionA = a.slice(integerA.length);
  if (integerA === integerB) return integerA + midpoint(fractionA, b.slice(integerB.length));
  const higher = stepInteger(integerA, +1);
  if (higher === null) throw new OrderKeyError('cannot increment any more');
  if (higher < b) return higher;
  return integerA + midpoint(fractionA, null);
}

export function compareMembers(x, y) {
  if (x.key !== y.key) return x.key < y.key ? -1 : 1;
  if (x.id === y.id) return 0;
  return x.id < y.id ? -1 : 1;
}

// `stored` and `drawn`: the list's visible members `{id, key}` in each view. `above`: the member
// immediately above the drop point, looked up in `drawn`, then in `stored`, or null at the top.
export function dropKey({ stored, drawn, moved, above }) {
  const storedOrder = stored.filter((member) => member.id !== moved).sort(compareMembers);
  if (above === null) return between(null, storedOrder.length ? storedOrder[0].key : null);
  const anchor = drawn.find((member) => member.id === above) ?? storedOrder.find((member) => member.id === above);
  if (!anchor) throw new OrderKeyError(`drop anchor ${above} is not in the list`);
  const successor = storedOrder.find((member) => member.key > anchor.key);
  return between(anchor.key, successor ? successor.key : null);
}
