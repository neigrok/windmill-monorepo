import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderHook } from '../../../gym/harness.mjs';

const source = await readFile(new URL('../../../../../src/products/roadmap/ui/mobile/BottomSheet.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'BottomSheet.jsx', { loader: 'jsx' });
const statements = parse(code, { sourceType: 'module', ecmaVersion: 'latest' }).body
  .map((node) => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
  .filter((node) => node && !['ImportDeclaration', 'ExportDefaultDeclaration'].includes(node.type))
  .map((node) => code.slice(node.start, node.end)).join('\n');

function sheet(t) {
  const heights = [];
  const events = new Map();
  const viewportEvents = new Map();
  const frames = new Map();
  const timers = new Map();
  let key = 0;
  const window = {
    innerHeight: 1000,
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => events.set(type, fn),
    removeEventListener: (type) => events.delete(type),
    visualViewport: {
      height: 1000,
      addEventListener: (type, fn) => viewportEvents.set(type, fn),
      removeEventListener: (type) => viewportEvents.delete(type),
    },
  };
  const BottomSheet = runInNewContext(`${statements}\nBottomSheet`, {
    React, useEffect, useLayoutEffect, useRef, useState, window,
    requestAnimationFrame: (fn) => { frames.set(++key, fn); return key; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (fn) => { timers.set(++key, fn); return key; },
    clearTimeout: (id) => timers.delete(id),
  });
  let open = false;
  const onHeight = (height) => heights.push(height);
  const hook = renderHook(t, () => BottomSheet({ open, onHeight, children: null }));
  return {
    hook, heights, events, viewportEvents, window,
    open: (value) => { open = value; hook.redraw(); },
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
    timeout: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
    grip: () => hook.tree.props.children[0].props,
    settled: () => {
      const element = {};
      hook.tree.props.onTransitionEnd({ target: element, currentTarget: element, propertyName: 'transform' });
    },
  };
}

test('BottomSheet reports opening and expansion immediately, retaining collapse clearance until the transition ends', (t) => {
  const s = sheet(t);
  assert.equal(s.heights.at(-1), 0);
  s.open(true);
  s.frame();
  assert.equal(s.heights.at(-1), 216);
  const tap = () => {
    s.grip().onPointerDown({ currentTarget: {}, clientY: 100 });
    s.grip().onPointerUp({ clientY: 100 });
  };
  tap();
  assert.equal(s.heights.at(-1), 620);
  tap();
  assert.equal(s.heights.at(-1), 620);
  s.settled();
  assert.equal(s.heights.at(-1), 216);
  s.events.get('resize')();
  s.open(false);
  assert.equal(s.heights.at(-1), 216);
  s.timeout();
  assert.equal(s.heights.at(-1), 0);
  assert.equal(s.hook.tree, null);
});

test('BottomSheet reports drag, keyboard and viewport resize from its own state', (t) => {
  const s = sheet(t);
  s.open(true);
  s.frame();
  s.grip().onPointerDown({ currentTarget: {}, clientY: 100 });
  s.grip().onPointerMove({ clientY: 150 });
  assert.equal(s.heights.at(-1), 166);
  s.window.visualViewport.height = 600;
  s.viewportEvents.get('resize')();
  assert.equal(s.heights.at(-1), 620);
  s.window.innerHeight = 800;
  s.events.get('resize')();
  assert.equal(s.heights.at(-1), 496);
  s.hook.unmount();
  assert.equal(s.heights.at(-1), 0);
  assert.deepEqual([...s.events], []);
});
