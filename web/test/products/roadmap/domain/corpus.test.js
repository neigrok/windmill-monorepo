import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { runRead } from './vectors.js';

const corpus = new URL('../../../../../packages/api-contract/roadmap/domain/', import.meta.url);
for (const file of readdirSync(corpus, { recursive: true }).filter((name) => name.endsWith('.json')).sort()) {
  const cases = JSON.parse(readFileSync(new URL(file, corpus), 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length > 0, `${file} must contain cases`);
  for (const vector of cases) {
    test(`${file}: ${vector.name}`, () => {
      assert.deepEqual(runRead(vector.input), vector.expect);
    });
  }
}
