import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const result = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    target: 'es2022',
    lib: { entry: fileURLToPath(new URL('../src/platform/sync/engine.js', import.meta.url)), formats: ['es'] },
    rollupOptions: { onwarn(warning) { throw new Error(warning.message); } },
  },
});
const chunks = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output).filter((item) => item.type === 'chunk');
assert.ok(chunks.length > 0);
const reference = fileURLToPath(new URL('../../packages/api-contract/sync/reference/', import.meta.url));
const shared = chunks.flatMap((chunk) => Object.keys(chunk.modules)).filter((path) => path.startsWith(reference))
  .map((path) => path.slice(reference.length));
assert.ok(shared.includes('core/registry.js') && shared.includes('client/commit.js'), 'browser engine must bundle the shared reference');
assert.ok(shared.every((path) => /^(core|client)\//.test(path)), 'browser engine imports a reference server or test module');
for (const chunk of chunks) {
  assert.ok(!chunk.code.includes('__vite-browser-external'), 'browser engine imports a Node builtin');
  assert.ok(!/\bBuffer\b|\bfrom\s*["']node:/.test(chunk.code), 'browser engine requires Node');
}
const bytes = chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk.code), 0);
console.log(`Sync browser bundle: ${chunks.length} chunk(s), ${shared.length} shared modules, ${bytes} bytes, no Node builtins`);
