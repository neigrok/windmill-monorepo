import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LocalTreeRegistry, confirmDeviceOwner } from '../persistence/LocalTreeRegistry.js';
import { claimLocalTrees, onTreeClaimed } from '../sync/claimLocalTrees.js';
import { isOwnershipRefusal, isSessionRefusal } from '../sync/refusals.js';
import { syncSession } from '../../../platform/sync/session.js';

// Who holds this room: the session's lapse, the claim of device trees at sign-in, the demotion an ownership refusal forces,
// and the holder the room acts for. Signing in on a roadmap that loaded as someone else's loads it again, as a demotion
// does: it may be theirs. A room that reads the device's copy has the engine reconnect and its lineage rule take what
// the device holds at sign-in, so its session is neither reconnected nor handed to a claim.
export function useRoomAuthority({ treeId, status, account, refresh, knownReaderRef, room: { sessionRef, replicaRef, sceneRef } }) {
  const [lapsed, setLapsed] = useState(false);
  const [demotion, setDemotion] = useState(null); // { edits, cardOpen } | null
  const [claims, setClaims] = useState(0); // trees any tab's claims took from this device to the account
  const prevAuthRef = useRef(status);
  const suspectRef = useRef(false);
  const demotedRef = useRef(false);
  const writeDeniedRef = useRef(false);
  const claimRunRef = useRef(false);

  // Account authority comes from the shell; a lapse retains this document's device owner.
  useEffect(() => { if (account) confirmDeviceOwner(account.id); }, [account]);

  const kickClaim = useCallback(() => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    claimLocalTrees({ openTreeId: treeId, openSession: () => (replicaRef.current ? null : sessionRef.current) })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim();
  }, [kickClaim]);

  useEffect(() => onTreeClaimed(() => setClaims((count) => count + 1)), []);

  // A sign-in or sign-out must reconnect: the socket’s principal is fixed at connect.
  useEffect(() => {
    const reconnect = () => { if (!replicaRef.current) sessionRef.current?.forceReconnect(); };
    const prev = prevAuthRef.current;
    prevAuthRef.current = status;
    if (prev === status) return;
    if (status === 'signed-in') {
      if (demotedRef.current || (prev === 'ghost' && knownReaderRef.current)) { window.location.reload(); return; }
      setLapsed(false);
    }
    if (prev === 'loading' && status === 'signed-in') {
      kickClaim();
      return;
    }
    if (prev === 'ghost' && status === 'signed-in') {
      reconnect();
      kickClaim();
      return;
    }
    if (prev === 'signed-in') {
      if (suspectRef.current) { suspectRef.current = false; setLapsed(true); }
      reconnect();
    }
  }, [status, kickClaim]);

  useEffect(() => {
    let idleTimer = null;
    let waiting = false;
    let lastActivityAt = 0;
    const noteActivity = () => { lastActivityAt = Date.now(); };
    const stopWaiting = () => {
      window.removeEventListener('keydown', noteActivity, true);
      window.removeEventListener('pointerdown', noteActivity, true);
    };
    const demote = () => {
      waiting = false;
      if (demotedRef.current) { stopWaiting(); return; }
      const el = document.activeElement;
      const handsBusy = (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))
        || (sceneRef.current?.isPointerActive?.() ?? false);
      const idle = Date.now() - lastActivityAt >= 400;
      if (handsBusy && !idle) {
        waiting = true;
        window.addEventListener('keydown', noteActivity, true);
        window.addEventListener('pointerdown', noteActivity, true);
        idleTimer = setTimeout(demote, 400);
        return;
      }
      stopWaiting();
      demotedRef.current = true;
      sceneRef.current?.setReadOnly?.();
      setDemotion({ edits: sessionRef.current?.pendingEditCount?.() ?? 0, cardOpen: true });
    };
    const onForbidden = (event) => {
      if (isOwnershipRefusal(event.detail)) {
        writeDeniedRef.current = true;
        if (demotedRef.current || waiting) return;
        lastActivityAt = Date.now();
        demote();
        return;
      }
      if (!isSessionRefusal(event.detail)) return;
      if (suspectRef.current) return;
      suspectRef.current = true;
      refresh().then((me) => {
        const stillSignedIn = me !== undefined ? !!me : prevAuthRef.current === 'signed-in';
        if (stillSignedIn) suspectRef.current = false;
      });
    };
    window.addEventListener('wm-edit-forbidden', onForbidden);
    return () => {
      window.removeEventListener('wm-edit-forbidden', onForbidden);
      stopWaiting();
      clearTimeout(idleTimer);
    };
  }, [refresh]);

  return { lapsed, demotion, setDemotion, claims, sharedWritesAllowed: () => !writeDeniedRef.current };
}

const deviceTrees = new LocalTreeRegistry();
const quiet = () => () => {};

// Who holds the room as its owner, and where (`place`); null for anyone else. The room goes into trees, attaches them and
// says where it acts for its holder alone. Where the room reads the device's copy (`replica`), the engine's binding says:
// the owner's roadmap in the browser's anon replica is held by whoever is at the device until a sign-in's lineage rule
// takes it to an account, and one in a replica bound to the account is the account's, offline too, as its copy is.
// Elsewhere a tree that lives only on this device is held by whoever is at the device, signed in or not, until a claim
// takes it to the account (asked again whenever any tab's claim lands, `claims`, and whenever the account changes in this
// document); any other by the account once the server has answered for it in this document (`confirmed` in the shell's
// auth context; a page that starts with no connection stands on the cached account, which is not one) and while its
// session has not lapsed.
export function useRoomHolder({ owner, treeId, account, confirmed, lapsed, claims, replica = false, registry = deviceTrees }) {
  // Whether the replica the engine holds active is bound to an account, read again only as that answer changes, so the
  // room does not draw again at every publication of the engine.
  const { engine, ready } = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot);
  const active = ready ? engine : null;
  const bound = useSyncExternalStore(active?.observeEngine ?? quiet, () => active?.getSnapshot().state === 'bound');
  const onDevice = useMemo(() => !replica && owner && registry.onDevice(treeId) !== null, [replica, owner, treeId, claims, account?.id]);
  const accountId = owner && !onDevice && (replica || (confirmed && !lapsed)) ? account?.id ?? null : null;
  return useMemo(() => {
    if (replica && owner) return bound ? { place: 'account', account: accountId } : { place: 'device' };
    if (replica) return null;
    if (onDevice) return { place: 'device' };
    return accountId ? { place: 'account', account: accountId } : null;
  }, [replica, owner, bound, onDevice, accountId]);
}
