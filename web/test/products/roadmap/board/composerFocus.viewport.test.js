import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { useComposerViewport } from '../../../../src/products/roadmap/board/composerFocus.js';

function viewport(visible = null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Map();
  const attach = (type, callback) => listeners.set(type, callback);
  const detach = (type) => listeners.delete(type);
  globalThis.window = {
    innerWidth: 390, innerHeight: 844,
    addEventListener: attach, removeEventListener: detach,
    visualViewport: visible && { offsetTop: 0, offsetLeft: 0, width: 390, height: 844, scale: 1,
      addEventListener: attach, removeEventListener: detach, ...visible },
  };
  const restore = () => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  };
  const change = (patch, layoutHeight = window.innerHeight) => {
    Object.assign(window.visualViewport, patch);
    window.innerHeight = layoutHeight;
    listeners.get('resize')();
  };
  return { change, restore };
}

test('composer viewport keeps keyboard geometry and ignores pinch zoom', (t) => {
  const { change, restore } = viewport({});
  const hook = renderHook(t, () => useComposerViewport(true));
  t.after(restore);
  assert.deepEqual(hook.tree, {
    panelFits: false, keyboardVisible: false,
    style: { position: 'fixed', top: 0, left: 0, width: 390, height: 844 },
  });
  change({ height: 500 });
  hook.redraw();
  assert.deepEqual(hook.tree, {
    panelFits: false, keyboardVisible: true,
    style: { position: 'fixed', top: 0, left: 0, width: 390, height: 500 },
  });
  change({ height: 422, width: 195, scale: 2 });
  hook.redraw();
  assert.deepEqual(hook.tree, {
    panelFits: false, keyboardVisible: false,
    style: { position: 'fixed', top: 0, left: 0, width: 195, height: 422 },
  });
  change({ height: 700, width: 390, scale: 1 }, 700);
  hook.redraw();
  assert.deepEqual(hook.tree, {
    panelFits: false, keyboardVisible: false,
    style: { position: 'fixed', top: 0, left: 0, width: 390, height: 700 },
  });
});

test('composer viewport keeps the non-phone and missing-visual-viewport contracts', (t) => {
  const { restore } = viewport();
  const phone = renderHook(t, () => useComposerViewport(true));
  assert.deepEqual(phone.tree, { panelFits: false, keyboardVisible: false, style: undefined });
  window.innerWidth = 1440;
  const desktop = renderHook(t, () => useComposerViewport(false));
  t.after(restore);
  assert.deepEqual(desktop.tree, { panelFits: true, keyboardVisible: false, style: undefined });
});
