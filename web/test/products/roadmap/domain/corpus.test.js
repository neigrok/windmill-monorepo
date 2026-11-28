import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { RoadmapRules } from '../../../../src/products/roadmap/domain/ruleBook.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { Contract, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';
import { roadmapBook, runAction, runRead, runScene } from './vectors.js';

const READS = ['account', 'activity', 'board', 'diagnostics', 'effects', 'graph', 'guides', 'landing', 'legend', 'pointers', 'progress', 'replica', 'search'].map((name) => `${name}.json`);
const ACTIONS = ['roadmaps', 'steps', 'kinds', 'progress', 'workspace', 'landing', 'conversation', 'apply'].map((name) => `${name}-actions.json`);
// A turn's records beyond its opening and end run in turnRecords.test.js.
const TURN = ['turn-records-actions.json'];
const SCENES = ['undo.json'];
const PINNED = ['rules.json', 'values.json'];

test('every file of the roadmap corpus is claimed', () => {
  const files = readdirSync(new URL('../../../../../packages/api-contract/roadmap/domain/', import.meta.url)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, [...READS, ...ACTIONS, ...TURN, ...SCENES, ...PINNED].sort());
});

for (const file of READS) {
  for (const vector of Contract.vectors(`roadmap/domain/${file}`)) {
    test(`${file}: ${vector.name}`, () => assert.deepEqual(runRead(vector.input), vector.expect));
  }
}

for (const file of ACTIONS) {
  for (const vector of Contract.vectors(`roadmap/domain/${file}`)) {
    test(`${file}: ${vector.name}`, () => {
      assert.deepEqual(runAction(vector), vector.expect);
      assert.deepEqual(runAction({ ...vector, input: withRecordsReversed(vector.input) }), vector.expect, 'the records in reverse');
    });
  }
}

const corpus = new ProductCorpus(roadmapBook, RoadmapRules.spec);
for (const vector of Contract.vectors('roadmap/domain/values.json')) {
  test(`values.json: ${vector.name}`, () => assert.deepEqual(corpus.value(vector), vector.expect));
}

for (const file of SCENES) {
  for (const vector of Contract.vectors(`roadmap/domain/${file}`)) {
    test(`${file}: ${vector.name}`, async () => assert.deepEqual(await runScene(vector), vector.expect));
  }
}
