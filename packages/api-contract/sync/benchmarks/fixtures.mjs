import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry, serverState, productScope, treeScope } from '../reference/vectors/fixtures.js';
import { checkId } from '../reference/core/values.js';

export function makeFixtures() {
  const stamp = '1000:0:r_aaaaaaaaaaaa';
  const board = (i) => `b_${i.toString(16).padStart(8, '0')}`;
  const row = (delta) => ({ ...delta, seq: 1, rc: 1000, ru: 1000 });
  const boardRow = (id) => row({ t: 'board', id, born: stamp, life: ['alive', stamp] });
  const tag = (i) => row({ t: 'tag', id: `step${i}`, born: stamp, life: ['alive', stamp], f: { label: [`Step ${i}`, stamp] } });
  const links = Array.from({ length: 20000 }, (_, i) => row({ t: 'link', id: [`step${i % 10000}`, `step${(i + 1 + Math.floor(i / 10000)) % 10000}`], life: ['alive', stamp] }));
  const largeRows = [...Array.from({ length: 10000 }, (_, i) => tag(i)), ...links];
  for (const item of largeRows) assert.equal(checkId(registry, registry.type(item.t), item.id), null);
  const files = {};
  for (const scenario of ['large', 'many', 'pending']) {
    const ids = Array.from({ length: scenario === 'many' ? 500 : scenario === 'large' ? 1 : 0 }, (_, i) => board(i + 1));
    const scopes = ids.length ? { 'acct:A/probe': productScope() } : {};
    const rows = ids.length ? { 'acct:A/probe': ids.map(boardRow) } : {};
    for (const id of ids) {
      scopes[`tree:${id}`] = treeScope('A', id);
      rows[`tree:${id}`] = scenario === 'many' ? [tag(0)] : largeRows;
    }
    files[`${scenario}.json`] = serverState({ scopes, rows });
  }
  const groups = [{ scope: 'self/probe', rows: [boardRow(board(1))] },
    ...Array.from({ length: 10000 }, (_, i) => ({ scope: `tree/${board(1)}`, rows: [largeRows[i], links[i], links[i + 10000]] }))];
  const entries = groups.map(({ scope, rows }, i) => ({ localId: `seed${i}/0`, gestureId: `seed${i}`, lineage: 'anon', scope,
    state: 'ready', commitOrder: i + 1, releaseAt: 0, stamp,
    intent: { scope, d: rows.map(({ seq, rc, ru, ...delta }) => delta), gestureId: `seed${i}` } }));
  files['pending-entries.json'] = entries;
  files['manifest.json'] = {
    format: 1, account: 'A', product: 'self/probe', tree: 'tree/b_00000001',
    scenarios: {
      large: { deviceRecords: 30000, serverRecords: 30001, boards: 1, followedScopes: 3, pendingEntries: 0 },
      many: { deviceRecords: 1, serverRecords: 1000, boards: 500, followedScopes: 1001, pendingEntries: 0 },
      pending: { deviceRecords: 30000, serverRecords: 0, boards: 1, followedScopes: 3, pendingEntries: 10001 },
    },
  };
  assert.equal(new Set(largeRows.map((record) => JSON.stringify([record.t, record.id]))).size, 30000);
  assert.equal(entries.length, 10001);
  for (const [scenario, expected] of Object.entries(files['manifest.json'].scenarios)) {
    assert.equal(Object.values(files[`${scenario}.json`].rows ?? {}).reduce((count, rows) => count + rows.length, 0), expected.serverRecords);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('usage: node fixtures.mjs OUTPUT_DIRECTORY');
  mkdirSync(output, { recursive: true });
  const files = makeFixtures();
  for (const [name, value] of Object.entries(files)) writeFileSync(join(output, name), JSON.stringify(value) + '\n');
  console.log(JSON.stringify({ output: resolve(output), ...files['manifest.json'] }));
}
