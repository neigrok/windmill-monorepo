import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, findByClass, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const quiet = { catalog: [], session: null, say: () => {} };

function thread(over = {}) {
  return {
    id: 'thr_1',
    title: 'Heavier bench?',
    createdAt: 1_755_000_000_000,
    askedAt: 1_755_000_000_000,
    outcome: { kind: 'proposed', changes: 2, routineId: 'rt_push', routine: 'Push A' },
    proposals: [{ id: 'prop_1', state: 'pending', changeCount: 2, routineId: 'rt_push', routine: 'Push A', createdAt: 1_755_000_000_000 }],
    turns: [
      { from: 'lifter', text: 'Heavier bench?', at: 1_755_000_000_000 },
      { from: 'ask', text: 'Triples at 90.', at: 1_755_000_001_000 },
    ],
    ...over,
  };
}

function threadOnTheWire(stored) {
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    if (path === '/threads/thr_1' && method === 'GET') return { ok: true, status: 200, json: async () => stored };
    throw new Error(`unexpected ${method} ${path}`);
  };
}

test('a stored thread’s pending proposal row reads still waiting, before the review opens and after it closes', async (t) => {
  browserWith();
  const { ThreadDetail } = await loadScreen('products/gym/coach/Threads.jsx');
  threadOnTheWire(thread());
  const screen = renderHook(t, () => ThreadDetail({ id: 'thr_1', log: quiet }));
  await settle();
  const line = () => textOf(findByClass(screen.tree, 'gym-history-line')[0]);
  assert.equal(line(), '2 changes to Push A · still waiting');
  const row = findByClass(screen.tree, 'gym-history-row')[0];
  row.props.onClick({ preventDefault() {} });
  assert.equal(findByClass(screen.tree, 'gym-history-line').length, 1);
  const review = screen.tree.props.children.find((child) => child && typeof child.type === 'function' && child.type.name === 'ProposalReview');
  assert.ok(review, 'the review opens over the thread');
  review.props.onClose();
  assert.equal(line(), '2 changes to Push A · still waiting', 'closing decides nothing and the row says so');
  assert.equal(line().includes('pending'), false);
});

test('a settled proposal row reads its state, in the chip’s words', async (t) => {
  browserWith();
  const { ThreadDetail } = await loadScreen('products/gym/coach/Threads.jsx');
  threadOnTheWire(thread({
    outcome: { kind: 'applied', changes: 2, routineId: 'rt_push', routine: 'Push A' },
    proposals: [
      { id: 'prop_1', state: 'applied', changeCount: 2, routineId: 'rt_push', routine: 'Push A', createdAt: 1_755_000_000_000 },
      { id: 'prop_0', state: 'dismissed', changeCount: 1, routineId: 'rt_push', routine: 'Push A', createdAt: 1_754_000_000_000 },
    ],
  }));
  const screen = renderHook(t, () => ThreadDetail({ id: 'thr_1', log: quiet }));
  await settle();
  assert.deepEqual(findByClass(screen.tree, 'gym-history-line').map(textOf), [
    '2 changes to Push A · applied',
    '1 change to Push A · turned down',
  ]);
});
