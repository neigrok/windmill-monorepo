// Named `.mjs`: the runner takes any `.js` under test/ as a test file.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import React from 'react';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { goneIds, hiddenIds } from '../../../src/products/gym/withheld.js';
import { environment } from '../../platform/sync/fakes.js';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

// Teardown is registered at mount: a thrown assertion would otherwise leave intervals holding the event loop open.
// `context` answers any `useContext` whose provider is not mounted here, since no provider ever is.
// `useSyncExternalStore` reads the snapshot and, unless `live`, never subscribes: a store's change is a
// `redraw`. A `live` render subscribes the way React does, so a store that changes draws again.
export function renderHook(t, run, { context = null, live = false } = {}) {
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
    useContext(ctx) { return ctx._currentValue ?? context; },
    useSyncExternalStore(subscribe, getSnapshot) {
      if (!live) return getSnapshot();
      const cell = cells[cursor] ?? (cells[cursor] = {});
      cursor += 1;
      cell.getSnapshot = getSnapshot;
      cell.value = getSnapshot();
      if (cell.subscribe !== subscribe) {
        cell.unsubscribe?.();
        cell.subscribe = subscribe;
        cell.unsubscribe = subscribe(() => { if (!rendering && !Object.is(cell.getSnapshot(), cell.value)) render(); });
      }
      return cell.value;
    },
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
    cells.forEach((cell) => {
      cell.cleanup?.(); cell.cleanup = null;
      cell.unsubscribe?.(); cell.unsubscribe = null;
    });
  };
  t.after(unmount);
  return {
    get log() { return result; },
    get tree() { return result; },
    // A navigation is the frame's business, and nothing here listens for one: a test that moves the
    // hash asks for the render the frame would have done.
    redraw: render,
    unmount,
  };
}

// Every engine write an open account has started, so `settle` can wait for the replica to be quiet.
const writing = new Set();

export const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  while (writing.size > 0) {
    await Promise.allSettled([...writing]);
    for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
};

export function browserWith() {
  const disk = new Map();
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

// A signed-in account whose server-confirmed `records` sit in a real browser engine, so every screen
// reads and writes the replica production does. The engine keeps the tab's clock and never networks.
export async function gymAccount(t, records = []) {
  const env = environment();
  const reading = () => ({ wall: Date.now(), mono: Date.now(), boot: 'test' });
  env.transport.request = async () => ({ response: hello({ state: env.state, registry, account: 'A', serverTime: Date.now() }),
    timing: { send: reading(), recv: reading() } });
  // Node's mocked `clearTimeout` throws on an id that was never set; a browser's ignores it.
  const timers = { setTimeout: (run, delay) => setTimeout(run, delay), clearTimeout: (id) => { if (id != null) clearTimeout(id); } };
  const engine = await BrowserSyncEngine.open({ ...env.options, registry, timers, now: () => Date.now(), monotonic: () => Date.now() });
  const write = engine.write.bind(engine);
  engine.write = (...args) => {
    const pending = write(...args);
    writing.add(pending);
    pending.then(() => writing.delete(pending), () => writing.delete(pending));
    return pending;
  };
  t.after(() => engine.close());
  await engine.signIn('A');
  await engine.write(null, (device) => {
    const replica = device.activeReplica;
    records.forEach((row, index) => replica.putConfirmed('self/gym', { ...row, seq: index + 1 }));
    replica.cursors['self/gym'] = { ...replica.cursorOf('self/gym'), booted: true };
  }, ['self/gym']);
  engine.observe('self/gym');
  const session = { engine, ready: true, signedIn: true, online: true, error: false };
  t.mock.method(syncSession, 'getSnapshot', () => session);
  return {
    engine,
    // What the account still owes the server: one line per outbox entry, its state then its change.
    owed: () => engine.device.activeReplica.entries().map(({ state, intent }) => {
      if (intent.cmd) return `${state} ${intent.cmd.name} ${intent.cmd.args.id ?? intent.cmd.args.sessionId ?? intent.cmd.args.proposalId}`;
      return `${state} ${intent.d.map((delta) => {
        if (delta.life?.[0] === 'dead') return `delete ${delta.t} ${delta.id}`;
        const verb = delta.born === undefined ? (delta.life ? 'put' : 'write') : delta.born === delta.life?.[1] ? 'create' : 'update';
        return [verb, delta.t, delta.id, ...Object.keys(delta.f ?? {}).sort()].join(' ');
      }).join(', ')}`;
    }),
    // Newer server rows reach the replica, the way a pull brings another device's write.
    land: (...rows) => engine.write(null, (device) => rows.forEach((row) => device.activeReplica.putConfirmed('self/gym', row)), ['self/gym']),
    // The browser refuses every later write, the way a full or evicted IndexedDB does.
    refuseWrites: () => { engine.store.transact = () => Promise.reject(new DOMException('storage refused', 'QuotaExceededError')); },
  };
}

// A record as the server confirmed it: `fields` are plain values, stamped in `f` except the serial
// fields, which the server numbers in `v`.
export function confirmed(t, id, fields, { rc = 1000 } = {}) {
  const stamp = '1:0:srv';
  const type = registry.type(t);
  const serial = Object.entries(fields).filter(([name]) => type.field(name).kind === 'serial');
  const stamped = Object.entries(fields).filter(([name]) => type.field(name).kind !== 'serial');
  return { t, id, ...(type.hasBorn ? { born: stamp } : {}), ...(type.life ? { life: ['alive', stamp] } : {}), rc, ru: rc,
    f: Object.fromEntries(stamped.map(([name, value]) => [name, [value, stamp]])),
    ...(serial.length ? { v: Object.fromEntries(serial) } : {}) };
}

// A real room, and a screen with a life of its own inside it. The two are rendered separately so the
// SCREEN can be torn down and built again while the room goes on holding its window — which is what
// walking off a tab and back really does, and the case where a screen keeping its own memory of a
// delete lets a settled delete reach nobody. `redraw` is the render the room's own publish would
// have caused; the harness has no tree to propagate through.
export async function roomAndScreen(t, { module, render }) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const screens = await loadScreen(module);
  const room = renderHook(t, () => useTrainingLog(), { live: true });
  await settle();
  let screen = null;
  const mount = async () => {
    screen = renderHook(t, () => render(screens, room.log), { live: true });
    await settle();
  };
  await mount();
  return {
    room,
    log: () => room.log,
    screen: () => screen.tree,
    redraw: () => screen.redraw(),
    remount: async () => { screen.unmount(); await mount(); },
  };
}

// What the room hands every screen. A screen reads the withheld window through `held`, asks `hidden`
// before it draws a deleted row and asks `gone` before it takes a stance about the account, so a
// fake that leaves any of them out is a fake of a room that cannot exist; this is the one place its
// shape is written down for the screens tested without a real `useTrainingLog`. `settled` seeds what
// the store has already answered for, and both questions are the room's own functions over it — a
// fake that answered either any other way could hide a defect the real room has.
export function roomLog({ settled = [], ...overrides } = {}) {
  const held = overrides.held ?? [];
  return {
    phase: 'ready',
    summaries: [],
    catalog: [],
    session: null,
    sets: [],
    older: { status: 'end', load: () => {} },
    held,
    hidden: (kind) => hiddenIds(held, settled, kind),
    gone: (kind) => goneIds(settled, kind),
    say: () => {},
    withhold: () => {},
    holdDelete: () => {},
    undoWithheld: () => {},
    dropWithheld: () => {},
    createMovement: async () => null,
    ...overrides,
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
