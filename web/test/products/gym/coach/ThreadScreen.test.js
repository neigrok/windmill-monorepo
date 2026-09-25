import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// The room a screen is drawn inside: it must carry the withheld window, because every screen here
// draws around what the window is holding.
const quiet = roomLog();

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
    const path = url.slice(`${API_BASE}/v1/gym`.length).split('?')[0];
    const method = options.method ?? 'GET';
    if (path === '/threads/thr_1' && method === 'GET') return { ok: true, status: 200, json: async () => stored };
    throw new Error(`unexpected ${method} ${path}`);
  };
}

test('legacy thread proposal references render the shared inline proposal panel', async (t) => {
  browserWith();
  const { ThreadDetail } = await loadScreen('products/gym/coach/Threads.jsx');
  threadOnTheWire(thread());
  const screen = renderHook(t, () => ThreadDetail({ id: 'thr_1', log: quiet }));
  await settle();
  const { elementsOf } = await import('../harness.mjs');
  const panels = elementsOf(screen.tree).filter((element) => element.type?.name === 'ProposalPanel');
  assert.deepEqual(panels.map((panel) => panel.props.id), ['prop_1']);
  assert.equal(findByClass(screen.tree, 'gym-history-row').length, 0);
});

test('history pages beyond 200 conversations using the server cursor and retains row identity', async (t) => {
  browserWith();
  const all = Array.from({ length: 251 }, (_, index) => ({ id: `thr_${index}`, title: `Question ${index}`, askedAt: 1_755_000_000_000 - index }));
  const requests = [];
  global.fetch = async (url) => {
    const page = new URL(url).searchParams;
    const cursor = Number(page.get('cursor') ?? 0);
    requests.push({ limit: page.get('limit'), cursor: page.get('cursor') });
    const end = cursor + 50;
    return { ok: true, status: 200, json: async () => ({ threads: all.slice(cursor, end), nextCursor: end < all.length ? String(end) : null }) };
  };
  const { ThreadsList } = await loadScreen('products/gym/coach/Threads.jsx');
  const screen = renderHook(t, () => ThreadsList({ log: roomLog() }));
  await settle();
  for (let page = 0; page < 5; page += 1) {
    await findByClass(screen.tree, 'gym-coach-older')[0].props.onClick();
  }
  const { elementsOf } = await import('../harness.mjs');
  const rows = elementsOf(screen.tree).filter((element) => element.type?.name === 'ThreadRow');
  assert.deepEqual(rows.map((row) => row.props.thread), all);
  assert.deepEqual(requests, [null, '50', '100', '150', '200', '250'].map((cursor) => ({ limit: '50', cursor })));
  assert.equal(findByClass(screen.tree, 'gym-coach-older').length, 0);
});
