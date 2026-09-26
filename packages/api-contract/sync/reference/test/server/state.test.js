import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { jcs } from '../../core/jcs.js';
import { ServerState } from '../../server/state.js';
import { productScope, registry, row, serverState, treeScope } from '../../vectors/fixtures.js';

test('every corpus server state survives the canonical round trip unchanged', () => {
  const dir = new URL('../../../corpus/admit/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    for (const { name, input, expect } of JSON.parse(readFileSync(new URL(file, dir), 'utf8'))) {
      for (const state of [input.state, expect.state]) assert.equal(jcs(new ServerState(state).toJSON()), jcs(state), `${file}: ${name}`);
    }
  }
});

test('the id state is none, alive, dead (kept or spent) or foreign (§4.2)', () => {
  const state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'acct:B/probe': productScope('B'), 'tree:b_000000cc': treeScope('B', 'b_000000cc') },
    rows: {
      'acct:A/probe': [
        row({ t: 'card', id: 'card0001', life: ['alive', '1:0:r_a'], born: '1:0:r_a', seq: 1 }),
        row({ t: 'board', id: 'b_000000aa', life: ['dead', '3:0:r_a'], born: '2:0:r_a', seq: 2 }),
      ],
      'acct:B/probe': [row({ t: 'card', id: 'cardbbbb', life: ['alive', '1:0:r_b'], born: '1:0:r_b', seq: 1 })],
    },
    spent: { 'acct:A/probe': [{ t: 'card', id: 'card0002', born: '4:0:r_a', lifeStamp: '5:0:r_a', seq: 3 }] },
  }));
  const of = (t, id) => state.idState(registry, 'acct:A/probe', registry.type(t), id);
  assert.deepEqual(
    [of('card', 'card0001'), of('card', 'card0002'), of('board', 'b_000000aa'), of('card', 'cardbbbb'), of('card', 'card0009'), of('board', 'b_000000cc'), of('board', 'b_000000dd')],
    [
      { state: 'alive', born: '1:0:r_a' },
      { state: 'dead', born: '4:0:r_a' },
      { state: 'dead', born: '2:0:r_a' },
      { state: 'foreign' },
      { state: 'none' },
      { state: 'foreign' },
      { state: 'none' },
    ],
  );
});

test('a kept revision list holds the newest superseded heads per field', () => {
  const state = ServerState.empty({ epoch: 'ep-1' });
  for (const rev of [1, 2, 3]) state.keepRevision('s', { t: 'mark', id: 'oak', field: 'memo', rev, text: `v${rev}` }, 2);
  state.keepRevision('s', { t: 'mark', id: 'ash', field: 'memo', rev: 1, text: 'a1' }, 2);
  assert.deepEqual(state.toJSON().revisions, {
    s: [
      { t: 'mark', id: 'ash', field: 'memo', rev: 1, text: 'a1' },
      { t: 'mark', id: 'oak', field: 'memo', rev: 2, text: 'v2' },
      { t: 'mark', id: 'oak', field: 'memo', rev: 3, text: 'v3' },
    ],
  });
});
