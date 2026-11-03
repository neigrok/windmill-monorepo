import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { LINK_COPIED } from '../../../../src/products/roadmap/copy.js';
import { closuresIn } from '../sourceClosures.js';

const verbs = await closuresIn('room/useRowVerbs.js');

test('Graph Find hands the same query to the Board and retains field focus', () => {
  for (const [boardActive, search] of [[false, 'wind'], [false, ''], [true, 'wind']]) {
    const calls = [];
    const query = new BoardQuery({ search });
    const onQuery = verbs.callback('onIdentityQuery', {
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
    const copy = verbs.callback('shareFromRow', {
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
    const exportRoadmap = verbs.callback('exportFromRow', {
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
    const exportRoadmap = verbs.callback('exportFromRow', {
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
    const open = (overrides) => verbs.callback('openRowActivity', { ...scope, ...overrides });
    open()('key');
    assert.deepEqual(calls, breakpoint === 'phone' ? [] : [
      ['roadmap_verb', { verb: 'activity', door: 'key' }],
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
