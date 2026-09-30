// live/death.json: §6.8 the frame a subscriber receives when its scope dies, which answers as a pull of
// the scope would (§6.7 step 1); an overlay never written sends none.

import { deathFrameFor } from '../server/pull.js';
import { scopeKeyOf } from '../server/access.js';
import { ServerState } from '../server/state.js';
import { overlayScope, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';

const BOARD = 'b_00000001';

// A's public board, deleted: its tree and the overlays A and B wrote died with it. C never wrote one.
function deadTree() {
  const dead = { state: 'dead', deadAt: 9000 };
  return serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      [`tree:${BOARD}`]: treeScope('A', BOARD, dead),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD, dead),
      [`acct:B/overlay/${BOARD}`]: overlayScope('B', BOARD, dead),
    },
    rows: {
      'acct:A/probe': [row({ t: 'board', id: BOARD, life: ['dead', st(9000)], born: st(2000), seq: 2 })],
      [`tree:${BOARD}`]: [row({ t: 'meta', id: 'meta', f: { title: ['Open', st(2000)], visibility: ['public', '2500:0:srv'] }, seq: 1 })],
      [`acct:A/overlay/${BOARD}`]: [row({ t: 'mark', id: 'oak', f: { done: [true, st(2400)] }, seq: 1 })],
      [`acct:B/overlay/${BOARD}`]: [row({ t: 'mark', id: 'oak', f: { done: [true, st(2600, 0, 'r_bbbbbbbbbbbb')] }, seq: 1 })],
    },
  });
}

function died(name, { state, account, scope }) {
  const target = scopeKeyOf(registry, scope, account);
  return vector(name, { state, account, scope }, { frame: deathFrameFor(new ServerState(state), target.key, account) });
}

function deaths() {
  const state = deadTree();
  return [
    died('a dead tree is gone to its owner', { state, account: 'A', scope: `tree/${BOARD}` }),
    died('a dead tree is not-found to another reader', { state, account: 'B', scope: `tree/${BOARD}` }),
    died('the tree owner\'s overlay is gone to the owner', { state, account: 'A', scope: `self/overlay/${BOARD}` }),
    died('another account\'s overlay answers as the tree does to it: not-found', { state, account: 'B', scope: `self/overlay/${BOARD}` }),
    died('an overlay never written sends no frame', { state, account: 'C', scope: `self/overlay/${BOARD}` }),
  ];
}

export function files() {
  return { 'live/death.json': deaths() };
}
