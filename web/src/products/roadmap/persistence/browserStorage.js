// The browser's storage, or one that holds nothing where the browser refuses it: merely reaching for `localStorage` throws
// in a blocked context, before any store's own guard runs. A store built on this fails closed and the room still opens.

const HOLDS_NOTHING = Object.freeze({ getItem: () => null, setItem: () => {}, removeItem: () => {} });

export function localStorageOrNothing() {
  try {
    return window.localStorage ?? HOLDS_NOTHING;
  } catch {
    return HOLDS_NOTHING;
  }
}

export function sessionStorageOrNothing() {
  try {
    return globalThis.sessionStorage ?? HOLDS_NOTHING;
  } catch {
    return HOLDS_NOTHING;
  }
}
