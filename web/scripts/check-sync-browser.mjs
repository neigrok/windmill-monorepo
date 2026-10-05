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
for (const chunk of chunks) {
  assert.ok(!chunk.code.includes('__vite-browser-external'), 'browser engine imports a Node builtin');
  assert.ok(!/\bBuffer\b|\bfrom\s*["']node:/.test(chunk.code), 'browser engine requires Node');
}
console.log(`Sync browser bundle: ${chunks.length} chunk(s), no Node builtins`);
