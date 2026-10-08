import assert from 'node:assert/strict';
import test from 'node:test';
import { compareJcs, jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { doubleOf } from '../oracle-adapters/jcs.js';

// RFC 8785 Appendix B, as the RFC prints them.
const APPENDIX_B = {
  '0000000000000000': '0',
  '8000000000000000': '0',
  '0000000000000001': '5e-324',
  '8000000000000001': '-5e-324',
  '7fefffffffffffff': '1.7976931348623157e+308',
  ffefffffffffffff: '-1.7976931348623157e+308',
  '4340000000000000': '9007199254740992',
  c340000000000000: '-9007199254740992',
  '4430000000000000': '295147905179352830000',
  '44b52d02c7e14af5': '9.999999999999997e+22',
  '44b52d02c7e14af6': '1e+23',
  '44b52d02c7e14af7': '1.0000000000000001e+23',
  '444b1ae4d6e2ef4e': '999999999999999700000',
  '444b1ae4d6e2ef4f': '999999999999999900000',
  '444b1ae4d6e2ef50': '1e+21',
  '3eb0c6f7a0b5ed8c': '9.999999999999997e-7',
  '3eb0c6f7a0b5ed8d': '0.000001',
  '41b3de4355555553': '333333333.3333332',
  '41b3de4355555554': '333333333.33333325',
  '41b3de4355555555': '333333333.3333333',
  '41b3de4355555556': '333333333.3333334',
  '41b3de4355555557': '333333333.33333343',
  becbf647612f3696: '-0.0000033333333333333333',
  '43143ff3c1cb0959': '1424953923781206.2',
};

test('RFC 8785 Appendix B numbers print as the RFC lists them', () => {
  for (const [bits, text] of Object.entries(APPENDIX_B)) assert.equal(jcs(doubleOf(bits)), text, bits);
});

test('non-finite numbers and lone surrogates are not canonical JSON', () => {
  for (const value of [NaN, Infinity, -Infinity, '\ud800', 'a\udc00', { '\ud800': 1 }]) assert.throws(() => jcs(value));
});

test('RFC 8785 §3.2.3: keys sort by UTF-16 code units', () => {
  const value = { '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', 1: 'One', '\u{1f600}': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' };
  assert.equal(jcs(value), '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","\u{1f600}":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
});

test('compareJcs orders by UTF-8 bytes of the encoding', () => {
  assert.equal(compareJcs('דּ', '\u{1f600}'), -1);
  assert.equal(compareJcs(9, 10), 1);
  assert.equal(compareJcs(null, false), 1);
  assert.equal(compareJcs({ b: 1, a: 2 }, { a: 2, b: 1 }), 0);
});
