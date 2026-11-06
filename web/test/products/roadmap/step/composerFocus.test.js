import test from 'node:test';
import assert from 'node:assert/strict';
import { coverBeneath, coverLayer } from '../../../../src/products/roadmap/step/composerFocus.js';

for (const lowerFirst of [true, false]) {
  test(`layer coverage restores prior inert state after ${lowerFirst ? 'lower' : 'upper'} owner leaves first`, (t) => {
    const observers = [];
    const previous = Object.fromEntries(['getComputedStyle', 'MutationObserver'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    t.after(() => {
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
    globalThis.getComputedStyle = (element) => ({ zIndex: element.zIndex });
    globalThis.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.connected = false;
        observers.push(this);
      }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    };
    const root = { children: [] };
    for (const [zIndex, inert] of [['auto', false], ['auto', true], ['18', false], ['20', false], ['22', false]]) {
      root.children.push({ parentElement: root, zIndex, inert });
    }
    const lower = coverBeneath(root.children[2]);
    const upper = coverBeneath(root.children[3]);
    const state = () => root.children.map((element) => element.inert);
    assert.deepEqual(state(), [true, true, true, false, false]);
    root.children.push({ parentElement: root, zIndex: '1', inert: false });
    for (const observer of observers) observer.callback();
    assert.deepEqual(state(), [true, true, true, false, false, true]);
    (lowerFirst ? lower : upper)();
    assert.deepEqual(state(), [true, true, lowerFirst, false, false, true]);
    for (const observer of observers.filter((observer) => observer.connected)) observer.callback();
    (lowerFirst ? upper : lower)();
    assert.deepEqual(state(), [false, true, false, false, false, false]);
    assert.deepEqual(observers.map((observer) => observer.connected), [false, false]);
  });
}

for (const hiddenFirst of [true, false]) {
  test(`a hidden view stays inert when ${hiddenFirst ? 'its own' : 'a covering'} owner leaves first`, () => {
    const layer = { inert: false };
    const hidden = coverLayer(layer);
    const modal = coverLayer(layer);
    assert.equal(layer.inert, true);
    (hiddenFirst ? hidden : modal)();
    assert.equal(layer.inert, true);
    (hiddenFirst ? modal : hidden)();
    assert.equal(layer.inert, false);
  });
}

test('explicit hidden-layer coverage preserves an already inert layer', () => {
  const layer = { inert: true };
  const uncover = coverLayer(layer);
  uncover();
  assert.equal(layer.inert, true);
});
