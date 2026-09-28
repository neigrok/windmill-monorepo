import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { jcs } from '../../core/jcs.js';
import { principalOf } from '../../server/credentials.js';

test('envelope/credentials.json replays through principalOf', () => {
  for (const { name, input, expect } of JSON.parse(readFileSync(new URL('../../../corpus/envelope/credentials.json', import.meta.url), 'utf8'))) {
    assert.equal(jcs(principalOf(input.headers, input.sessions)), jcs(expect.principal), name);
  }
});
