import { captureError } from '../telemetry/sentry.js';

const CANCELLED = Object.freeze({ status: 'cancelled' });
const coordinators = new WeakMap();

export function createNavigationCoordinator(browser, { report = (operation) => captureError('navigation', operation, '', '/app'), timeout = 1500 } = {}) {
  const listeners = new Set();
  let accepted;
  let observed;
  let guard = null;
  let pending = null;
  let phase = 'idle';
  let flight = null;
  let revision = 0;
  let failedRetention = null;
  let reconciliations = [];

  const snapshot = () => {
    const url = new URL(browser.location.href);
    return { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash, state: browser.history.state, revision };
  };
  const pathOf = (entry) => entry.pathname + entry.search + entry.hash;
  const indexOf = (entry) => entry?.state?.windmillHistory;
  const validIndex = (index) => typeof index?.chain === 'string' && typeof index?.entryId === 'string' && Number.isSafeInteger(index?.position) && index.position >= 0;
  const sameIndex = (a, b) => a?.chain === b?.chain && a?.entryId === b?.entryId && a?.position === b?.position;
  const sameEntry = (a, b) => a?.href === b?.href && sameIndex(indexOf(a), indexOf(b));
  const comparable = (a, b) => validIndex(indexOf(a)) && validIndex(indexOf(b)) && indexOf(a).chain === indexOf(b).chain
    && (indexOf(a).position === indexOf(b).position ? sameEntry(a, b) : indexOf(a).entryId !== indexOf(b).entryId);
  const identity = () => crypto.randomUUID();
  const blocked = () => {
    try { return Boolean(guard?.blocked()); }
    catch { report('navigation-guard'); return true; }
  };
  const publish = () => {
    observed = snapshot();
    accepted = { ...observed, revision: ++revision };
    reconciliations = reconciliations.filter((entry) => sameIndex(entry.index, indexOf(accepted)));
    if (pending?.origin && sameIndex(indexOf(pending.origin), indexOf(accepted))) pending.origin = accepted;
    for (const listener of [...listeners]) {
      try { listener(accepted); } catch { report('navigation-observer'); }
    }
  };
  const stamp = (entry, fresh = false, previous = null) => {
    const state = entry.state ?? {};
    const navigation = state.windmillNavigation?.href === pathOf(entry) ? state.windmillNavigation : { href: pathOf(entry), previous };
    const index = !fresh && validIndex(indexOf(entry)) ? indexOf(entry) : { chain: identity(), position: 0, entryId: identity() };
    browser.history.replaceState({ ...state, windmillNavigation: navigation, windmillHistory: index }, '', entry.href);
    observed = snapshot();
  };
  stamp(snapshot());
  accepted = observed;

  const clearFlight = () => {
    if (!flight) return;
    clearTimeout(flight.timer);
    const held = flight;
    flight = null;
    return held;
  };
  const cancel = (intent) => {
    if (intent.settled || (intent.managed && pending !== intent)) return;
    intent.settled = true;
    if (pending === intent) {
      pending = null;
      phase = flight ? 'restoring' : 'idle';
    }
    intent.resolve(CANCELLED);
  };
  const retainUnknown = () => {
    const actual = snapshot();
    reconciliations = [];
    const interrupted = pending;
    if (interrupted) cancel(interrupted);
    clearFlight()?.resolve(false);
    phase = 'idle';
    if (failedRetention?.href === actual.href && failedRetention?.state === actual.state) return;
    try {
      if (blocked()) guard.onUnrestorableNavigation();
    } catch {
      failedRetention = actual;
      report('navigation-retain');
      return;
    }
    failedRetention = null;
    stamp(actual, true);
    publish();
  };
  const travel = (delta, target, restore = false) => new Promise((resolve) => {
    if (!delta) { resolve(true); return; }
    const held = { target, restore, resolve, timer: null };
    flight = held;
    held.timer = setTimeout(() => {
      if (flight !== held) return;
      report(restore ? 'navigation-restore' : 'navigation-traverse');
      retainUnknown();
    }, timeout);
    try { browser.history.go(delta); }
    catch {
      report(restore ? 'navigation-restore' : 'navigation-traverse');
      retainUnknown();
    }
  });
  const transaction = (intent) => {
    let changed = false;
    const active = () => !intent || (!intent.settled && (!intent.managed || pending === intent));
    const write = (href, state, push) => {
      if (!active()) return;
      const current = snapshot();
      const index = indexOf(current);
      const next = push ? { chain: index.chain, position: index.position + 1, entryId: identity() } : index;
      browser.history[push ? 'pushState' : 'replaceState']({ ...state, windmillHistory: next }, '', new URL(href, current.href).href);
      observed = snapshot();
      changed = true;
    };
    const tx = {
      read: () => snapshot(),
      pushEntry: (href, state) => write(href, state, true),
      replaceEntry: (href, state) => write(href, state, false),
      updateState: (update) => {
        const current = snapshot();
        write(current.href, typeof update === 'function' ? update(current.state) : update, false);
      },
      navigate: (href, { replace = false } = {}) => {
        const current = snapshot();
        const url = new URL(href, current.href);
        const path = url.pathname + url.search + url.hash;
        if (!replace && path === pathOf(current)) return;
        const previous = replace ? current.state?.windmillNavigation?.previous ?? null : pathOf(current);
        write(url.href, { ...(replace ? current.state : {}), windmillNavigation: { href: path, previous } }, !replace);
      },
      traverse: async (delta) => {
        if (!active()) return false;
        const current = snapshot();
        const moved = await travel(delta, { chain: indexOf(current).chain, position: indexOf(current).position + delta });
        if (moved) changed = true;
        return moved;
      },
      flush: () => { if (changed) { changed = false; publish(); } },
    };
    return tx;
  };
  const reconcile = (run) => {
    const tx = transaction(null);
    try {
      const result = run(tx);
      tx.flush();
      return result;
    } catch (error) { report('navigation-reconcile'); throw error; }
  };
  const commit = (intent) => {
    if (intent.settled || (intent.managed && pending !== intent)) return;
    if (intent.managed) phase = 'committing';
    intent.committing = true;
    const tx = transaction(intent);
    const finish = (value) => {
      if (intent.settled || (intent.managed && pending !== intent)) return;
      intent.settled = true;
      if (pending === intent) { pending = null; phase = 'idle'; }
      tx.flush();
      intent.resolve({ status: 'completed', value });
    };
    const fail = () => {
      if (intent.settled || (intent.managed && pending !== intent)) return;
      report('navigation-commit');
      tx.flush();
      cancel(intent);
    };
    try {
      const value = intent.run(tx);
      if (value && typeof value.then === 'function') value.then(finish, fail);
      else finish(value);
    } catch { fail(); }
  };
  const ask = (intent) => {
    if (pending !== intent || intent.settled) return;
    phase = 'awaiting-decision';
    if (intent.asked) return;
    intent.asked = true;
    try {
      intent.owner.onBlocked({ token: intent.token,
        proceed: () => {
          if (pending !== intent || intent.settled || intent.decided) return;
          intent.decided = true;
          if (flight) { intent.proceedAfterRestore = true; return; }
          commit(intent);
        },
        cancel: () => cancel(intent),
      });
    } catch { report('navigation-guard'); cancel(intent); }
  };
  const makeIntent = (key, run) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { key, run, resolve, promise, token: identity(), owner: guard, managed: true, settled: false, asked: false, decided: false };
  };
  const restore = (intent) => {
    phase = 'restoring';
    const delta = indexOf(intent.origin).position - indexOf(observed).position;
    travel(delta, indexOf(intent.origin), true).then((restored) => {
      if (!restored || pending !== intent) return;
      if (intent.committing) { phase = 'committing'; return; }
      if (intent.proceedAfterRestore) commit(intent);
      else ask(intent);
    });
  };
  const follow = (event) => {
    const next = snapshot();
    if (sameEntry(next, observed)) return;
    observed = next;
    if (failedRetention) { retainUnknown(); return; }
    if (flight) {
      const target = flight.target;
      if (!comparable(accepted, next)) { retainUnknown(); return; }
      if (indexOf(next).chain !== target.chain || indexOf(next).position !== target.position
        || (target.entryId && indexOf(next).entryId !== target.entryId)) return;
      const done = clearFlight();
      const deferred = reconciliations;
      reconciliations = [];
      if (done.restore && !pending?.decided) {
        for (const entry of deferred) {
          if (!sameIndex(entry.index, indexOf(snapshot()))) continue;
          try { reconcile(entry.run); } catch { /* The system boundary already reported this failure. */ }
        }
      }
      done.resolve(true);
      if (!pending) phase = 'idle';
      return;
    }
    if (pending) {
      pending.origin ??= accepted;
      if (!comparable(pending.origin, next)) { retainUnknown(); return; }
      if (!sameEntry(pending.origin, next)) restore(pending);
      return;
    }
    if (blocked()) {
      if (!comparable(accepted, next)) { retainUnknown(); return; }
      const origin = accepted;
      const target = next;
      const intent = makeIntent(`history:${indexOf(target).entryId}`, async () => {
        const moved = await travel(indexOf(target).position - indexOf(snapshot()).position, indexOf(target));
        if (moved && pending === intent) publish();
      });
      intent.origin = origin;
      pending = intent;
      restore(intent);
      return;
    }
    if (!validIndex(indexOf(next)) || !comparable(accepted, next)) {
      const source = event?.oldURL ? new URL(event.oldURL) : null;
      const previous = source?.origin === browser.location.origin ? source.pathname + source.search + source.hash
        : next.pathname === accepted.pathname && next.search === accepted.search && next.hash !== accepted.hash ? pathOf(accepted) : null;
      stamp(next, true, previous);
    }
    publish();
  };
  browser.addEventListener('popstate', follow);
  browser.addEventListener('hashchange', follow);

  return {
    read: () => accepted,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    register({ blocked, onBlocked, onUnrestorableNavigation }) {
      if (guard) throw new Error('navigation-guard-already-registered');
      if (typeof blocked !== 'function' || typeof onBlocked !== 'function' || typeof onUnrestorableNavigation !== 'function')
        throw new Error('navigation-guard-callbacks-required');
      const owner = { blocked, onBlocked, onUnrestorableNavigation };
      guard = owner;
      return () => {
        if (guard !== owner) return;
        if (pending?.owner === owner && (phase === 'awaiting-decision' || (phase === 'restoring' && !pending.committing))) cancel(pending);
        guard = null;
      };
    },
    request({ key, run }) {
      if (pending) return pending.key === key ? pending.promise : Promise.resolve(CANCELLED);
      if (flight || failedRetention) return Promise.resolve(CANCELLED);
      const intent = makeIntent(key, run);
      intent.managed = guard !== null;
      if (intent.managed) pending = intent;
      if (blocked()) ask(intent);
      else commit(intent);
      return intent.promise;
    },
    system(run) {
      if (!sameEntry(snapshot(), accepted)) {
        reconciliations.push({ index: indexOf(accepted), run });
        return;
      }
      return reconcile(run);
    },
    dispose() {
      if (pending) cancel(pending);
      clearFlight()?.resolve(false);
      browser.removeEventListener('popstate', follow);
      browser.removeEventListener('hashchange', follow);
      listeners.clear();
      reconciliations = [];
    },
  };
}

export function initializeNavigation() {
  if (!coordinators.has(window)) coordinators.set(window, createNavigationCoordinator(window));
  return coordinators.get(window);
}

export const readNavigation = () => initializeNavigation().read();
export const subscribeNavigation = (listener) => initializeNavigation().subscribe(listener);
export const registerNavigationGuard = (guard) => initializeNavigation().register(guard);
export const requestNavigation = (request) => initializeNavigation().request(request);
export const pushEntry = (href, state) => initializeNavigation().system((tx) => tx.pushEntry(href, state));
export const replaceEntry = (href, state) => initializeNavigation().system((tx) => tx.replaceEntry(href, state));
export const updateNavigationState = (update) => initializeNavigation().system((tx) => tx.updateState(update));
export const replaceLocation = (href) => initializeNavigation().system((tx) => tx.navigate(href, { replace: true }));
export const navigate = (href, options) => requestNavigation({ key: `navigate:${href}`, run: (tx) => tx.navigate(href, options) });

export function previousLocation() {
  const location = readNavigation();
  const entry = location.state?.windmillNavigation;
  if (entry?.href !== location.pathname + location.search + location.hash || typeof entry.previous !== 'string') return null;
  if (!entry.previous.startsWith('/')) return null;
  try {
    const previous = new URL(entry.previous, location.href);
    if (previous.origin !== new URL(location.href).origin) return null;
    return previous.pathname + previous.search + previous.hash;
  } catch { return null; }
}

export function returnToPreviousLocation() {
  return requestNavigation({ key: 'return', run: (tx) => {
    if (previousLocation()) return tx.traverse(-1);
    tx.navigate('/app', { replace: true });
  } });
}
