import { useMemo, useSyncExternalStore } from 'react';
import { syncSession } from './session.js';

const EMPTY = Object.freeze({ replica: null, drawn: [], stored: [], notices: [], undoOffers: [], firstPullComplete: false });
const boot = { subscribe: () => () => {}, getSnapshot: () => null };
const idle = { subscribe: () => () => {}, getSnapshot: () => EMPTY };

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
