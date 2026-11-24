// @ts-check
// The one runner of Roadmap Coach's ability vectors (`packages/api-contract/roadmap/abilities/`): each case's call through
// its ability over the case's roadmaps, its answer compared whole by canonical text. A direct write draws its new ids from
// the case's `ids`, in order.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Catalog, JsonSchema } from '../../../../../src/platform/domain-kit/abilities.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { WriteAbilities } from '../../../../../src/products/roadmap/domain/abilities/writes.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {{ case: string, about: string | null, given: import('../../../../../src/products/roadmap/domain/abilities/standing.js').Standing & { ids?: string[] }, call: { name: string, input: any }, expect: any }} AbilityCase */

const catalog = new Catalog(Contract.json('roadmap/catalog.json'));
const abilities = /** @type {Record<string, (standing: any, input: any, about: string | null, ids: () => string) => any>} */ ({ ...ReadAbilities, ...WriteAbilities });
const files = Contract.files('roadmap/abilities').filter((path) => path.endsWith('.json'));
const claimed = Object.keys(abilities).map((name) => `roadmap/abilities/${name}.json`);
// The proposal has no executor on the web yet.
const unclaimed = files.filter((path) => !claimed.includes(path));

/** @param {string} path @returns {AbilityCase[]} */
function cases(path) {
  return /** @type {AbilityCase[]} */ (Contract.json(path));
}

test('every ability of the catalog that runs on the copy runs, every read answers within its cap, and every file but the proposal\'s is claimed', () => {
  const runs = catalog.abilities.filter((ability) => ability.agent === 'runs');
  assert.deepEqual(runs.map((ability) => ability.name).sort(), Object.keys(abilities).sort());
  assert.deepEqual(Object.keys(ReadAbilities).sort(), runs.filter((ability) => ability.kind === 'read').map((ability) => ability.name).sort());
  const reads = catalog.abilities.filter((ability) => ability.kind === 'read');
  assert.deepEqual(reads.map((ability) => /** @type {{ maxBytes?: number }} */ (ability.result).maxBytes), reads.map(() => MAX_BYTES));
  assert.deepEqual(files.filter((path) => claimed.includes(path)), [...claimed].sort());
  assert.deepEqual(unclaimed, ['roadmap/abilities/propose_roadmap_change.json'], 'only the proposal goes unclaimed');
});

for (const path of claimed) {
  for (const each of cases(path)) {
    test(`${path} · ${each.case}`, () => {
      const minted = [...(each.given.ids ?? [])];
      const ids = () => {
        const id = minted.shift();
        assert.ok(id !== undefined, 'the call draws no more ids than the case gives');
        return id;
      };
      const answer = abilities[each.call.name]?.(each.given, each.call.input, each.about, ids);
      assert.equal(jcs(answer), jcs(each.expect));
      if (!('result' in answer)) return;
      const schema = /** @type {any} */ (catalog.ability(each.call.name)?.result);
      assert.equal(new JsonSchema(schema).fault(answer.result), null, 'the answer stands inside the ability\'s result schema');
      assert.ok(jcsBytes(answer.result).length <= (schema.maxBytes ?? MAX_BYTES));
    });
  }
}

test('the corpus\'s cases, counted by ability', (t) => {
  const counted = claimed.map((path) => `${path.slice('roadmap/abilities/'.length, -'.json'.length)} ${cases(path).length}`);
  t.diagnostic(`roadmap abilities: ${claimed.length} files claimed (${counted.join(', ')}), ${unclaimed.length} unclaimed`);
});
