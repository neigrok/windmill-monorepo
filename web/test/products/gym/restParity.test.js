import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectGym } from '../../../src/products/gym/syncProjections.js';

const fixture = JSON.parse(readFileSync(new URL('./rest-parity.fixture.json', import.meta.url)));
assert.equal(fixture.samples.length, 36);

for (const [index, sample] of fixture.samples.entries()) {
  test(`seeded REST parity ${index + 1}: ${sample.method} ${JSON.stringify(sample.args)}`, () => {
    const view = projectGym(fixture.rows, { now: sample.now ?? fixture.now, timeZone: fixture.timeZone });
    assert.deepEqual(view[sample.method](...sample.args), sample.expected);
  });
}
