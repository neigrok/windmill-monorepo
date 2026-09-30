// stamp/order.json and stamp/codec.json: D-1 encoding, §10.1 parsing and §3.1 order.

import { Stamp } from '../core/stamp.js';
import { vector } from './fixtures.js';

const ORDER = [
  ['ms decides first', '5:9:zzz', '6:0:aaa'],
  ['ms compares as a number, not as text', '10:0:a', '9:0:a'],
  ['counter decides on equal ms', '5:1:zzz', '5:2:aaa'],
  ['counter compares as a number, not as text', '5:10:a', '5:9:a'],
  ['actor decides on equal ms and counter', '5:1:r_a', '5:1:srv'],
  ['actor is compared bytewise: uppercase sorts first', '5:1:Srv', '5:1:srv'],
  ['actor is compared bytewise: a prefix sorts first', '5:1:ab', '5:1:abc'],
  ['actor is compared bytewise: b after ab', '5:1:b', '5:1:ab'],
  ['an actor holding colons compares as its whole remainder', '5:1:a:b', '5:1:a'],
  ['equal stamps', '7:3:r_aaaaaaaaaaaa', '7:3:r_aaaaaaaaaaaa'],
  ['the unset stamp is below every set stamp', '0:0:', '0:0:!'],
  ['the unset stamp equals itself', '0:0:', '0:0:'],
  ['ms near 2^53', '9007199254740991:0:a', '9007199254740990:4294967295:a'],
  ['counter at its limit is below the next ms', '5:4294967295:z', '6:0:a'],
];

const VALID = [
  ['a plain stamp', '1700000000000:3:r_aaaaaaaaaaaa'],
  ['the unset stamp', '0:0:'],
  ['zero ms and counter with an actor', '0:0:a'],
  ['the server actor', '12:0:srv'],
  ['an actor holding colons: the remainder after two colons', '1:2:a:b:c'],
  ['a 64-byte actor', `1:0:${'a'.repeat(64)}`],
  ['a space is printable ASCII and so a valid actor byte', '1:0:r x'],
  ['a tilde, the last printable byte', '1:0:~'],
  ['ms at 2^53 - 1', '9007199254740991:0:a'],
  ['counter at 2^32 - 1', '5:4294967295:a'],
];

const INVALID = [
  ['empty text', ''],
  ['one colon', '1:0'],
  ['no colon', '1'],
  ['leading zero in ms', '01:0:a'],
  ['leading zero in counter', '1:00:a'],
  ['ms at 2^53', '9007199254740992:0:a'],
  ['counter at 2^32', '5:4294967296:a'],
  ['empty actor on a set stamp', '5:0:'],
  ['empty actor with zero ms and a counter', '0:1:'],
  ['a 65-byte actor', `1:0:${'a'.repeat(65)}`],
  ['a non-ASCII actor', '1:0:é'],
  ['a control byte in the actor', '1:0:a\tb'],
  ['a DEL byte in the actor', '1:0:a\u007f'],
  ['a plus sign', '+1:0:a'],
  ['a minus sign', '-1:0:a'],
  ['a decimal point', '1.5:0:a'],
  ['an exponent', '1e3:0:a'],
  ['an empty ms', ':0:a'],
  ['an empty counter', '1::a'],
  ['whitespace around a number', ' 1:0:a'],
];

function codec(name, text) {
  if (!Stamp.isValid(text)) return vector(name, { text }, { valid: false });
  const { ms, counter, actor } = Stamp.parse(text);
  return vector(name, { text }, { valid: true, ms, counter, actor });
}

export function files() {
  return {
    'stamp/order.json': ORDER.map(([name, a, b]) => vector(name, { a, b }, { order: Stamp.compare(a, b) })),
    'stamp/codec.json': [...VALID, ...INVALID].map(([name, text]) => codec(name, text)),
  };
}
