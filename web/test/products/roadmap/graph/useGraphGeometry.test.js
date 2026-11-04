import test from 'node:test';
import assert from 'node:assert/strict';
import { closuresIn } from '../sourceClosures.js';

const geometry = await closuresIn('graph/useGraphGeometry.js');

test('a reveal waits for the step\'s model and the panel\'s insets, and takes over from the first frame', () => {
  const calls = [];
  const graphRevealRef = { current: 'wind' };
  const firstFrameRef = { current: null };
  const insets = { top: 112, right: 408, bottom: 24, left: 24, blocks: [] };
  const scene = {
    nodesById: new Map(),
    setViewportInsets: (value) => calls.push(['insets', value]),
    revealNode: (id) => calls.push(['reveal', id]),
  };
  const publish = geometry.effectWith('insetsRef.current = insets;', {
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
