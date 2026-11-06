import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { useRoomView } from '../../../../src/products/roadmap/room/useRoomView.js';

test('pending scene availability never covers a missing Board layer or latches it for a capable Graph visit', (t) => {
  const props = {
    treeId: 't_sail', tree: null, loading: true, loadError: false, linkedStep: null, scene: null, graphUnavailable: null,
    who: { owner: false, reader: true, role: 'reader', demo: false, shared: true, breakpoint: 'desktop' },
    anchors: { identityRef: { current: null }, boardLayerRef: { current: null } },
    onLeave() {}, onSwitched() {},
  };
  const view = renderHook(t, () => useRoomView(props));
  assert.deepEqual({ shown: view.tree.shownView, mounted: view.tree.boardMounted, decided: view.tree.decidedView },
    { shown: 'board', mounted: false, decided: null });
  props.graphUnavailable = false;
  view.redraw();
  assert.deepEqual({ shown: view.tree.shownView, mounted: view.tree.boardMounted, decided: view.tree.decidedView },
    { shown: 'tree', mounted: false, decided: null });
});
