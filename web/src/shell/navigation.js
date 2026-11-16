import { captureError } from '../telemetry/sentry.js';

const CANCELLED = Object.freeze({ status: 'cancelled' });
const NAVIGATION_CONTEXT = Object.freeze({ kind: 'navigation' });
const coordinators = new WeakMap();

export function createNavigationCoordinator(browser, { report = (operation) => captureError('navigation', operation, '', '/app'), timeout = 1500 } = {}) {
  const listeners = new Set();
  const tasks = new Set();
  let disposed = false;
  let historyGeneration = 0;
  let unpublished = false;
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
  const blocked = (context = NAVIGATION_CONTEXT) => {
    try { return Boolean(guard?.blocked(context)); }
    catch { report('navigation-guard'); return true; }
  };
  const publish = (generation) => {
    if (generation === undefined) historyGeneration += 1;
    unpublished = false;
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
  const settle = (intent, result) => {
    if (intent.settled) return;
    intent.settled = true;
    intent.transaction?.revoke();
    tasks.delete(intent);
    if (pending === intent) {
      pending = null;
      phase = flight ? 'restoring' : 'idle';
    }
    intent.resolve(result);
  };
  const cancel = (intent) => settle(intent, CANCELLED);
  const retainUnknown = () => {
    const actual = snapshot();
    const interrupted = [...tasks];
    for (const intent of interrupted) intent.transaction?.revoke();
    reconciliations = [];
    clearFlight()?.resolve(false);
    phase = 'idle';
    try {
      if (failedRetention?.href === actual.href && failedRetention?.state === actual.state) return;
      if (blocked()) guard.onUnrestorableNavigation();
      failedRetention = null;
      stamp(actual, true);
      publish();
    } catch {
      failedRetention = actual;
      report('navigation-retain');
    } finally {
      for (const intent of interrupted) cancel(intent);
    }
  };
  const travel = (delta, target, restore = false) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const source = snapshot();
    const held = { target, source, restore, resolve, promise, timer: null };
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
    return promise;
  };
  const transaction = (intent) => {
    let working = accepted;
    let applied = working;
    let generation = null;
    let changed = false;
    let traversal = false;
    let closed = false;
    let revoked = false;
    const mutations = [];
    const active = () => !disposed && !revoked && !intent?.settled
      && (generation === null || generation === historyGeneration);
    const read = () => {
      if (!intent?.managed && generation === null) working = applied = flight ? accepted : observed;
      return working;
    };
    const acquire = () => {
      if (!active()) return false;
      if (generation !== null) return true;
      if (flight && (!intent?.managed || !flight.restore || !sameIndex(flight.target, indexOf(applied)))) {
        revoked = true;
        return false;
      }
      generation = ++historyGeneration;
      changed = unpublished;
      return true;
    };
    const replay = () => {
      if (!active()) return 'revoked';
      if (generation === null) return 'ready';
      if (flight || traversal) return 'waiting';
      while (active()) {
        const actual = snapshot();
        if (!sameIndex(indexOf(actual), indexOf(applied))) {
          if (intent?.managed && comparable(applied, actual)) {
            observed = actual;
            restore(applied);
            return 'waiting';
          }
          return 'revoked';
        }
        const mutation = mutations[0];
        if (!mutation) return 'ready';
        const { entry, push } = mutation;
        browser.history[push ? 'pushState' : 'replaceState'](entry.state, '', entry.href);
        mutations.shift();
        applied = entry;
        observed = entry;
        changed = true;
        unpublished = true;
      }
      return 'revoked';
    };
    const write = (href, state, push) => {
      if (closed || !active()) return;
      const current = read();
      if (!acquire()) return;
      const index = indexOf(current);
      const next = push ? { chain: index.chain, position: index.position + 1, entryId: identity() } : index;
      const url = new URL(href, current.href);
      working = { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash,
        state: { ...state, windmillHistory: next }, revision };
      mutations.push({ entry: working, push });
      replay();
    };
    const api = {
      read,
      pushEntry: (href, state) => write(href, state, true),
      replaceEntry: (href, state) => write(href, state, false),
      updateState: (update) => {
        const current = read();
        write(current.href, typeof update === 'function' ? update(current.state) : update, false);
      },
      navigate: (href, { replace = false } = {}) => {
        const current = read();
        const url = new URL(href, current.href);
        const path = url.pathname + url.search + url.hash;
        if (!replace && path === pathOf(current)) return;
        const previous = replace ? current.state?.windmillNavigation?.previous ?? null : pathOf(current);
        write(url.href, { ...(replace ? current.state : {}), windmillNavigation: { href: path, previous } }, !replace);
      },
      traverse: async (delta, target) => {
        if (closed || !active()) return false;
        read();
        if (!delta) return true;
        if (!acquire()) return false;
        while (active()) {
          const status = replay();
          if (status === 'ready') break;
          if (status === 'revoked' || !flight || !await flight.promise) return false;
        }
        if (!active()) return false;
        const index = indexOf(applied);
        traversal = true;
        const reached = await travel(delta, target ?? { chain: index.chain, position: index.position + delta });
        traversal = false;
        if (!reached || !active()) return false;
        working = applied = reached;
        changed = true;
        unpublished = true;
        return true;
      },
    };
    return {
      api,
      origin: () => applied,
      close(dropUnapplied) {
        closed = true;
        if (dropUnapplied) { mutations.length = 0; working = applied; }
      },
      revoke() { revoked = true; closed = true; mutations.length = 0; },
      reconcile(complete = false) {
        const status = replay();
        if (status !== 'ready') return status;
        if (complete && changed) { changed = false; publish(generation); }
        return 'ready';
      },
    };
  };
  const reconcile = (run) => {
    const tx = transaction(null);
    try {
      const result = run(tx.api);
      tx.close(false);
      tx.reconcile(true);
      return result;
    } catch (error) { report('navigation-reconcile'); throw error; }
  };
  const fail = (intent) => {
    if (!intent.failureReported) { intent.failureReported = true; report('navigation-commit'); }
    if (intent.settled) return;
    intent.outcome = CANCELLED;
    intent.transaction.close(true);
    advance(intent);
  };
  const advance = (intent) => {
    if (intent.settled || !intent.transaction) return;
    let status;
    try { status = intent.transaction.reconcile(intent.outcome !== null); }
    catch { fail(intent); return; }
    if (status === 'revoked') { cancel(intent); return; }
    if (status === 'ready' && intent.outcome) settle(intent, intent.outcome);
  };
  const resume = () => {
    if (disposed) return;
    for (const intent of [...tasks]) advance(intent);
    if (flight || !pending) return;
    if (pending.transaction) { phase = 'committing'; return; }
    if (pending.decided) commit(pending);
    else ask(pending);
  };
  const commit = (intent) => {
    if (intent.settled) return;
    if (intent.managed) phase = 'committing';
    intent.transaction = transaction(intent);
    const finish = (value) => {
      if (intent.settled || intent.outcome !== null) return;
      intent.outcome = { status: 'completed', value };
      intent.transaction.close(false);
      advance(intent);
    };
    try {
      const value = intent.run(intent.transaction.api);
      if (value && typeof value.then === 'function') value.then(finish, () => fail(intent));
      else finish(value);
    } catch { fail(intent); }
  };
  const ask = (intent) => {
    if (pending !== intent || intent.settled) return;
    phase = 'awaiting-decision';
    if (intent.asked) return;
    intent.asked = true;
    try {
      intent.owner.onBlocked({ token: intent.token, context: intent.context,
        proceed: () => {
          if (pending !== intent || intent.settled || intent.decided) return;
          intent.decided = true;
          if (flight) return;
          commit(intent);
        },
        cancel: () => {
          if (pending !== intent || intent.settled || intent.decided) return;
          intent.decided = true;
          cancel(intent);
        },
      });
    } catch {
      report('navigation-guard');
      if (!intent.decided) { intent.decided = true; cancel(intent); }
    }
  };
  const makeIntent = (key, run, context = NAVIGATION_CONTEXT) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const intent = { key, run, context, resolve, promise, token: identity(), owner: guard, managed: true,
      settled: false, asked: false, decided: false, outcome: null, failureReported: false };
    tasks.add(intent);
    return intent;
  };
  const restore = (origin) => {
    phase = 'restoring';
    const delta = indexOf(origin).position - indexOf(observed).position;
    travel(delta, indexOf(origin), true);
  };
  const follow = (event) => {
    const next = snapshot();
    if (sameEntry(next, observed)) return;
    const previous = observed;
    observed = next;
    if (failedRetention) { retainUnknown(); return; }
    if (flight) {
      const target = flight.target;
      const index = indexOf(next);
      if (!comparable(flight.source, next) || !comparable(previous, next) || index.chain !== target.chain
        || (index.position === target.position && target.entryId && index.entryId !== target.entryId)) {
        retainUnknown(); return;
      }
      if (index.position !== target.position) {
        const distance = target.position - index.position;
        if (flight.restore && !sameIndex(indexOf(previous), index)) {
          try { browser.history.go(distance); }
          catch { report('navigation-restore'); retainUnknown(); }
        }
        return;
      }
      const done = clearFlight();
      const deferred = reconciliations;
      reconciliations = [];
      if (done.restore && !pending?.decided && !pending?.transaction) {
        for (const entry of deferred) {
          if (!sameIndex(entry.index, indexOf(snapshot()))) continue;
          try { reconcile(entry.run); } catch { /* The system boundary already reported this failure. */ }
        }
      }
      done.resolve(next);
      queueMicrotask(resume);
      if (!pending) phase = 'idle';
      return;
    }
    if (pending) {
      pending.origin = pending.transaction?.origin() ?? pending.origin ?? accepted;
      if (!comparable(pending.origin, next)) { retainUnknown(); return; }
      if (!sameEntry(pending.origin, next)) restore(pending.origin);
      return;
    }
    if (blocked()) {
      if (!comparable(accepted, next)) { retainUnknown(); return; }
      const origin = accepted;
      const target = next;
      const intent = makeIntent(`history:${indexOf(target).entryId}`,
        (tx) => tx.traverse(indexOf(target).position - indexOf(origin).position, indexOf(target)));
      intent.origin = origin;
      pending = intent;
      restore(origin);
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
        if (pending?.owner === owner && (phase === 'awaiting-decision' || phase === 'restoring')
          && !pending.decided && !pending.transaction) cancel(pending);
        guard = null;
      };
    },
    request({ key, context, run }) {
      const kind = context === undefined ? 'navigation' : context?.kind;
      if (kind !== 'navigation' && kind !== 'sign-out') throw new TypeError('navigation-context-kind');
      const admission = Object.freeze({ kind });
      if (disposed) return Promise.resolve(CANCELLED);
      if (pending) return pending.key === key ? pending.promise : Promise.resolve(CANCELLED);
      if (flight || failedRetention) return Promise.resolve(CANCELLED);
      const intent = makeIntent(key, run, admission);
      intent.managed = guard !== null;
      if (intent.managed) pending = intent;
      if (blocked(intent.context)) ask(intent);
      else commit(intent);
      return intent.promise;
    },
    system(run) {
      if (flight || !sameEntry(snapshot(), accepted)) {
        reconciliations.push({ index: indexOf(accepted), run });
        return;
      }
      return reconcile(run);
    },
    dispose() {
      disposed = true;
      for (const intent of [...tasks]) cancel(intent);
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
