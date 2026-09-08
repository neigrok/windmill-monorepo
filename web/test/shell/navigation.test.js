import test from 'node:test';
import assert from 'node:assert/strict';
import { navigate, previousLocation, rememberHashNavigation, replaceLocation, returnToPreviousLocation } from '../../src/shell/navigation.js';
import { elementsOf, loadScreen, renderHook } from '../products/gym/harness.mjs';

function browser(t, href = '/app/gym?week=2#/gym/session/session-17') {
  const entries = [{ url: new URL(href, 'https://windmill.works'), state: null }];
  let index = 0;
  const listeners = new Map();
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldPopStateEvent = globalThis.PopStateEvent;
  const win = {
    get location() { return entries[index].url; },
    history: {
      get state() { return entries[index].state; },
      replaceState(state, unused, url) { entries[index] = { state, url: new URL(url, win.location) }; },
      pushState(state, unused, url) {
        entries.splice(index + 1);
        entries.push({ state, url: new URL(url, win.location) });
        index += 1;
      },
      back() { this.go(-1); },
      go(delta) {
        const oldURL = win.location.href;
        index = Math.min(entries.length - 1, Math.max(0, index + delta));
        win.dispatchEvent({ type: 'popstate' });
        if (new URL(oldURL).hash !== win.location.hash) win.dispatchEvent({ type: 'hashchange', oldURL });
      },
    },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
  };
  globalThis.window = win;
  globalThis.document = { activeElement: null };
  globalThis.PopStateEvent = class { constructor(type) { this.type = type; } };
  t.after(() => { globalThis.window = oldWindow; globalThis.document = oldDocument; globalThis.PopStateEvent = oldPopStateEvent; });
  rememberHashNavigation();
  win.addEventListener('hashchange', rememberHashNavigation);
  return {
    win,
    hash(hash) {
      const oldURL = win.location.href;
      const url = new URL(oldURL);
      url.hash = hash;
      win.history.pushState(null, '', url.href);
      win.dispatchEvent({ type: 'hashchange', oldURL });
    },
  };
}

test('account return preserves the full source, nested settings, browser history and reload metadata', (t) => {
  const { win } = browser(t);
  navigate('/app/connect');
  assert.equal(previousLocation(), '/app/gym?week=2#/gym/session/session-17');
  navigate('/app/connect#/settings');
  replaceLocation('/app/settings#/settings');
  assert.equal(previousLocation(), '/app/connect');
  rememberHashNavigation();
  assert.equal(previousLocation(), '/app/connect', 'initialization after reload retains the recorded predecessor');
  returnToPreviousLocation();
  assert.equal(win.location.href, 'https://windmill.works/app/connect');
  returnToPreviousLocation();
  assert.equal(win.location.href, 'https://windmill.works/app/gym?week=2#/gym/session/session-17');
  win.history.go(1);
  assert.equal(previousLocation(), '/app/gym?week=2#/gym/session/session-17');
  win.history.go(1);
  assert.equal(previousLocation(), '/app/connect');
});

test('native legacy hash doors retain their source through pathname upgrades and browser back', (t) => {
  const { win, hash } = browser(t, '/roadmap?view=mine#/tree/tree-9');
  hash('#/connect');
  replaceLocation('/app/connect?view=mine#/connect');
  assert.equal(previousLocation(), '/roadmap?view=mine#/tree/tree-9');
  hash('#/settings');
  replaceLocation('/app/settings?view=mine#/settings');
  assert.equal(previousLocation(), '/app/connect?view=mine#/connect');
  returnToPreviousLocation();
  assert.equal(win.location.href, 'https://windmill.works/app/connect?view=mine#/connect');
  returnToPreviousLocation();
  assert.equal(win.location.href, 'https://windmill.works/roadmap?view=mine#/tree/tree-9');
});

test('direct entry and malformed or external predecessor metadata use the app fallback', (t) => {
  const { win } = browser(t, '/app/connect');
  for (const previous of [null, 'https://example.com', '//example.com', '//[', '/\\example.com', '/\n/example.com']) {
    win.history.replaceState({ windmillNavigation: { href: '/app/connect', previous } }, '', '/app/connect');
    assert.equal(previousLocation(), null);
    returnToPreviousLocation();
    assert.equal(win.location.href, 'https://windmill.works/app');
  }
});

test('Back and Escape share return behavior in both chrome modes, including focused radios', async (t) => {
  const { win } = browser(t);
  const { AccountChrome } = await loadScreen('shell/account/AccountChrome.jsx');
  for (const bare of [false, true]) {
    for (const action of ['click', 'escape']) {
      navigate('/app/connect');
      const view = renderHook(t, () => AccountChrome({ bare }), { context: { status: 'ghost', user: null } });
      const back = elementsOf(view.tree).find((item) => item.props.className === 'wm-account-back');
      assert.equal(back.props.href, '/app/gym?week=2#/gym/session/session-17');
      document.activeElement = { tagName: 'INPUT', type: 'radio' };
      const event = { type: 'keydown', key: 'Escape', button: 0, preventDefault() { this.defaultPrevented = true; } };
      if (action === 'click') back.props.onClick(event);
      else win.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(win.location.href, 'https://windmill.works/app/gym?week=2#/gym/session/session-17');
      view.unmount();
    }
  }
});

test('page Escape yields to consumed events, editable fields and native selects', async (t) => {
  const { win } = browser(t);
  const { AccountChrome } = await loadScreen('shell/account/AccountChrome.jsx');
  navigate('/app/settings');
  const view = renderHook(t, () => AccountChrome({ bare: true }), { context: { status: 'ghost', user: null } });
  for (const element of [null, { tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    document.activeElement = element;
    win.dispatchEvent({ type: 'keydown', key: 'Escape', defaultPrevented: element === null,
      preventDefault() { throw new Error('The page must not consume this Escape'); } });
    assert.equal(win.location.href, 'https://windmill.works/app/settings');
  }
  view.unmount();
});
