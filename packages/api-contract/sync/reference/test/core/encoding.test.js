import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compareBytes, decode64, encode64, hashText, utf8 } from '../../core/encoding.js';
import { sha256 } from '../../core/sha256.js';
import { Cursor } from '../../core/wire.js';

test('SHA-256 matches Node across padding, block and UTF-8 boundaries on repeated calls', () => {
  assert.equal(hashText(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hashText('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const texts = ['', 'abc', '\0é€😀', 'e\u0301', '\ud800', '\udc00', 'a\ud800b', 'a'.repeat(1_000_000)];
  for (let length = 0; length <= 257; length++) {
    texts.push('abcdefgh'.repeat(33).slice(0, length), `${'Ж😀'.repeat(43).slice(0, length)}é`);
  }
  for (const text of [...texts, ...texts.reverse()]) {
    assert.equal(hashText(text), createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.deepEqual(utf8(text), Uint8Array.from(Buffer.from(text, 'utf8')));
  }
});

test('SHA-256 hashes the exact byte view, including every byte value', () => {
  const bytes = Uint8Array.from({ length: 1026 }, (_, i) => i & 255);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 255, 256, 257, 1024]) {
    const view = bytes.subarray(1, length + 1);
    assert.equal(sha256(view), createHash('sha256').update(view).digest('hex'), `bytes: ${length}`);
  }
  assert.deepEqual(bytes, Uint8Array.from({ length: 1026 }, (_, i) => i & 255));
});

test('byte comparison preserves unsigned ordering, prefixes and equality', () => {
  const values = [[], [0], [0, 1], [127], [128], [255], [...utf8('דּ')], [...utf8('😀')]];
  for (const a of values) for (const b of values) {
    assert.equal(compareBytes(Uint8Array.from(a), Uint8Array.from(b)), Buffer.compare(Buffer.from(a), Buffer.from(b)));
  }
});

test('base64url matches Node for UTF-8 and rejects malformed input without retaining decoder state', () => {
  for (const text of ['a', 'ab', 'abc', '\0é€😀', 'e\u0301', 'Журнал', 'inside\ufefftext']) {
    const encoded = Buffer.from(text).toString('base64url');
    assert.equal(encode64(text), encoded);
    assert.equal(decode64(encoded), text);
  }
  for (const encoded of ['', 'A', '=', 'Zg=', 'Zg==', 'Z g', 'Zg\n', '+w', '/w', '_w', 'wA', '7aCA', '4oI']) {
    assert.throws(() => decode64(encoded), encoded);
    assert.equal(decode64('b2s'), 'ok');
  }
});

test('cursors require canonical unpadded base64url, valid UTF-8 and a valid shape', () => {
  const cursor = { e: 'ep-1', m: 'live', s: 2 };
  const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  assert.equal(Cursor.encode(cursor), encoded);
  assert.deepEqual(Cursor.decode(encoded), cursor);
  const malformedUtf8 = Buffer.concat([Buffer.from('{"e":"'), Buffer.from([255]), Buffer.from('","m":"live","s":2}')]);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const nonzeroPadding = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)) + 1];
  assert.equal(Buffer.from(nonzeroPadding, 'base64url').toString(), JSON.stringify(cursor));
  for (const text of [
    undefined, null, 1, '', 'A', `${encoded}=`, `${encoded}\n`, ` ${encoded}`, nonzeroPadding,
    malformedUtf8.toString('base64url'), encode64(`\ufeff${JSON.stringify(cursor)}`),
    encode64(JSON.stringify({ ...cursor, extra: true })), encode64(JSON.stringify({ ...cursor, s: -1 })),
    encode64(JSON.stringify({ ...cursor, m: 'boot' })), encode64('{"s":2,"m":"live","e":"ep-1"}'),
  ]) assert.equal(Cursor.decode(text), null, String(text));
  const boot = { a: 9, e: 'epoch-😀', k: ['card', ['é', '😀']], m: 'boot', s: 8 };
  assert.deepEqual(Cursor.decode(Cursor.encode(boot)), boot);
});
