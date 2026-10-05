import { utf8, compareBytes, encode64, decode64 } from './encoding.js';

// D-26 derived ids from a label, and D-8 seeded ids `<seed>-<n>`.

const ALPHANUMERIC = /^[A-Za-z0-9]$/;
const ORDINAL = /^[1-9][0-9]*$/;
const BASE_LIMIT = 40;

export function derive(label, fallback, taken) {
  let base = '';
  for (const byte of utf8(label)) {
    if (base.length === BASE_LIMIT) break;
    const char = String.fromCharCode(byte);
    if (ALPHANUMERIC.test(char)) base += char.toLowerCase();
    else if (base !== '' && !base.endsWith('-')) base += '-';
  }
  base = base.replace(/-+$/, '');
  if (base === '') base = fallback;
  let id = base;
  for (let k = 2; taken.has(id); k += 1) id = `${base}-${k}`;
  return id;
}

export class SeededIdError extends Error {}

export function seededId(type, seed, n) {
  if (!type.seeded) throw new SeededIdError(`${type.type} does not seed ids`);
  if (typeof seed !== 'string' || seed.length > type.seeded.seedMax || !new RegExp(type.idPattern, 'u').test(seed)) {
    throw new SeededIdError(`seed ${JSON.stringify(seed)} is not an id of at most ${type.seeded.seedMax} characters`);
  }
  if (!Number.isInteger(n) || n < 1 || n > type.seeded.ordinalMax) {
    throw new SeededIdError(`ordinal ${n} is outside 1..${type.seeded.ordinalMax}`);
  }
  const id = `${seed}-${n}`;
  if (!new RegExp(type.idPattern, 'u').test(id)) throw new SeededIdError(`${id} does not match ${type.idPattern}`);
  return id;
}

export function parseSeeded(id) {
  const cut = id.lastIndexOf('-');
  if (cut <= 0) return null;
  const ordinal = id.slice(cut + 1);
  if (!ORDINAL.test(ordinal)) return null;
  return { seed: id.slice(0, cut), n: Number(ordinal) };
}

// D-8 a CSPRNG id by the type's mint: the prefix, then `length` characters of the alphabet, each
// `alphabet[draw(alphabet.length)]`, where draw answers a uniform integer below its argument.
export function mintId(type, draw) {
  const { prefix, alphabet, length } = type.mint;
  let id = prefix;
  for (let k = 0; k < length; k += 1) {
    const index = draw(alphabet.length);
    if (!Number.isInteger(index) || index < 0 || index >= alphabet.length) throw new SeededIdError(`draw ${index} is outside 0..${alphabet.length - 1}`);
    id += alphabet[index];
  }
  return id;
}
