import assert from 'node:assert/strict';
import test from 'node:test';
import { accessOf, scopeKeyOf } from '../../server/access.js';
import { ServerState } from '../../server/state.js';
import { overlayScope, productScope, registry, row, serverState, treeScope } from '../../vectors/fixtures.js';

test('wire references map to server keys for the principal', () => {
  assert.deepEqual(
    ['self/probe', 'self/overlay/b_00000001', 'tree/b_00000001', 'device/probe', 'self/other', 'tree/', 'self'].map((ref) => scopeKeyOf(registry, ref, 'A')),
    [
      { key: 'acct:A/probe', kind: 'product', product: 'probe', owner: 'A' },
      { key: 'acct:A/overlay/b_00000001', kind: 'overlay', tree: 'b_00000001', owner: 'A' },
      { key: 'tree:b_00000001', kind: 'tree', tree: 'b_00000001' },
      null,
      null,
      null,
      null,
    ],
  );
  assert.deepEqual(
    ['self/probe', 'self/overlay/b_00000001', 'tree/b_00000001'].map((ref) => scopeKeyOf(registry, ref, null)),
    [null, null, { key: 'tree:b_00000001', kind: 'tree', tree: 'b_00000001' }],
  );
});

test('access follows D-4 for owner, other account and signed-out principal', () => {
  const board = 'b_00000001';
  const state = (visibility, dead) => new ServerState(serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      [`tree:${board}`]: treeScope('A', board, dead ? { state: 'dead', deadAt: 9 } : {}),
      [`acct:A/overlay/${board}`]: overlayScope('A', board, dead ? { state: 'dead', deadAt: 9 } : {}),
    },
    rows: { [`tree:${board}`]: visibility ? [row({ t: 'meta', id: 'meta', f: { visibility: [visibility, '1:0:srv'] }, seq: 1 })] : [] },
  }));
  const answers = (at) => ['A', 'B', null].map((account) => [
    accessOf(at, { kind: 'tree', key: `tree:${board}`, tree: board }, account),
    accessOf(at, { kind: 'overlay', key: `acct:${account}/overlay/${board}`, tree: board }, account),
  ]);
  assert.deepEqual(answers(state()), [
    [{ read: true, write: true }, { read: true, write: true, create: false }],
    [{ refusal: 'not-found', read: false }, { refusal: 'not-found', read: false }],
    [{ refusal: 'not-found', read: false }, { refusal: 'not-found', read: false }],
  ]);
  for (const visibility of ['unlisted', 'public']) {
    assert.deepEqual(answers(state(visibility)), [
      [{ read: true, write: true }, { read: true, write: true, create: false }],
      [{ read: true, write: false, refusal: 'forbidden' }, { read: true, write: true, create: true }],
      [{ read: true, write: false, refusal: 'forbidden' }, { read: true, write: true, create: true }],
    ]);
  }
  assert.deepEqual(answers(state('private')), answers(state()));
  assert.deepEqual(answers(state('public', true)), [
    [{ refusal: 'scope-dead', read: false, gone: true }, { refusal: 'scope-dead', read: false, gone: true }],
    [{ refusal: 'not-found', read: false, gone: false }, { refusal: 'not-found', read: false, gone: false }],
    [{ refusal: 'not-found', read: false, gone: false }, { refusal: 'not-found', read: false, gone: false }],
  ]);
  assert.deepEqual(accessOf(state(), { kind: 'product', key: 'acct:B/probe' }, 'B'), { read: true, write: true, create: true });
});
