import test from 'node:test';
import assert from 'node:assert/strict';
import { compareText } from '../../../src/platform/domain-kit/entities.js';
import { compareBytes, utf8 } from '../../../src/platform/sync/core/encoding.js';

test('Text compares as its UTF-8 bytes where code-unit order differs, a lone surrogate as U+FFFD, any value as the encoder reads it', () => {
  const cases = [
    ['', '', 0],
    ['', 'a', -1],
    ['\uffff', '\u{10000}', -1],
    ['\ue000', '\u{1f600}', -1],
    ['\ud800', '\ufffd', 0],
    ['\udc00', '\ufffd', 0],
    ['\ud800x', '\u{10000}', -1],
    ['\ud800', '\u{10000}', -1],
    ['\udc00\ud800', '\ufffd\ufffd', 0],
    ['\u{10000}', '\u{10000}a', -1],
    ['\u{10ffff}', '\ufffd', 1],
    [undefined, '', 0],
    [undefined, 'a', -1],
    [null, 'null', 0],
    [7, '7', 0],
  ];
  assert.deepEqual(cases.map(([a, b]) => [a, b, compareText(a, b)]), cases);
  assert.deepEqual(cases.map(([a, b]) => [a, b, compareBytes(utf8(a), utf8(b))]), cases);
});

test('Text order agrees with the encoder\'s byte order over random BMP, astral and lone-surrogate text and its prefixes', () => {
  const pieces = ['a', 'z', '0', '~', '\u0000', '\u007f', '\u0080', '\u00e9', '\u07ff', '\u0800', '\u4e2d', '\ud7ff', '\ue000',
    '\ufffd', '\uffff', '\u{10000}', '\u{1f600}', '\u{10ffff}', '\ud800', '\udbff', '\udc00', '\udfff'];
  let state = 7;
  const draw = (/** @type {number} */ max) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const texts = Array.from({ length: 4000 }, () => Array.from({ length: draw(9) }, () => pieces[draw(pieces.length)]).join(''));
  const pairs = texts.flatMap((text, index) => [
    [text, texts[(index + 1) % texts.length] ?? ''],
    ...Array.from({ length: text.length }, (_, end) => [text.slice(0, end), text]),
    ...Array.from({ length: text.length }, (_, end) => [text, text.slice(0, end)]),
  ]);
  const disagreements = pairs.filter(([a = '', b = '']) => compareText(a, b) !== compareBytes(utf8(a), utf8(b)));
  assert.ok(pairs.length > 30000);
  assert.deepEqual(disagreements, []);
  assert.deepEqual([...texts].sort(compareText), [...texts].sort((a, b) => compareBytes(utf8(a), utf8(b))));
});
