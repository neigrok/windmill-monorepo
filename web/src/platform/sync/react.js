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

// The replica the open engine holds, as this tab draws it: `{ engine, state, account, binding }`, `state` being `bound`
// (its session paused or not) or `anon`, and `binding` the engine's, which a re-identify keeps and a sign-in or a sign-out
// changes. It is drawn whether or not the account has answered, and waits for nothing from the network; null while the
// engine is not open, and while the shell has settled an account the replica is not bound to, as when another tab moved
// the engine first, until the shell catches up.
export function useSyncReplica() {
  const session = useSession();
  const snapshot = useSyncExternalStore(session.engine?.observeEngine ?? boot.subscribe, session.engine?.getSnapshot ?? boot.getSnapshot, boot.getSnapshot);
  const drawn = session.ready && snapshot !== null && (!session.account || snapshot.account === session.account);
  return useMemo(() => (drawn ? { engine: session.engine, state: snapshot.state, account: snapshot.account, binding: snapshot.binding } : null),
    [drawn, session.engine, snapshot?.binding, snapshot?.state]);
}

// The engine of a bound replica whose account the shell has settled, or null during boot and sign-out.
export function useSyncEngine() {
  const session = useSession();
  const replica = useSyncReplica();
  return session.signedIn && replica?.state === 'bound' ? replica.engine : null;
}

// The scope's snapshot of the replica this tab draws, held for the document; the placeholder while it draws none, so no
// room draws another seat's records.
export function useSyncRecords(scope) {
  const session = useSession();
  const replica = useSyncReplica();
  const observation = useMemo(() => session.ready ? session.engine.observe(scope) : idle, [session.engine, session.ready, scope]);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
  return replica ? snapshot : EMPTY;
}

// The product's notices in the replica this tab draws, the same way.
export function useSyncNotices(product) {
  const session = useSession();
  const replica = useSyncReplica();
  const observation = useMemo(() => session.ready ? session.engine.observeNotices(product) : quiet, [session.engine, session.ready, product]);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
  return replica ? snapshot : NO_NOTICES;
}
