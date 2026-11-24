import { useMemo, useSyncExternalStore } from 'react';
import { syncSession } from './session.js';

const EMPTY = Object.freeze({ replica: null, drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 },
  loaded: false, notices: [], undoOffers: [], firstPullComplete: false });
const NO_NOTICES = Object.freeze({ replica: null, notices: Object.freeze([]) });
const boot = { subscribe: () => () => {}, getSnapshot: () => null };
const idle = { subscribe: () => () => {}, getSnapshot: () => EMPTY };
const quiet = { subscribe: () => () => {}, getSnapshot: () => NO_NOTICES };

function useSession() {
  return useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
}

// The replica the open engine holds, whoever it is for: `{ engine, id, state }`, `state` being `bound` (its session
// paused or not) or `anon`; null while the engine is not open. A room that opens from the copy draws from it, and waits
// for no answer from the network.
export function useSyncReplica() {
  const session = useSession();
  const snapshot = useSyncExternalStore(session.engine?.observeEngine ?? boot.subscribe, session.engine?.getSnapshot ?? boot.getSnapshot, boot.getSnapshot);
  const open = session.ready && snapshot !== null;
  return useMemo(() => (open ? { engine: session.engine, id: snapshot.replica, state: snapshot.state } : null),
    [open, session.engine, snapshot?.replica, snapshot?.state]);
}

// The engine of a bound replica whose account the shell has settled, or null during boot and sign-out.
export function useSyncEngine() {
  const session = useSession();
  const replica = useSyncReplica();
  return session.signedIn && replica?.state === 'bound' ? replica.engine : null;
}

export function useSyncRecords(scope) {
  const session = useSession();
  const observation = useMemo(() => session.ready ? session.engine.observe(scope) : idle, [session.engine, session.ready, scope]);
  return useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
}

export function useSyncNotices(product) {
  const session = useSession();
  const observation = useMemo(() => session.ready ? session.engine.observeNotices(product) : quiet, [session.engine, session.ready, product]);
  return useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
}
