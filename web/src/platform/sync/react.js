import { useMemo, useSyncExternalStore } from 'react';
import { syncSession } from './session.js';

const EMPTY = Object.freeze({ replica: null, drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 },
  loaded: false, notices: [], undoOffers: [], firstPullComplete: false });
const NO_NOTICES = Object.freeze({ replica: null, notices: Object.freeze([]) });
const boot = { subscribe: () => () => {}, getSnapshot: () => null };
const idle = { subscribe: () => () => {}, getSnapshot: () => EMPTY };
const quiet = { subscribe: () => () => {}, getSnapshot: () => NO_NOTICES };

export function useSyncEngine() {
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const state = useSyncExternalStore(session.engine?.observeEngine ?? boot.subscribe, session.engine?.getSnapshot ?? boot.getSnapshot, boot.getSnapshot);
  return session.ready && session.signedIn && state?.state === 'bound' ? session.engine : null;
}

export function useSyncRecords(scope) {
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const observation = useMemo(() => session.ready ? session.engine.observe(scope) : idle, [session.engine, session.ready, scope]);
  return useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
}

export function useSyncNotices(product) {
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const observation = useMemo(() => session.ready ? session.engine.observeNotices(product) : quiet, [session.engine, session.ready, product]);
  return useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
}
