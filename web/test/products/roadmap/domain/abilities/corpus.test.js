// @ts-check
// The one runner of Roadmap Coach's ability vectors (`packages/api-contract/roadmap/abilities/`): each case's call through
// its ability over the case's roadmaps, and each context case through the context, its answer compared whole by
// canonical text. A direct write draws its new ids from the case's `ids`, in order.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Catalog, JsonSchema } from '../../../../../src/platform/domain-kit/abilities.js';
import { ContextBounds, readContext } from '../../../../../src/products/roadmap/domain/abilities/context.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { WriteAbilities } from '../../../../../src/products/roadmap/domain/abilities/writes.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../../src/products/roadmap/domain/abilities/standing.js').Standing} Standing */
/** @typedef {{ case: string, about: string | null, given: Standing & { ids?: string[] }, call: { name: string, input: any }, expect: any }} AbilityCase */
/** @typedef {{ case: string, about: string | null, step: string | null, given: Standing, expect: any }} ContextCase */

const catalog = new Catalog(Contract.json('roadmap/catalog.json'));
const abilities = /** @type {Record<string, (standing: any, input: any, about: string | null, ids: () => string) => any>} */ ({ ...ReadAbilities, ...WriteAbilities });
const files = Contract.files('roadmap/abilities').filter((path) => path.endsWith('.json'));
const claimed = Object.keys(abilities).map((name) => `roadmap/abilities/${name}.json`);
const contextFile = 'roadmap/abilities/context.json';
// The proposal has no executor on the web yet.
const unclaimed = files.filter((path) => !claimed.includes(path) && path !== contextFile);

/** @param {string} path @returns {AbilityCase[]} */
function cases(path) {
  return /** @type {AbilityCase[]} */ (Contract.json(path));
}

const contextCases = /** @type {ContextCase[]} */ (Contract.json(contextFile));

// A context case may give a large roadmap's steps, links and marks as a table, `{columns, rows}`, each row one record's
// values in the columns' order (the README's The context); the standing roadmap takes them spelled as records.
/** @param {Standing} given @returns {Standing} */
function spelled(given) {
  /** @param {any} records */
  const read = (records) => (Array.isArray(records) ? records
    : records.rows.map((/** @type {any[]} */ row) => Object.fromEntries(records.columns.map((/** @type {string} */ column, /** @type {number} */ at) => [column, row[at]]))));
  return { ...given, trees: given.trees.map((tree) => ({ ...tree, nodes: read(tree.nodes), edges: read(tree.edges), marks: read(tree.marks) })) };
}

test('every ability of the catalog that runs on the copy runs, every read answers within its cap, and every file but the proposal\'s is claimed, the context\'s among them', () => {
  const runs = catalog.abilities.filter((ability) => ability.agent === 'runs');
  assert.deepEqual(runs.map((ability) => ability.name).sort(), Object.keys(abilities).sort());
  assert.deepEqual(Object.keys(ReadAbilities).sort(), runs.filter((ability) => ability.kind === 'read').map((ability) => ability.name).sort());
  const reads = catalog.abilities.filter((ability) => ability.kind === 'read');
  assert.deepEqual(reads.map((ability) => /** @type {{ maxBytes?: number }} */ (ability.result).maxBytes), reads.map(() => MAX_BYTES));
  assert.deepEqual(files.filter((path) => claimed.includes(path) || path === contextFile), [...claimed, contextFile].sort());
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

for (const each of contextCases) {
  test(`${contextFile} · ${each.case}`, () => {
    assert.equal(jcs(readContext(spelled(each.given), { about: each.about, step: each.step })), jcs(each.expect));
  });
}

test('the corpus\'s cases, counted by ability, and the size of each context', (t) => {
  const counted = claimed.map((path) => `${path.slice('roadmap/abilities/'.length, -'.json'.length)} ${cases(path).length}`);
  t.diagnostic(`roadmap abilities: ${claimed.length} files claimed (${counted.join(', ')}) and the context's ${contextCases.length} cases, ${unclaimed.length} unclaimed`);
  for (const each of contextCases) {
    if (!('result' in each.expect)) continue;
    const context = each.expect.result;
    const bytes = jcsBytes(context).length;
    t.diagnostic(`context: ${bytes} bytes (${(bytes / ContextBounds.bytes * 100).toFixed(1)}% of CONTEXT_BYTES)${context.step ? `, ${jcsBytes(context.step).length} of them its step` : ''}, `
      + `${context.steps?.length ?? context.trees?.length} ${context.trees ? 'roadmaps' : `lines${context.counts ? ` of ${context.counts.total} steps` : ''}`}`
      + `${context.omitted ? `, ${context.omitted} left off` : ''}${context.tree?.guidesOmitted ? `, ${context.tree.guidesOmitted} guides given way` : ''} · ${each.case.slice(0, 72)}`);
  }
});
