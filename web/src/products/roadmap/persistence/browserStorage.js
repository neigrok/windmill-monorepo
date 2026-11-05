// The browser's storage, or one that holds nothing where merely reaching for it throws: a store fails closed, the room opens.

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
