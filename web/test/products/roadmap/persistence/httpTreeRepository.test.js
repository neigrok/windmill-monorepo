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

test('loadServerProgress is the account overlay verbatim — three arrays, credentialed', async () => {
  await withFetch(() => ok({ completed: ['a'], inProgress: ['b'], cleared: ['c'] }), async (calls) => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadServerProgress(), { completed: ['a'], inProgress: ['b'], cleared: ['c'] });
    assert.deepEqual(calls, [{ url: 'http://backend.test/v1/trees/t_1/progress', init: { credentials: 'include' } }]);
  });
});

test('loadServerProgress reads a missing key as an empty set of marks, never undefined', async () => {
  await withFetch(() => ok({ completed: ['a'] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadServerProgress(), { completed: ['a'], inProgress: [], cleared: [] });
  });
});

test('loadServerProgress answers null — not an empty overlay — when the server does not answer', async () => {
  await withFetch(() => status(401), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.equal(await repo.loadServerProgress(), null);
  });
  await withFetch(() => { throw new Error('offline'); }, async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.equal(await repo.loadServerProgress(), null);
  });
});

test('loadProgress hands back the account overlay, tombstones and all, marked server-true', async () => {
  await withFetch(() => ok({ completed: ['a'], inProgress: ['b'], cleared: ['c'] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    const progress = await repo.loadProgress(SEEDED);
    assert.deepEqual(progress, {
      completed: new Set(['a']),
      inProgress: new Set(['b']),
      cleared: new Set(['c']),
      server: true,
    });
  });
});

test('loadProgress falls back to the document seeds when the server holds no overlay', async () => {
  await withFetch(() => ok({ completed: [], inProgress: [], cleared: [] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadProgress(SEEDED), {
      completed: new Set(['a']),
      inProgress: new Set(['b']),
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
      server: false,
    });
  });
});

test('a lone cleared tombstone is still an overlay — it must not read as "the server knows nothing"', async () => {
  await withFetch(() => ok({ completed: [], inProgress: [], cleared: ['a'] }), async () => {
    const repo = new HttpTreeRepository({ baseUrl: BASE, treeId: 't_1' });
    assert.deepEqual(await repo.loadProgress(SEEDED), {
      completed: new Set(),
      inProgress: new Set(),
      cleared: new Set(['a']),
      server: true,
    });
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
