import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpTreeRepository } from '../../../../src/products/roadmap/persistence/HttpTreeRepository.js';

const BASE = 'http://backend.test';

function withFetch(handler, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    return run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

const SEEDED = {
  id: 't_1',
  title: 'Learn to sail',
  nodes: [
    { id: 'a', label: 'Rigging', prerequisites: [], status: 'complete' },
    { id: 'b', label: 'Tacking', prerequisites: ['a'], status: 'active' },
    { id: 'c', label: 'Solo sail', prerequisites: ['b'] },
  ],
};

test('a repository without a tree id refuses to exist — there is no default roadmap', () => {
  assert.throws(() => new HttpTreeRepository({ baseUrl: BASE }), /requires a treeId/);
});

test('loadTree returns the document plus what the server knows about it', async () => {
  await withFetch(() => ok({ data: SEEDED, visibility: 'unlisted', mine: true, createdAt: 1700000000000 }), async (calls) => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    const tree = await repo.loadTree();
    assert.deepEqual(calls, [{ url: 'http://backend.test/v1/trees/t_1', init: { credentials: 'include' } }]);
    assert.deepEqual(tree, { ...SEEDED, visibility: 'unlisted', mine: true, createdAt: 1700000000000 });
  });
});

test('loadTree fills the three server facts a bare answer omits', async () => {
  await withFetch(() => ok({ data: SEEDED }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadTree(), { ...SEEDED, visibility: null, mine: false, createdAt: 0 });
  });
});

test('loadTree throws on a status, so the caller can fall back to the local blob', async () => {
  await withFetch(() => status(404), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    await assert.rejects(() => repo.loadTree(), /loadTree t_1: HTTP 404/);
  });
});

test('loadProgress folds the server frame into the overlay to open at, credentialed', async () => {
  const body = {
    marks: [
      { node: 'a', status: 'complete', at: '900:0:r_phone', markedAt: 1700000000000 },
      { node: 'b', status: 'active', at: '910:0:r_phone', markedAt: 1700000600000 },
      { node: 'c', status: 'none', at: '920:0:r_phone', markedAt: 1700000700000 },
    ],
  };
  await withFetch(() => ok(body), async (calls) => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadProgress(SEEDED), {
      completed: new Set(['a']),
      inProgress: new Set(['b']),      // 'c' is a cleared register: carried, and in neither set
      startedAt: { b: 1700000600000 }, // an active register is dated by when it was marked active
      completedAt: { a: 1700000000000 },
      server: true,
    });
    assert.deepEqual(calls, [{ url: 'http://backend.test/v1/trees/t_1/progress', init: { credentials: 'include' } }]);
  });
});

test('loadProgress falls back to the document seeds when the server holds no marks', async () => {
  await withFetch(() => ok({ marks: [] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadProgress(SEEDED), {
      completed: new Set(['a']),
      inProgress: new Set(['b']),
      startedAt: {},
      completedAt: {},  // an authored seed status is nobody's mark, at no instant we know
      server: false,
    });
  });
});

test('loadProgress falls back to the seeds when the server never answered at all', async () => {
  await withFetch(() => { throw new Error('offline'); }, async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadProgress(SEEDED), {
      completed: new Set(['a']),
      inProgress: new Set(['b']),
      startedAt: {},
      completedAt: {},
      server: false,
    });
  });
});

test('loadProgress falls back to the seeds on a status, rather than opening the tree blank', async () => {
  await withFetch(() => status(401), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual((await repo.loadProgress(SEEDED)).completed, new Set(['a']));
  });
});

test('a lone cleared register still reads as a real overlay, not as "the server knows nothing"', async () => {
  await withFetch(() => ok({ marks: [{ node: 'a', status: 'none', at: '900:0:r_a', markedAt: 1 }] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    const overlay = await repo.loadProgress(SEEDED);
    assert.equal(overlay.server, true);           // NOT the seeds: 'a' was cleared on purpose
    assert.deepEqual(overlay.completed, new Set());
  });
});

test('loadActivity carries the cursor and the cap, and a miss is silence, not a throw', async () => {
  await withFetch(() => ok({ events: [{ id: 'e1', verb: 'added' }] }), async (calls) => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadActivity({ since: 7, limit: 50 }), [{ id: 'e1', verb: 'added' }]);
    assert.deepEqual(calls, [{ url: 'http://backend.test/v1/trees/t_1/activity?since=7&limit=50', init: { credentials: 'include' } }]);
  });
  await withFetch(() => ok({}), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadActivity(), []);
  });
  await withFetch(() => status(500), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadActivity(), []);
  });
  await withFetch(() => { throw new Error('offline'); }, async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadActivity(), []);
  });
});
