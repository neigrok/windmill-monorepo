// derive/slug.json: D-26 derived ids.

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
    'derive/slug.json': CASES.map(([name, label, fallback, taken]) => vector(name, { label, fallback, taken }, { id: derive(label, fallback, new Set(taken)) })),
  };
}
