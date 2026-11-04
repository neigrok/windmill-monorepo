import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../../gym/harness.mjs';

function door(t, { status, indexedDB }) {
  const priors = ['window', 'document', 'navigator', 'indexedDB', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of priors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  browserWith();
  Object.assign(globalThis.window.location, { hash: '#/app/new', pathname: '/app/roadmap', search: '' });
  globalThis.window.innerWidth = 1440;
  globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: indexedDB });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: globalThis.window.localStorage });
  return { status };
}

const refused = { open() { throw new DOMException('refused', 'SecurityError'); } };
const said = (view) => elementsOf(view.tree).filter((node) => node.props.role === 'alert').map(textOf);
const fields = (view) => elementsOf(view.tree).filter((node) => node.type === 'input').length;

for (const status of ['ghost', 'loading']) {
  test(`${status}: a browser that will not keep a plan is told before anyone types, and offers nowhere to type`, async (t) => {
    const context = door(t, { status, indexedDB: refused });
    const { NewTreeBirth } = await loadScreen('products/roadmap/paste/NewTreeBirth.jsx');
    const view = renderHook(t, () => NewTreeBirth(), { context });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(said(view), ['Couldn’t open this device’s saved workReload to try again.']);
    assert.equal(fields(view), 0);
    view.unmount();
  });
}

test('a browser that keeps its plans, and a signed-in account the server keeps them for, get the field', async (t) => {
  for (const [status, indexedDB] of [['ghost', new IDBFactory()], ['signed-in', refused]]) {
    const context = door(t, { status, indexedDB });
    const { NewTreeBirth } = await loadScreen('products/roadmap/paste/NewTreeBirth.jsx');
    const view = renderHook(t, () => NewTreeBirth(), { context });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([status, said(view), fields(view)], [status, [], 1]);
    view.unmount();
  }
});
