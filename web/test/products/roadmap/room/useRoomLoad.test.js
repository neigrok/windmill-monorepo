import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { until } from '../../../platform/sync/fakes.js';
import { useRoomLoad } from '../../../../src/products/roadmap/room/useRoomLoad.js';
import { HttpTreeRepository } from '../../../../src/products/roadmap/persistence/HttpTreeRepository.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';

for (const arrivesDuringRead of [false, true]) for (const startedSignedIn of [false, true]) for (const available of [false, true]) {
  test(`sign-in retries an unavailable room: ${arrivesDuringRead ? 'during' : 'after'} read, ${startedSignedIn ? 'same account lapses' : 'cold boot'}, retry ${available ? 'loads' : 'unavailable'}`, async (t) => {
    const previous = globalThis.window;
    globalThis.window = { location: { search: '', hash: '#/app/t_kept' }, localStorage: { getItem: () => null, setItem() {} } };
    t.after(() => { globalThis.window = previous; });
    let accountId = startedSignedIn ? 'A' : null;
    let reads = 0;
    let finishFirst;
    const pendingFirst = new Promise((resolve) => { finishFirst = resolve; });
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ user: accountId ? { id: accountId } : null }) }));
    t.mock.method(HttpTreeRepository.prototype, 'loadTree', async () => {
      reads++;
      if (reads === 1) { await pendingFirst; return null; }
      if (!available) return null;
      return { id: 't_kept', title: 'Kept roadmap', nodes: [], mine: true };
    });
    t.mock.method(HttpTreeRepository.prototype, 'loadProgress', async () => ({ completed: new Set(), completedAt: {} }));
    t.mock.method(HttpTreeRepository.prototype, 'loadActivity', async () => []);
    t.mock.method(SyncSession.prototype, 'start', function () { return this; });
    const handle = (current = null) => ({ current });
    const nothing = () => {};
    const scene = new Proxy({}, { get: () => nothing });
    const props = {
      treeId: 't_kept', demo: false, shared: false, demotion: null, breakpoint: 'desktop', placeKept: false,
      room: { sceneRef: handle(scene), sessionRef: handle(), projectionRef: handle(), treeRef: handle(), seedRef: handle(), peersRef: handle(new Map()) },
      scene: null, framing: { firstFrameRef: handle(), insetsRef: handle() }, structure: { layoutRef: handle(), layoutPositions: () => new Map(), install: nothing },
      progressActs: { adoptLoaded: nothing }, activity: { seedActivity: nothing }, legend: { hydrateLegend: nothing },
      workspace: { hydrateWorkspaces: nothing, pushArcs: nothing }, selection: { selectedId: null, selectedIdRef: handle(), setSelectedId: nothing },
      dismissToast: nothing, desktopEditorRef: handle(false), onRemoteProgress: nothing,
    };
    const view = renderHook(t, () => useRoomLoad({ ...props, accountId }));
    await until(() => reads === 1);
    if (startedSignedIn) { accountId = null; view.redraw(); }
    if (arrivesDuringRead) { accountId = 'A'; view.redraw(); }
    finishFirst();
    if (!arrivesDuringRead) {
      await until(() => view.tree.loadError);
      accountId = 'A';
      view.redraw();
    }
    await until(() => reads === 2 && !view.tree.loading);
    assert.equal(reads, 2);
    assert.equal(view.tree.loadError, !available);
    assert.equal(view.tree.treeMine, available);
    assert.equal(props.room.treeRef.current?.title ?? null, available ? 'Kept roadmap' : null);
    view.redraw();
    assert.equal(reads, 2);
    if (available) {
      accountId = null; view.redraw();
      accountId = 'A'; view.redraw();
      assert.equal(reads, 2, 'an already open room reconnects without another read');
    }
  });
}
