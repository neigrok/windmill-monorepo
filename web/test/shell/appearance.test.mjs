import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_CHOICES, KEY, readAppearance, resolveAppearance, systemAppearance,
} from '../../src/shell/appearance.js';

test('the three choices are exactly light, dark and system', () => {
  assert.deepEqual(APPEARANCE_CHOICES, ['light', 'dark', 'system']);
});

test('system resolves to whatever the device says, and nothing else does', () => {
  assert.equal(resolveAppearance('system', 'dark'), 'dark');
  assert.equal(resolveAppearance('system', 'light'), 'light');
  assert.equal(resolveAppearance('dark', 'light'), 'dark', 'an explicit choice ignores the device');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
});

test('with no browser around it falls back rather than throwing', () => {
  assert.equal(readAppearance(), 'system');
  assert.equal(systemAppearance(), 'light');
  assert.equal(resolveAppearance(), 'light');
});

// One store for every seat and shell on the page: a switch made in the pop-up reaches the <html>
// stamp without either knowing the other.
test('the store publishes a choice to every subscriber, once, and ignores nonsense', async () => {
  const { getAppearance, setAppearance, subscribeAppearance } = await import('../../src/shell/appearance.js');
  const seen = [];
  const stop = subscribeAppearance(() => seen.push(getAppearance()));
  const before = getAppearance();

  setAppearance('dark');
  setAppearance('dark');
  setAppearance('purple');
  assert.deepEqual(seen, [{ choice: 'dark', resolved: 'dark' }]);
  assert.notEqual(getAppearance(), before, 'a change is a new snapshot, or useSyncExternalStore never re-renders');
  assert.equal(getAppearance(), getAppearance(), 'no change is the same snapshot, or it re-renders forever');

  stop();
  setAppearance('light');
  assert.equal(seen.length, 1, 'an unsubscribed listener was still called');
  assert.deepEqual(getAppearance(), { choice: 'light', resolved: 'light' });
  setAppearance('system');
});

// The store watches the device and the other tabs only while somebody listens, and stops when the
// last listener leaves. Both are exercised through the same fakes the browser would hand it.
function browserWith({ stored = null, prefersDark = false } = {}) {
  const disk = new Map(stored === null ? [] : [[KEY, stored]]);
  const query = {
    matches: prefersDark,
    listeners: [],
    addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((each) => each !== fn); },
  };
  const tab = {
    listeners: [],
    matchMedia: (media) => (media.includes('dark') ? query : { matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, fn) { if (type === 'storage') this.listeners.push(fn); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((each) => each !== fn); },
  };
  globalThis.window = tab;
  globalThis.localStorage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) };
  return {
    flipDevice: (dark) => { query.matches = dark; query.listeners.forEach((fn) => fn({ matches: dark })); },
    otherTabWrites: (key, value) => { if (key === null) disk.clear(); else disk.set(key, value); tab.listeners.forEach((fn) => fn({ key })); },
    watching: () => ({ device: query.listeners.length, storage: tab.listeners.length }),
  };
}

test('the device flipping at sunset moves a system choice, and only a system choice', async () => {
  const browser = browserWith();
  const { getAppearance, setAppearance, subscribeAppearance } = await import('../../src/shell/appearance.js');
  setAppearance('system');
  const seen = [];
  const stop = subscribeAppearance(() => seen.push(getAppearance().resolved));

  browser.flipDevice(true);
  assert.deepEqual(seen, ['dark']);
  assert.deepEqual(getAppearance(), { choice: 'system', resolved: 'dark' });
  browser.flipDevice(false);
  assert.deepEqual(getAppearance(), { choice: 'system', resolved: 'light' });

  setAppearance('light');
  browser.flipDevice(true);
  assert.deepEqual(getAppearance(), { choice: 'light', resolved: 'light' }, 'an explicit choice must not follow the device');
  browser.flipDevice(false);
  stop();
  setAppearance('system');
});

test('a choice made in another tab arrives through the storage event', async () => {
  const browser = browserWith();
  const { getAppearance, setAppearance, subscribeAppearance } = await import('../../src/shell/appearance.js');
  setAppearance('system');
  const seen = [];
  const stop = subscribeAppearance(() => seen.push(getAppearance().choice));

  browser.otherTabWrites(KEY, 'dark');
  assert.deepEqual(seen, ['dark']);
  assert.deepEqual(getAppearance(), { choice: 'dark', resolved: 'dark' });
  browser.otherTabWrites('windmill:something-else', 'light');
  assert.deepEqual(seen, ['dark'], 'a write to another key is not a choice');
  browser.otherTabWrites(KEY, 'dark');
  assert.deepEqual(seen, ['dark'], 'the same choice again is not a change');
  browser.otherTabWrites(null, null);
  assert.deepEqual(getAppearance(), { choice: 'system', resolved: 'light' }, 'a cleared storage reads as no choice');
  stop();
});

test('the last listener leaving stops the watching, and nothing arrives after', async () => {
  const browser = browserWith();
  const { getAppearance, subscribeAppearance, setAppearance } = await import('../../src/shell/appearance.js');
  setAppearance('system');
  assert.deepEqual(browser.watching(), { device: 0, storage: 0 });
  const stopA = subscribeAppearance(() => {});
  const stopB = subscribeAppearance(() => {});
  assert.deepEqual(browser.watching(), { device: 1, storage: 1 }, 'two listeners share one watch');
  stopA();
  assert.deepEqual(browser.watching(), { device: 1, storage: 1 });
  stopB();
  assert.deepEqual(browser.watching(), { device: 0, storage: 0 });

  const before = getAppearance();
  browser.flipDevice(true);
  browser.otherTabWrites(KEY, 'dark');
  assert.equal(getAppearance(), before, 'the store moved with nobody listening');
});
