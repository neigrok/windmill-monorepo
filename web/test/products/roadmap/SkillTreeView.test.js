import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';
import { BoardComposer } from '../../../src/products/roadmap/board/useBoardActs.js';
import { SkillTree } from '../../../src/products/roadmap/model/SkillTree.js';
import { BoardQuery } from '../../../src/products/roadmap/board/Board.js';
import { useEffect, useState } from 'react';
import { renderHook } from '../gym/harness.mjs';
import { deriveSyncStatus, OFFLINE_GRACE_MS, SAVING_DELAY_MS, SAVED_HOLD_MS } from '../../../src/products/roadmap/sync/status.js';
import { LINK_COPIED } from '../../../src/products/roadmap/board/copy.js';

// Run the host's actual event boundaries with injected collaborators, without starting its WebGL scene.
const source = await readFile(new URL('../../../src/products/roadmap/SkillTreeView.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'SkillTreeView.jsx', { loader: 'jsx' });
const handlers = new Map();
const identityHandlers = new Map();
function collectHandlers(code) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id.name === 'newStepFromBoard') {
      const callback = node.init.arguments[0];
      handlers.set(node.id.name, code.slice(callback.start, callback.end));
    }
    if (node.type === 'FunctionDeclaration' && node.id.name === 'useRoadmapSyncStatus') {
      identityHandlers.set(node.id.name, code.slice(node.start, node.end));
    }
    if (node.type === 'VariableDeclarator' && ['onIdentityQuery', 'shareFromRow', 'exportFromRow', 'undoGraphToast', 'revealOnGraph', 'discardSync', 'openRowActivity'].includes(node.id.name)) {
      const callback = node.init.arguments[0];
      identityHandlers.set(node.id.name, code.slice(callback.start, callback.end));
    }
    if (node.type === 'Property' && node.key.name === 'dismissInvalidatedToast') {
      identityHandlers.set('dismissInvalidatedToast', code.slice(node.value.start, node.value.end));
    }
    if (node.type === 'CallExpression' && node.callee.name === 'useEffect') {
      const callback = node.arguments[0];
      const body = code.slice(callback.start, callback.end);
      if (body.includes('insetsRef.current = insets;')) {
        identityHandlers.set('publishInsets', body);
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
}
collectHandlers(code);
for (const moved of ['room/useRowVerbs.js', 'sync/useRoomSyncNotices.js', 'ui/useGraphGeometry.js']) {
  collectHandlers(await readFile(new URL(`../../../src/products/roadmap/${moved}`, import.meta.url), 'utf8'));
}

test('the creation verb opens its composer for the owner on either view', () => {
  for (const [active, owner] of [[true, false], [true, true], [false, false], [false, true]]) {
    const calls = [];
    const open = runInNewContext(`(${handlers.get('newStepFromBoard')})`, {
      document: { activeElement: null },
      boardActive: active,
      owner,
      setBoardComposer: (draft) => calls.push(['composer', { ...draft }]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
    });
    open('verbs');
    assert.deepEqual(calls, owner ? [
      ['composer', { door: 'verbs', view: active ? 'board' : 'tree', opener: null }],
      ['event', 'roadmap_board_create', { step: 'open', door: 'verbs', view: active ? 'board' : 'graph' }],
    ] : []);
  }
});

test('the edit door belongs to the active owner detail only', () => {
  for (const [owner, id] of [[false, 'wind'], [true, 'dock'], [true, 'wind']]) {
    const calls = [];
    const composer = new BoardComposer({ owner, detailId: 'wind', composer: null,
      onOpen: (draft) => calls.push(draft) });
    composer.openEdit(id);
    assert.deepEqual(calls, owner && id === 'wind' ? [{ door: 'detail', editing: 'wind' }] : []);
  }
});

test('closing, removing or replacing an edit detail immediately excludes its composer and rejects writes', () => {
  for (const detailId of [null, 'dock', 'wind']) {
    const calls = [];
    const draft = { door: 'detail', editing: 'wind' };
    const composer = new BoardComposer({ owner: true, detailId, composer: draft,
      acts: { edit: (request) => { calls.push(request); return { ok: true }; } } });
    const request = { id: 'wind', label: 'Read the wind' };
    assert.equal(composer.shown, detailId === 'wind' ? draft : null);
    assert.deepEqual(composer.saveEdit(request), { ok: detailId === 'wind' });
    assert.deepEqual(calls, detailId === 'wind' ? [request] : []);
  }
});

test('edit save refuses a lost owner', () => {
  const composer = new BoardComposer({ owner: false, detailId: 'wind',
    composer: { door: 'detail', editing: 'wind' },
    acts: { edit: () => assert.fail('an unavailable edit must not dispatch') } });
  assert.equal(composer.shown, null);
  assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
});

test('create composers remain visible without a detail but cannot write through the edit door', () => {
  const draft = { door: 'verbs' };
  const composer = new BoardComposer({ owner: true, detailId: null, composer: draft,
    acts: { edit: () => assert.fail('a create draft must not dispatch an edit') },
    onOpen: () => assert.fail('there is no detail to edit') });
  assert.equal(composer.shown, draft);
  composer.openEdit(null);
  assert.deepEqual(composer.saveEdit({ id: 'wind' }), { ok: false });
});

test('Graph Find hands the same query to the Board and retains field focus', () => {
  for (const [boardActive, search] of [[false, 'wind'], [false, ''], [true, 'wind']]) {
    const calls = [];
    const query = new BoardQuery({ search });
    const onQuery = runInNewContext(`(${identityHandlers.get('onIdentityQuery')})`, {
      boardActive, boardQueryRef: { current: new BoardQuery() },
      setBoardQuery: (next) => calls.push(['query', next]),
      switchView: (view, options) => calls.push(['switch', view, options.keepFocus]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
    });
    onQuery(() => query);
    const handoff = !boardActive && query.searching;
    assert.deepEqual(calls, [
      ['query', query],
      ...(handoff ? [['switch', 'board', true], ['event', 'roadmap_graph_find', { step: 'handoff' }]] : []),
    ]);
  }
});

test('reader link copy treats a clipboard refusal as an outcome and discards stale async successes', async () => {
  for (const outcome of ['done', 'failed', 'left']) {
    const calls = [];
    const shareRequestRef = { current: 0 };
    const copy = runInNewContext(`(${identityHandlers.get('shareFromRow')})`, {
      owner: false, treeId: 'sail', LINK_COPIED, shareRequestRef, currentTreeIdRef: { current: 'sail' },
      graphViewRef: { current: true },
      treeShareUrl: (id) => `https://windmill.test/t/${id}`,
      navigator: { clipboard: { writeText: async (url) => {
        calls.push(['copy', url]);
        if (outcome === 'failed') throw new Error('denied');
        if (outcome === 'left') shareRequestRef.current += 1;
      } } },
      showToast: (message, props) => calls.push(['toast', message, { ...props }]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
    });
    await copy();
    assert.deepEqual(calls, [
      ['copy', 'https://windmill.test/t/sail'],
      outcome === 'failed'
        ? ['event', 'roadmap_graph_toast', { act: 'link', outcome: 'failed' }]
        : ['event', 'link_copy', {}],
      ...(outcome === 'done' ? [
        ['toast', 'Link copied', { surface: 'graph', act: 'link', holdMs: 6000 }],
        ['event', 'roadmap_graph_toast', { act: 'link', step: 'shown' }],
      ] : []),
    ]);
  }
});

test('Export uses displayed nodes through a held deletion and reports unexpected download failure', () => {
  const original = { id: 'sail', title: 'Learn to sail', kinds: [{ id: 'sky', label: 'Learn' }], nodes: [{ id: 'wind' }, { id: 'dock' }] };
  const displayed = [{ id: 'dock' }];
  const completed = new Set(['dock']);
  for (const failed of [false, true]) {
    const calls = [];
    const error = new Error('download failed');
    const exportRoadmap = runInNewContext(`(${identityHandlers.get('exportFromRow')})`, {
      phone: true, projectionRef: { current: original }, boardTree: { nodes: displayed }, completed,
      buildRoadmapExport: (tree, progress) => {
        assert.deepEqual({ ...tree }, { ...original, nodes: displayed });
        assert.equal(progress.completed, completed);
        return { name: 'sail.md', text: 'plan' };
      },
      downloadExport: (file) => {
        calls.push(['download', file]);
        if (failed) throw error;
      },
      reportRoadmapFailure: (operation, failure) => calls.push(['failure', operation, failure]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
    });
    exportRoadmap();
    assert.deepEqual(calls, [
      ['download', { name: 'sail.md', text: 'plan' }],
      ...(failed ? [['failure', 'roadmap-export', error]] : []),
      ['event', 'roadmap_export', { outcome: failed ? 'failed' : 'done', door: 'sheet' }],
    ]);
  }
});

test('Export without a projection or displayed tree reports a failed outcome without an Issue', () => {
  for (const [projection, boardTree] of [[null, { nodes: [] }], [{ id: 'sail' }, null]]) {
    const calls = [];
    const exportRoadmap = runInNewContext(`(${identityHandlers.get('exportFromRow')})`, {
      phone: false, projectionRef: { current: projection }, boardTree,
      buildRoadmapExport: () => assert.fail('unavailable exports must not build'),
      downloadExport: () => assert.fail('unavailable exports must not download'),
      reportRoadmapFailure: () => assert.fail('unavailable projections are expected'),
      track: (name, props) => calls.push([name, { ...props }]),
    });
    exportRoadmap();
    assert.deepEqual(calls, [['roadmap_export', { outcome: 'failed', door: 'more' }]]);
  }
});

test('Graph-toast Undo uses its captured visible origin, otherwise the pressed view switch', () => {
  for (const kind of ['connected', 'removed', 'covered', 'body', 'nonfocusable']) {
    const calls = [];
    const body = { isConnected: true, closest: () => null, focus: () => calls.push('body') };
    const document = { body, activeElement: body };
    const origin = kind === 'body' ? body : {
      isConnected: kind !== 'removed',
      closest: () => kind === 'covered' ? {} : null,
      focus: () => {
        calls.push('origin');
        if (kind !== 'nonfocusable') document.activeElement = origin;
      },
    };
    const undo = runInNewContext(`(${identityHandlers.get('undoGraphToast')})`, {
      document,
      toast: { focusTarget: origin, action: { run: () => calls.push('undo') } },
      runToastAction: (shown) => {
        shown.action.run();
        calls.push('dismiss');
      },
      requestAnimationFrame: (callback) => callback(),
      identityRef: { current: { querySelector: (selector) => {
        assert.equal(selector, '.st-board-switch-option[aria-pressed="true"]');
        return { focus: () => calls.push('pressed') };
      } } },
    });
    undo();
    const focus = { connected: ['origin'], nonfocusable: ['origin', 'pressed'] }[kind] ?? ['pressed'];
    assert.deepEqual(calls, ['undo', 'dismiss', ...focus]);
  }
});

function syncClock() {
  let now = 1000;
  let key = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (run, delay) => { timers.set(++key, { run, at: now + delay }); return key; },
    clearTimeout: (id) => timers.delete(id),
    advance: (ms) => {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = end;
    },
    count: () => timers.size,
  };
}

function statusSession(overrides = {}) {
  let snapshot = Object.freeze({ phase: 'live', online: true, structurePending: 0, progressPending: 0,
    structureInFlight: 0, progressInFlight: 0, refused: null, receiptVersion: 0, ...overrides });
  const listeners = new Set();
  return {
    statusSnapshot: () => snapshot,
    subscribeStatus: (handler) => { listeners.add(handler); handler(snapshot); return () => listeners.delete(handler); },
    change: (next) => { snapshot = Object.freeze({ ...snapshot, ...next }); for (const listener of listeners) listener(snapshot); },
    count: () => listeners.size,
  };
}

const syncHook = runInNewContext(`(${identityHandlers.get('useRoadmapSyncStatus')})`, {
  useEffect, useState, deriveSyncStatus, OFFLINE_GRACE_MS, SAVING_DELAY_MS, SAVED_HOLD_MS,
});

test('host sync timing delays Saving, holds Saved, and cleans up every clock and subscription', (t) => {
  const clock = syncClock();
  const session = statusSession();
  const hook = renderHook(t, () => syncHook(session, clock));
  assert.equal(hook.tree.state, null);
  session.change({ structurePending: 1 });
  clock.advance(SAVING_DELAY_MS - 1);
  assert.equal(hook.tree.state, null);
  clock.advance(1);
  assert.equal(hook.tree.state, 'saving');
  session.change({ structurePending: 0 });
  assert.equal(hook.tree.state, 'saved');
  clock.advance(SAVED_HOLD_MS - 1);
  assert.equal(hook.tree.state, 'saved');
  clock.advance(1);
  assert.equal(hook.tree.state, null);
  session.change({ phase: 'offline' });
  clock.advance(OFFLINE_GRACE_MS - 1);
  assert.equal(hook.tree.state, null);
  clock.advance(1);
  assert.equal(hook.tree.state, 'offline');
  hook.unmount();
  assert.deepEqual([session.count(), clock.count()], [0, 0]);
});

test('host sync refuses stale session readings, fast acks never flash Saving, and no session subscribes to nothing', (t) => {
  const clock = syncClock();
  const first = statusSession();
  const second = statusSession({ online: false });
  let session = first;
  const hook = renderHook(t, () => syncHook(session, clock));
  first.change({ progressPending: 1 });
  clock.advance(SAVING_DELAY_MS - 1);
  first.change({ progressPending: 0 });
  assert.equal(hook.tree.state, 'saved');
  session = second;
  hook.redraw();
  assert.equal(hook.tree.snapshot, second.statusSnapshot());
  assert.equal(hook.tree.state, 'offline');
  assert.deepEqual([first.count(), second.count()], [0, 1]);
  session = null;
  hook.redraw();
  assert.deepEqual({ ...hook.tree }, { snapshot: null, state: null });
  assert.deepEqual([first.count(), second.count(), clock.count()], [0, 0, 0]);
});

test('Graph reveal waits for the selected step model and panel insets, while a repeated selection reveals immediately', () => {
  for (const selected of ['course', 'wind']) {
    const calls = [];
    const graphRevealRef = { current: null };
    const jump = runInNewContext(`(${identityHandlers.get('revealOnGraph')})`, {
      selectedIdRef: { current: selected }, framing: { graphRevealRef },
      sceneRef: { current: { revealNode: (id) => calls.push(['reveal', id]) } },
      setSelectedId: (id) => calls.push(['select', id]),
    });
    jump('wind');
    assert.deepEqual(calls, selected !== 'wind' ? [['select', 'wind']] : [['reveal', 'wind'], ['select', 'wind']]);
    assert.equal(graphRevealRef.current, selected !== 'wind' ? 'wind' : null);
  }
  const calls = [];
  const graphRevealRef = { current: 'wind' };
  const firstFrameRef = { current: null };
  const insets = { top: 112, right: 408, bottom: 24, left: 24, blocks: [] };
  const scene = {
    nodesById: new Map(),
    setViewportInsets: (value) => calls.push(['insets', value]),
    revealNode: (id) => calls.push(['reveal', id]),
  };
  const publish = runInNewContext(`(${identityHandlers.get('publishInsets')})`, {
    insetsRef: { current: null }, insets, scene, graphRevealRef, firstFrameRef,
  });
  publish();
  assert.equal(graphRevealRef.current, 'wind');
  scene.nodesById.set('wind', {});
  firstFrameRef.current = { id: 'course' };
  publish();
  assert.deepEqual(calls, [['insets', insets], ['insets', insets], ['reveal', 'wind']]);
  assert.equal(graphRevealRef.current, null);
  assert.equal(firstFrameRef.current, null);
});

test('host reports discard only after the session confirms success', async () => {
  for (const result of [false, true]) {
    const events = [];
    const quiet = [];
    let finish;
    const discard = runInNewContext(`(${identityHandlers.get('discardSync')})`, {
      refused: { lane: 'structure' }, refusalCode: 'server-error',
      syncSession: { discardPending: true, discard: () => new Promise((resolve) => { finish = resolve; }) },
      setBoardQuiet: (update) => quiet.push(update(0)),
      track: (name, props) => events.push([name, { ...props }]),
    });
    const pending = discard();
    assert.deepEqual(quiet, [1]);
    assert.deepEqual(events, []);
    finish(result);
    await pending;
    assert.deepEqual(events, result ? [['roadmap_sync_refused', { step: 'discard', lane: 'structure', code: 'server-error' }]] : []);
  }
});

test('host invalidates only receipt-backed Undo, preserving progress and held-delete toasts', () => {
  for (const [act, receipt] of [['create', true], ['recolor', true], ['complete', false], ['delete', false]]) {
    const calls = [];
    const dismiss = runInNewContext(`(${identityHandlers.get('dismissInvalidatedToast')})`, {
      dismissToastIf: (leaves) => { if (leaves({ act, action: { receipt } })) calls.push('dismiss'); },
    });
    dismiss();
    assert.deepEqual(calls, receipt ? ['dismiss'] : []);
  }
});

test('Activity hands desktop Board to Graph, preserves the tablet Board, and never opens the desktop feed on phones', () => {
  for (const breakpoint of ['desktop', 'tablet', 'phone']) {
    const calls = [];
    const scope = {
      activityEnabled: breakpoint !== 'phone', feedVisible: false, breakpoint, boardActive: true,
      switchView: (view, options) => calls.push(['view', view, options.keepFocus]),
      setSelectedId: (id) => calls.push(['select', id]), openActivity: () => calls.push('open'),
      closeRowActivity: () => calls.push('close'),
      track: (name, props) => calls.push([name, { ...props }]),
    };
    const open = (overrides) => runInNewContext(`(${identityHandlers.get('openRowActivity')})`, { ...scope, ...overrides });
    open()('key');
    assert.deepEqual(calls, breakpoint === 'phone' ? [] : [
      ['roadmap_verb', { verb: 'activity', door: 'key', view: 'board', band: breakpoint }],
      ...(breakpoint === 'desktop' ? [['view', 'tree', true]] : []), ['select', null], 'open',
    ]);
    calls.length = 0;
    open({ feedVisible: true })();
    assert.deepEqual(calls, breakpoint === 'phone' ? [] : ['close']);
    calls.length = 0;
    open({ activityEnabled: false })();
    assert.deepEqual(calls, []);
  }
});

test('discard rebaselines never announce Saving or Saved, including a slow online resubscribe', (t) => {
  const clock = syncClock();
  const session = statusSession({ structurePending: 2, refused: { lane: 'structure', code: 'bad-frame' } });
  const hook = renderHook(t, () => syncHook(session, clock));
  clock.advance(SAVING_DELAY_MS);
  session.change({ rebaselining: true, structurePending: 0, refused: null, phase: 'syncing' });
  assert.equal(hook.tree.state, null);
  clock.advance(OFFLINE_GRACE_MS * 2);
  assert.equal(hook.tree.state, null);
  session.change({ rebaselining: false, phase: 'live' });
  assert.equal(hook.tree.state, null);
  clock.advance(SAVED_HOLD_MS);
  assert.equal(hook.tree.state, null);
  session.change({ structurePending: 1 });
  clock.advance(SAVING_DELAY_MS);
  assert.equal(hook.tree.state, 'saving');
  session.change({ structurePending: 0 });
  assert.equal(hook.tree.state, 'saved');
});

test('a real pending progress gesture still shows Saving during a structure rebaseline', (t) => {
  const clock = syncClock();
  const session = statusSession({ structurePending: 2, progressPending: 1, refused: { lane: 'structure', code: 'bad-frame' } });
  const hook = renderHook(t, () => syncHook(session, clock));
  session.change({ rebaselining: true, structurePending: 0, refused: null, phase: 'syncing' });
  clock.advance(SAVING_DELAY_MS);
  assert.equal(hook.tree.state, 'saving');
  clock.advance(OFFLINE_GRACE_MS * 2);
  assert.equal(hook.tree.state, 'saving');
  session.change({ progressPending: 0 });
  assert.equal(hook.tree.state, null);
  session.change({ rebaselining: false, phase: 'live' });
  assert.equal(hook.tree.state, null);
});
