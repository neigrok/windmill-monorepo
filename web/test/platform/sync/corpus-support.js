import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const corpus = new URL('../../../../packages/api-contract/sync/corpus/', import.meta.url);
export const claims = new Map();
export const load = (path) => JSON.parse(readFileSync(new URL(path, corpus), 'utf8'));
export function claim(path, count = load(path).length) {
  assert.ok(!claims.has(path), `duplicate claim: ${path}`);
  assert.ok(count > 0, `empty corpus: ${path}`);
  claims.set(path, count);
}
