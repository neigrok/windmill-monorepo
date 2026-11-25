// @ts-check
// The one runner of Roadmap Coach's ability vectors (`packages/api-contract/roadmap/abilities/`): each case's call through
// its ability over the case's roadmaps, and each context case through the context, its answer compared whole by
// canonical text.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Catalog, JsonSchema } from '../../../../../src/platform/domain-kit/abilities.js';
import { ContextBounds, readContext } from '../../../../../src/products/roadmap/domain/abilities/context.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../../src/products/roadmap/domain/abilities/standing.js').Standing} Standing */
/** @typedef {{ case: string, about: string | null, given: Standing, call: { name: string, input: any }, expect: any }} AbilityCase */
/** @typedef {{ case: string, about: string | null, step: string | null, given: Standing, expect: any }} ContextCase */

const catalog = new Catalog(Contract.json('roadmap/catalog.json'));
const files = Contract.files('roadmap/abilities').filter((path) => path.endsWith('.json'));
const readFiles = Object.keys(ReadAbilities).map((name) => `roadmap/abilities/${name}.json`);
const contextFile = 'roadmap/abilities/context.json';
// The direct writes and the proposal have no executor on the web yet.
const unclaimed = files.filter((path) => !readFiles.includes(path) && path !== contextFile);

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

test('every read ability of the catalog runs, every read answers within its cap, and every read file and the context are claimed', () => {
  const reads = catalog.abilities.filter((ability) => ability.kind === 'read');
  assert.deepEqual(reads.map((ability) => ability.name).sort(), Object.keys(ReadAbilities).sort());
  assert.deepEqual(reads.map((ability) => /** @type {{ maxBytes?: number }} */ (ability.result).maxBytes), reads.map(() => MAX_BYTES));
  assert.deepEqual(files.filter((path) => readFiles.includes(path) || path === contextFile), [...readFiles, contextFile].sort());
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

for (const each of contextCases) {
  test(`${contextFile} · ${each.case}`, () => {
    assert.equal(jcs(readContext(spelled(each.given), { about: each.about, step: each.step })), jcs(each.expect));
  });
}

test('the corpus\'s read cases, counted by ability, and the size of each context', (t) => {
  const counted = readFiles.map((path) => `${path.slice('roadmap/abilities/'.length, -'.json'.length)} ${cases(path).length}`);
  t.diagnostic(`roadmap abilities: ${readFiles.length} read files claimed (${counted.join(', ')}), ${unclaimed.length} write files unclaimed`);
  for (const each of contextCases) {
    if (!('result' in each.expect)) continue;
    const { step, ...told } = each.expect.result;
    const bytes = jcsBytes(told).length;
    t.diagnostic(`context: ${bytes} bytes (${(bytes / ContextBounds.bytes * 100).toFixed(1)}% of CONTEXT_BYTES)${step ? ` and ${jcsBytes(step).length} of its step` : ''}, `
      + `${told.steps?.length ?? told.trees?.length} ${told.trees ? 'roadmaps' : `lines${told.counts ? ` of ${told.counts.total} steps` : ''}`} · ${each.case.slice(0, 72)}`);
  }
});
