// Named `.mjs`: the runner takes any `.js` under test/ as a test file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import React from 'react';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

// Teardown is registered at mount: a thrown assertion would otherwise leave intervals holding the event loop open.
export function renderHook(t, run) {
  const cells = [];
  const queued = [];
  let cursor = 0;
  let rendering = false;
  let result = null;

  const same = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((each, index) => Object.is(each, right[index]));

  const dispatcher = {
    useState(initial) {
      const cell = cells[cursor] ?? (cells[cursor] = { value: typeof initial === 'function' ? initial() : initial });
      cursor += 1;
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        if (!rendering) render();
      }];
    },
    useRef(initial) {
      const cell = cells[cursor] ?? (cells[cursor] = { current: initial });
      cursor += 1;
      return cell;
    },
    useMemo(factory, deps) {
      const cell = cells[cursor] ?? (cells[cursor] = {});
      cursor += 1;
      if (!('value' in cell) || !same(cell.deps, deps)) {
        cell.value = factory();
        cell.deps = deps;
      }
      return cell.value;
    },
    useCallback(fn, deps) { return dispatcher.useMemo(() => fn, deps); },
    // Stable per cell and per render, which is the whole contract a caller can rely on.
    useId() {
      const cell = cells[cursor] ?? (cells[cursor] = { value: `:r${cursor}:` });
      cursor += 1;
      return cell.value;
    },
    useEffect(effect, deps) {
      const cell = cells[cursor] ?? (cells[cursor] = {});
      cursor += 1;
      if ('deps' in cell && same(cell.deps, deps)) return;
      cell.deps = deps;
      queued.push(cell, effect);
    },
    useLayoutEffect(effect, deps) { dispatcher.useEffect(effect, deps); },
    useDebugValue() {},
  };

  function render() {
    rendering = true;
    cursor = 0;
    const outer = ReactCurrentDispatcher.current;
    ReactCurrentDispatcher.current = dispatcher;
    try {
      result = run();
    } finally {
      ReactCurrentDispatcher.current = outer;
      rendering = false;
    }
    while (queued.length > 0) {
      const cell = queued.shift();
      const effect = queued.shift();
      cell.cleanup?.();
      cell.cleanup = effect() ?? null;
    }
  }

  render();
  const unmount = () => {
    cells.forEach((cell) => { cell.cleanup?.(); cell.cleanup = null; });
  };
  t.after(unmount);
  return {
    get log() { return result; },
    get tree() { return result; },
    unmount,
  };
}

export const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// `live` and `queue` are seeded as raw bytes.
export function browserWith({ queue = null, live = null } = {}) {
  const disk = new Map();
  if (queue !== null) disk.set('windmill.gym.queue', queue);
  if (live !== null) disk.set('windmill.gym.live', live);
  const listeners = new Map();
  const bind = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const unbind = (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== fn));
  globalThis.window = {
    localStorage: {
      getItem: (key) => (disk.has(key) ? disk.get(key) : null),
      setItem: (key, value) => disk.set(key, value),
      removeItem: (key) => disk.delete(key),
    },
    addEventListener: bind,
    removeEventListener: unbind,
    location: { hash: '#/gym' },
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: bind, removeEventListener: unbind };
  globalThis.navigator = { onLine: true };
  return {
    held: () => (disk.has('windmill.gym.queue') ? disk.get('windmill.gym.queue') : null),
    kept: () => (disk.has('windmill.gym.live') ? disk.get('windmill.gym.live') : null),
    hide: () => {
      globalThis.document.visibilityState = 'hidden';
      (listeners.get('visibilitychange') ?? []).forEach((fn) => fn());
    },
    show: () => {
      globalThis.document.visibilityState = 'visible';
      (listeners.get('visibilitychange') ?? []).forEach((fn) => fn());
    },
    reconnect: () => {
      globalThis.navigator.onLine = true;
      (listeners.get('online') ?? []).forEach((fn) => fn());
    },
  };
}


let loaderRegistered = false;
export async function loadScreen(relativeToSrc) {
  if (!loaderRegistered) {
    register('../../jsxLoader.mjs', import.meta.url);
    loaderRegistered = true;
  }
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
  return import(pathToFileURL(path.join(src, relativeToSrc)).href);
}

// Every element depth first; a child component is not rendered, so its props are what the parent handed it.
export function elementsOf(tree) {
  const found = [];
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) return;
    found.push(node);
    Object.entries(node.props ?? {}).forEach(([key, value]) => {
      if (key === 'children') walk(value);
      else if (React.isValidElement(value) || Array.isArray(value)) walk(value);
    });
  };
  walk(tree);
  return found;
}

// The text under an element, joined; child components contribute nothing.
export function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node) && typeof node.type !== 'function') return textOf(node.props.children);
  return '';
}

export function findByClass(tree, className) {
  return elementsOf(tree).filter((each) => typeof each.props.className === 'string'
    && each.props.className.split(' ').includes(className));
}
