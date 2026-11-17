// derive/slug.json: D-26 derived ids.

import assert from 'node:assert/strict';
import { derive } from '../core/derive.js';
import { vector } from './fixtures.js';

const CASES = [
  ['words join with one dash', 'Learn Rust', 'step', []],
  ['punctuation runs collapse', 'Hello,  World!!', 'step', []],
  ['leading and trailing punctuation drop', '  --Leading and trailing--  ', 'step', []],
  ['dots between letters', 'a...b', 'step', []],
  ['uppercase lowers, digits stay', 'ABC123 Step 1', 'step', []],
  ['underscore is not alphanumeric', 'snake_case', 'step', []],
  ['tabs and newlines are separators', 'tabs\tand\nnewlines', 'step', []],
  ['each UTF-8 byte outside [A-Za-z0-9] is a separator', 'Ünïcode', 'step', []],
  ['non-ASCII before any letter adds nothing', '日本 go', 'step', []],
  ['an emoji between words', 'run 🏃 fast', 'step', []],
  ['an empty label takes the fallback', '', 'step', []],
  ['a label without alphanumerics takes the fallback', '!!! ???', 'kind', []],
  ['a label of only non-ASCII takes the fallback', '日本語', 'step', []],
  ['the base stops at 40 characters', 'a'.repeat(45), 'step', []],
  ['a dash at the 40th character is trimmed', `${'a'.repeat(39)} bcd`, 'step', []],
  ['a taken base gets -2', 'abc', 'step', ['abc']],
  ['suffixes count up past taken ones', 'abc', 'step', ['abc', 'abc-2', 'abc-3']],
  ['a taken suffix alone does not move the base', 'abc', 'step', ['abc-2']],
  ['a taken fallback gets -2', '', 'step', ['step']],
  ['a label ending in -2 gets its own suffix', 'a-2', 'step', ['a-2']],
  ['suffixes append to the 40-character base', 'b'.repeat(50), 'step', ['b'.repeat(40)]],
];

export function files() {
  return {
    'derive/bounded.json': [
      ['a long label fits the declared maximum', 'a'.repeat(200), 'node', [], 8, { id: 'aaaaaaaa' }],
      ['a maximum-length fallback reserves collision suffix room', '', 'abcdefgh', ['abcdefgh'], 8, { id: 'abcdef-2' }],
      ['bounded collision suffixes skip taken ids', 'abcdefgh', 'node', ['abcdefgh', 'abcdef-2', 'abcdef-3'], 8, { id: 'abcdef-4' }],
      ['suffix growth reserves another code point', '', 'node', ['node', ...Array.from({ length: 8 }, (_, i) => `no-${i + 2}`)], 4, { id: 'n-10' }],
      ['composed fallback keeps its scalar spelling', '', 'éééé', ['éééé'], 4, { id: 'éé-2' }],
      ['decomposed fallback counts each scalar', '', 'e\u0301e\u0301', ['e\u0301e\u0301'], 4, { id: 'e\u0301-2' }],
      ['non-BMP fallback counts one scalar per character', '', '😀😀😀😀', ['😀😀😀😀'], 4, { id: '😀😀-2' }],
      ['bounded fallback trims only the separator scalar', '', '\u0600-', [], 2, { id: '\u0600' }],
      ['collision stems trim only the separator scalar', '', '\u0600-ab', ['\u0600-ab'], 4, { id: '\u0600-2' }],
      ['bounded truncation removes a trailing separator', 'a bc', 'node', [], 2, { id: 'a' }],
      ['a tiny bound permits a free stem', 'abc', 'a', [], 1, { id: 'a' }],
      ['an exhausted tiny bound cannot fit a stem and suffix', 'abc', 'a', ['a'], 1, { error: true }],
      ['a suffix alone is not an id', 'ab', 'a', ['ab'], 2, { error: true }],
    ].map(([name, label, fallback, taken, maxChars, expect]) => {
      let actual;
      try { actual = { id: derive(label, fallback, new Set(taken), maxChars) }; }
      catch { actual = { error: true }; }
      assert.deepEqual(actual, expect, name);
      return vector(name, { label, fallback, taken, maxChars }, expect);
    }),
    'derive/slug.json': CASES.map(([name, label, fallback, taken]) => vector(name, { label, fallback, taken }, { id: derive(label, fallback, new Set(taken)) })),
  };
}
