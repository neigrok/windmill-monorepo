import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const web = new URL('../../../src/platform/sync/', import.meta.url);
const reference = new URL('../../../../packages/api-contract/sync/reference/', import.meta.url);
const files = (root) => ['core', 'client'].flatMap((dir) => readdirSync(new URL(`${dir}/`, root), { recursive: true }).filter((name) => name.endsWith('.js')).map((name) => `${dir}/${name}`)).sort();
const ported = files(web).filter((path) => !['core/encoding.js', 'core/content.js'].includes(path));
const byteImports = ['core/derive.js', 'core/jcs.js', 'core/values.js', 'core/wire.js'];
const hashImport = (path) => ["import { createHash } from 'node:crypto';", `import { hashText } from '${path}encoding.js';`];
// Exact browser shims: UTF-8, byte order, base64url, SHA-256, and the omitted registry file loader.
const shims = {
  'core/derive.js': [["Buffer.from(label, 'utf8')", 'utf8(label)']],
  'core/jcs.js': [["Buffer.from(jcs(value), 'utf8')", 'utf8(jcs(value))'], ['Buffer.compare(jcsBytes(a), jcsBytes(b))', 'compareBytes(jcsBytes(a), jcsBytes(b))']],
  'core/values.js': [["Buffer.byteLength(text, 'utf8')", 'utf8(text).length']],
  'core/digest.js': [hashImport('./'), ["createHash('sha256').update(jcs(row), 'utf8').digest('hex')", 'hashText(jcs(row))']],
  'client/lifecycle.js': [hashImport('../core/'), ["createHash('sha256').update(jcs(rows[key])).digest('hex')", 'hashText(jcs(rows[key]))']],
  'core/registry.js': [["import { readFileSync } from 'node:fs';\n", ''], ["  static fromFile(path) {\n    return new Registry(JSON.parse(readFileSync(path, 'utf8')));\n  }\n\n", '']],
  'core/wire.js': [hashImport('./'), ["createHash('sha256').update(jcs(intent), 'utf8').digest('hex')", 'hashText(jcs(intent))'],
    ["Buffer.byteLength(jcs(request), 'utf8')", 'utf8(jcs(request)).length'], ["Buffer.byteLength(id, 'utf8')", 'utf8(id).length'],
    ["Buffer.from(jcs(cursor), 'utf8').toString('base64url')", 'encode64(jcs(cursor))'], ["Buffer.from(text, 'base64url').toString('utf8')", 'decode64(text)']],
};

test('the browser ports every reference core and client file', () => assert.deepEqual(ported, files(reference)));
for (const path of ported) {
  test(`reference parity: ${path}`, () => {
    let expected = readFileSync(new URL(path, reference), 'utf8');
    if (byteImports.includes(path)) expected = "import { utf8, compareBytes, encode64, decode64 } from './encoding.js';\n\n" + expected;
    for (const [before, after] of shims[path] ?? []) {
      assert.equal(expected.split(before).length, 2, `${path}: exact shim occurs once: ${before}`);
      expected = expected.replace(before, after);
    }
    assert.equal(readFileSync(new URL(path, web), 'utf8'), expected, path);
  });
}
