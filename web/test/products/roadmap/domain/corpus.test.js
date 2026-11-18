import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { PlanError } from '../../../../src/platform/domain-kit/plans.js';
import { RoadmapRules } from '../../../../src/products/roadmap/domain/ruleBook.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { Contract, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';
import { roadmapRegistry, runAction, runRead } from './vectors.js';

const READS = ['account', 'board', 'diagnostics', 'graph', 'guides', 'landing', 'legend', 'pointers', 'progress', 'search'].map((name) => `${name}.json`);
const ACTIONS = ['roadmaps', 'steps', 'kinds', 'progress', 'workspace', 'landing'].map((name) => `${name}-actions.json`);
const PINNED = ['rules.json', 'values.json'];

// The cases whose gesture creates a link: the kit refuses a keyed create that writes no field (domain kit §8.3
// rule 8), and an `edge` has no field. Each must keep failing on exactly that rule until the kit admits it.
const AWAITING_KIT = new Set([
  "roadmaps-actions.json · a new roadmap's linked first steps come with their links, a step after those it follows",
  "steps-actions.json · a step with prerequisites writes one link from each in the same intent, after its first prerequisite's steps",
  'steps-actions.json · a prerequisite deleted elsewhere is linked all the same, and its step is noted',
  'steps-actions.json · an added prerequisite is linked and noted',
  'steps-actions.json · a loop of steps deleted elsewhere alone is read without harm and admitted',
  'steps-actions.json · a paste under a step links its first steps from it, each step after those it follows',
]);

test('every file of the roadmap corpus is claimed', () => {
  const files = readdirSync(new URL('../../../../../packages/api-contract/roadmap/domain/', import.meta.url)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, [...READS, ...ACTIONS, ...PINNED].sort());
});

for (const file of READS) {
  for (const vector of Contract.vectors(`roadmap/domain/${file}`)) {
    test(`${file}: ${vector.name}`, () => assert.deepEqual(runRead(vector.input), vector.expect));
  }
}

for (const file of ACTIONS) {
  for (const vector of Contract.vectors(`roadmap/domain/${file}`)) {
    test(`${file}: ${vector.name}`, () => {
      if (AWAITING_KIT.has(`${file} · ${vector.name}`)) {
        assert.throws(() => runAction(vector), (error) => error instanceof PlanError && error.rule === 8);
        return;
      }
      assert.deepEqual(runAction(vector), vector.expect);
      assert.deepEqual(runAction({ ...vector, input: withRecordsReversed(vector.input) }), vector.expect, 'the records in reverse');
    });
  }
}

const book = new RoadmapRules(roadmapRegistry).book;
const corpus = new ProductCorpus(book, RoadmapRules.spec);
for (const vector of Contract.vectors('roadmap/domain/values.json')) {
  test(`values.json: ${vector.name}`, () => assert.deepEqual(corpus.value(vector), vector.expect));
}
