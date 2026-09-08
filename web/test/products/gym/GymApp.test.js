import test from 'node:test';
import assert from 'node:assert/strict';
import { navigate, rememberHashNavigation, returnToPreviousLocation } from '../../../src/shell/navigation.js';
import { loadScreen, renderHook } from './harness.mjs';

test('bookmarked gym connection doors replace themselves with shared setup without a Back loop', async (t) => {
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  const oldWindow = globalThis.window;
  const oldPopStateEvent = globalThis.PopStateEvent;
  t.after(() => { globalThis.window = oldWindow; globalThis.PopStateEvent = oldPopStateEvent; });
  globalThis.PopStateEvent = class { constructor(type) { this.type = type; } };
  for (const status of ['ghost', 'signed-in']) {
    for (const hash of ['#/gym/connect', '#/gym/connect/', '#/gym/connect?from=routines']) {
      for (const direct of [true, false]) {
        let location = new URL(direct ? `/app/gym${hash}` : '/app/gym?week=2#/gym/ask', 'https://windmill.works');
        const entries = [{ href: location.href, state: null }];
        globalThis.window = {
          get location() { return location; },
          history: {
            get state() { return entries.at(-1).state; },
            replaceState(state, unused, href) {
              location = new URL(href, location);
              entries[entries.length - 1] = { href: location.href, state };
            },
            pushState(state, unused, href) {
              location = new URL(href, location);
              entries.push({ href: location.href, state });
            },
            back() { entries.pop(); location = new URL(entries.at(-1).href); },
          },
          dispatchEvent() {},
        };
        rememberHashNavigation();
        if (!direct) navigate(`/app/gym${hash}`);
        const view = renderHook(t, () => GymApp({ hash, inShell: true }), {
          context: { status, user: status === 'signed-in' ? { id: 'member' } : null, open() {}, lendHost() {} },
        });
        assert.equal(view.tree, null, 'the retired page mounts neither a pitch nor an authenticated log');
        assert.equal(location.href, 'https://windmill.works/app/connect');
        assert.equal(entries.length, direct ? 1 : 2, 'redirect replaces the legacy entry');
        returnToPreviousLocation();
        assert.equal(location.href, direct ? 'https://windmill.works/app' : 'https://windmill.works/app/gym?week=2#/gym/ask');
        assert.equal(entries.length, 1);
        view.unmount();
      }
    }
  }
});
