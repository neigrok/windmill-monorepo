import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';
import { decideAct, readScope } from './vectors.js';
import { turnRecordAct, turnRecordRead } from './turnRecordsVectors.js';

// A Coach turn's records beyond its opening, end and withdrawal (turn-records-actions.json): each case by its complete
// result, with its records in reverse too.
for (const vector of Contract.vectors('roadmap/domain/turn-records-actions.json')) {
  const run = (/** @type {any} */ scene) => (scene.input.read === undefined ? decideAct(scene, turnRecordAct(scene.input)) : turnRecordRead(scene, readScope));
  test(`turn-records-actions.json: ${vector.name}`, () => {
    assert.deepEqual(run(vector), vector.expect);
    assert.deepEqual(run({ ...vector, input: withRecordsReversed(vector.input) }), vector.expect, 'the records in reverse');
  });
}
