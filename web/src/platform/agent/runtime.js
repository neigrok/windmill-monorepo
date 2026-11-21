export function secureCallId(crypto = globalThis.crypto) {
  const data = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function browserRuntime({ locks = globalThis.navigator?.locks, crypto = globalThis.crypto, now = () => performance.now() } = {}) {
  if (!locks?.request) throw new Error('browser locks unavailable');
  return { now, newId: () => secureCallId(crypto),
    withLock: (turnId, { ifAvailable }, body) => locks.request(`windmill:coach:${turnId}`, { mode: 'exclusive', ifAvailable }, (lock) => body(lock !== null)) };
}

export function waitFor(ms, signal, timers = globalThis) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (complete) => { timers.clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(complete); };
    const abort = () => finish(false);
    const timer = timers.setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
