export function navigationBrowser(t, { href = '/app/roadmap#/app/sail', state = null, deferred = false, install = true } = {}) {
  const entries = [{ url: new URL(href, 'https://windmill.works'), state }];
  const listeners = new Map();
  const traversals = [];
  let position = 0;
  const browser = {
    get location() { return entries[position].url; },
    history: {
      get state() { return entries[position].state; },
      get length() { return entries.length; },
      replaceState(state, unused, href) { entries[position] = { url: href ? new URL(href, browser.location) : browser.location, state }; },
      pushState(state, unused, href) {
        entries.splice(position + 1);
        entries.push({ url: new URL(href, browser.location), state });
        position += 1;
      },
      go(delta) {
        const move = () => {
          const previous = browser.location.href;
          const next = position + delta;
          if (next < 0 || next >= entries.length) return;
          position = next;
          browser.dispatchEvent({ type: 'popstate' });
          if (previous !== browser.location.href) browser.dispatchEvent({ type: 'hashchange', oldURL: previous });
        };
        if (deferred) traversals.push(move);
        else move();
      },
      back() { this.go(-1); },
      forward() { this.go(1); },
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...listeners.get(event.type) ?? []]) fn(event); },
  };
  if (install) {
    const old = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, 'window', old); else delete globalThis.window; });
  }
  return { browser, entries, traversals,
    flush: () => traversals.shift()?.(),
    nativeHash(hash, state = null) {
      const oldURL = browser.location.href;
      browser.history.pushState(state, '', hash);
      browser.dispatchEvent({ type: 'popstate' });
      browser.dispatchEvent({ type: 'hashchange', oldURL });
    },
  };
}
