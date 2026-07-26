// The store-only ZIP writer contract: the byte structure a reader relies on (local
// headers, a known CRC32, the central directory, the end-of-central-directory record)
// and the ultimate proof — a stock `unzip` accepts the archive and hands the files back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeZip } from '../../../../src/products/roadmap/paste/storeZip.js';

const HELLO = 'hello world'; // CRC32 0x0d4a1185
const FOX = 'The quick brown fox jumps over the lazy dog'; // CRC32 0x414fa339

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

function bytes(files) {
  const out = storeZip(files);
  return { out, view: new DataView(out.buffer), text: (from, len) => new TextDecoder().decode(out.subarray(from, from + len)) };
}

test('the local file header carries the store signature, a real CRC32, the name, and the raw bytes', () => {
  const { out, view, text } = bytes([{ name: 'hello.txt', text: HELLO }]);

  assert.equal(view.getUint32(0, true), LOCAL_SIG);
  assert.equal(view.getUint16(4, true), 20); // version needed
  assert.equal(view.getUint16(8, true), 0); // method: store
  assert.equal(view.getUint32(14, true), 0x0d4a1185); // CRC32 of "hello world"
  assert.equal(view.getUint32(18, true), HELLO.length); // compressed size == raw size
  assert.equal(view.getUint32(22, true), HELLO.length); // uncompressed size
  assert.equal(view.getUint16(26, true), 'hello.txt'.length); // filename length
  assert.equal(text(30, 'hello.txt'.length), 'hello.txt');
  assert.equal(text(30 + 'hello.txt'.length, HELLO.length), HELLO);
  assert.equal(out.length, 30 + 9 + 11 + 46 + 9 + 22); // local + name + data + central + name + eocd
});

test('the central directory and end record close the archive, one entry per file', () => {
  const { out, view } = bytes([{ name: 'hello.txt', text: HELLO }, { name: 'fox.txt', text: FOX }]);

  const end = out.length - 22;
  assert.equal(view.getUint32(end, true), END_SIG);
  assert.equal(view.getUint16(end + 8, true), 2); // records on this disk
  assert.equal(view.getUint16(end + 10, true), 2); // total records

  const centralStart = view.getUint32(end + 16, true);
  const centralBytes = view.getUint32(end + 12, true);
  assert.equal(centralStart + centralBytes, end); // the directory sits flush against the end record
  assert.equal(view.getUint32(centralStart, true), CENTRAL_SIG);
  assert.equal(view.getUint32(centralStart + 16, true), 0x0d4a1185); // first entry's CRC32
  assert.equal(view.getUint32(centralStart + 42, true), 0); // first entry's local-header offset

  const secondCentral = centralStart + 46 + 'hello.txt'.length;
  assert.equal(view.getUint32(secondCentral, true), CENTRAL_SIG);
  assert.equal(view.getUint32(secondCentral + 16, true), 0x414fa339); // second entry's CRC32
});

test('a stock `unzip` accepts the archive and hands every file back verbatim', () => {
  const out = storeZip([{ name: 'hello.txt', text: HELLO }, { name: 'nested/fox.txt', text: FOX }]);
  const dir = mkdtempSync(join(tmpdir(), 'storezip-'));
  const archive = join(dir, 'out.zip');
  try {
    writeFileSync(archive, out);
    execFileSync('unzip', ['-t', archive]); // CRC integrity check — throws on a bad archive
    assert.equal(execFileSync('unzip', ['-p', archive, 'hello.txt']).toString(), HELLO);
    assert.equal(execFileSync('unzip', ['-p', archive, 'nested/fox.txt']).toString(), FOX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
