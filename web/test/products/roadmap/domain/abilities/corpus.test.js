// @ts-check
// The one runner of Roadmap Coach's ability vectors (`packages/api-contract/roadmap/abilities/`): each case's call through
// its ability over the case's roadmaps, its answer compared whole by canonical text.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Catalog, JsonSchema } from '../../../../../src/platform/domain-kit/abilities.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {{ case: string, about: string | null, given: import('../../../../../src/products/roadmap/domain/abilities/standing.js').Standing, call: { name: string, input: any }, expect: any }} AbilityCase */

const catalog = new Catalog(Contract.json('roadmap/catalog.json'));
const files = Contract.files('roadmap/abilities').filter((path) => path.endsWith('.json'));
const readFiles = Object.keys(ReadAbilities).map((name) => `roadmap/abilities/${name}.json`);
// The direct writes and the proposal have no executor on the web yet.
const unclaimed = files.filter((path) => !readFiles.includes(path));

/** @param {string} path @returns {AbilityCase[]} */
function cases(path) {
  return /** @type {AbilityCase[]} */ (Contract.json(path));
}

test('every read ability of the catalog runs, every read answers within its cap, and every read file is claimed', () => {
  const reads = catalog.abilities.filter((ability) => ability.kind === 'read');
  assert.deepEqual(reads.map((ability) => ability.name).sort(), Object.keys(ReadAbilities).sort());
  assert.deepEqual(reads.map((ability) => /** @type {{ maxBytes?: number }} */ (ability.result).maxBytes), reads.map(() => MAX_BYTES));
  assert.deepEqual(files.filter((path) => readFiles.includes(path)), [...readFiles].sort());
  assert.deepEqual(unclaimed, ['connect', 'rename_node', 'set_progress', 'annotate_node', 'create_node', 'propose_roadmap_change']
    .map((name) => `roadmap/abilities/${name}.json`).sort(), 'only the direct writes and the proposal go unclaimed');
});

for (const path of readFiles) {
  for (const each of cases(path)) {
    test(`${path} · ${each.case}`, () => {
      const ability = /** @type {(standing: any, input: any, about: string | null) => any} */ (ReadAbilities[/** @type {keyof typeof ReadAbilities} */ (each.call.name)]);
      const answer = ability(each.given, each.call.input, each.about);
      assert.equal(jcs(answer), jcs(each.expect));
      if (!('result' in answer)) return;
      const schema = /** @type {any} */ (catalog.ability(each.call.name)?.result);
      assert.equal(new JsonSchema(schema).fault(answer.result), null, 'the answer stands inside the ability\'s result schema');
      assert.ok(jcsBytes(answer.result).length <= MAX_BYTES);
    });
  }
}

test('the corpus\'s read cases, counted by ability', (t) => {
  const counted = readFiles.map((path) => `${path.slice('roadmap/abilities/'.length, -'.json'.length)} ${cases(path).length}`);
  t.diagnostic(`roadmap abilities: ${readFiles.length} read files claimed (${counted.join(', ')}), ${unclaimed.length} write files unclaimed`);
});
