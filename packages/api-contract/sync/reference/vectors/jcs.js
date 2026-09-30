// jcs/values.json: RFC 8785 canonical JSON (§3.2 `jcs`). A number vector names its IEEE-754 bits; a
// text vector gives JSON text for the runner's own parser.

import { jcs } from '../core/jcs.js';
import { vector } from './fixtures.js';

export const NUMBER_BITS = [
  ['zero', '0000000000000000'],
  ['negative zero prints as 0', '8000000000000000'],
  ['the smallest subnormal', '0000000000000001'],
  ['the negative smallest subnormal', '8000000000000001'],
  ['the largest double', '7fefffffffffffff'],
  ['the negative largest double', 'ffefffffffffffff'],
  ['2^53', '4340000000000000'],
  ['-2^53', 'c340000000000000'],
  ['2^68 in plain notation', '4430000000000000'],
  ['just below 1e23', '44b52d02c7e14af5'],
  ['1e23', '44b52d02c7e14af6'],
  ['just above 1e23', '44b52d02c7e14af7'],
  ['the last plain notation below 1e21', '444b1ae4d6e2ef4e'],
  ['plain notation near 1e21', '444b1ae4d6e2ef4f'],
  ['1e21 switches to exponent notation', '444b1ae4d6e2ef50'],
  ['just below 1e-6', '3eb0c6f7a0b5ed8c'],
  ['1e-6 stays plain', '3eb0c6f7a0b5ed8d'],
  ['a shortest round trip, 16 digits', '41b3de4355555553'],
  ['a shortest round trip, 17 digits', '41b3de4355555554'],
  ['a shortest round trip, 16 digits again', '41b3de4355555555'],
  ['a shortest round trip, rounding up', '41b3de4355555556'],
  ['a shortest round trip, 17 digits again', '41b3de4355555557'],
  ['a negative small fraction', 'becbf647612f3696'],
  ['a large fraction', '43143ff3c1cb0959'],
  ['1e-7 in exponent notation', '3e7ad7f29abcaf48'],
  ['0.1', '3fb999999999999a'],
  ['one', '3ff0000000000000'],
  ['NaN is not JSON', '7ff8000000000000'],
  ['infinity is not JSON', '7ff0000000000000'],
  ['negative infinity is not JSON', 'fff0000000000000'],
];

const TEXTS = [
  ['1.0 prints as 1', '1.0'],
  ['-0 prints as 0', '-0'],
  ['-0.0 prints as 0', '-0.0'],
  ['1e21', '1e21'],
  ['1E2 prints plainly', '1E2'],
  ['1e-7', '1e-7'],
  ['0.000001', '0.000001'],
  ['trailing zeros drop', '4.50'],
  ['a long integer rounds to 17 significant digits', '123456789012345678901234567890'],
  ['2^53 - 1', '9007199254740991'],
  ['true, false, null', '[true,false,null]'],
  ['empty containers', '[{},[],""]'],
  ['whitespace is removed', ' [ 1 , { "a" : 2 } ] '],
  ['object keys sort', '{"b":1,"a":2,"c":0}'],
  ['arrays keep their order', '[3,1,2]'],
  ['nested objects sort at every level', '{"z":{"y":[3,{"b":true,"a":null}]},"a":"x"}'],
  ['keys sort by UTF-16 code units, not code points', '{"\\ufb33":2,"\\ud83d\\ude00":1}'],
  ['the RFC 8785 key-order example', '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}'],
  ['escaped non-ASCII prints literally', '"\\u00e9\\u4e2d\\ud83d\\ude00"'],
  ['control characters use short escapes where JSON has them', '"\\u0008\\u0009\\u000a\\u000c\\u000d"'],
  ['other control characters use lowercase \\u escapes', '"\\u0000\\u001f\\u0001\\u001F"'],
  ['quote and backslash are escaped, slash is not', '"\\"\\\\\\/"'],
  ['DEL and U+2028 print literally', '"\\u007f\\u2028\\u2029"'],
  ['a lone high surrogate is refused', '"\\ud800"'],
  ['a lone low surrogate is refused', '"x\\udc00"'],
  ['a surrogate pair out of order is refused', '"\\ude00\\ud83d"'],
];

export function doubleOf(bits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

function canonical(value) {
  try {
    return { jcs: jcs(value) };
  } catch {
    return { error: true };
  }
}

export function files() {
  return {
    'jcs/values.json': [
      ...NUMBER_BITS.map(([name, bits]) => vector(name, { bits }, canonical(doubleOf(bits)))),
      ...TEXTS.map(([name, json]) => vector(name, { json }, canonical(JSON.parse(json)))),
    ],
  };
}
