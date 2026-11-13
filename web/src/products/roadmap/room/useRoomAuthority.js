import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LocalTreeRegistry, confirmDeviceOwner } from '../persistence/LocalTreeRegistry.js';
import { claimLocalTrees, onTreeClaimed } from '../sync/claimLocalTrees.js';
import { isOwnershipRefusal, isSessionRefusal } from '../sync/refusals.js';

// Who holds this room: the session's lapse, the claim of device trees at sign-in, the demotion an ownership refusal forces,
// and the holder the room acts for. Signing in on a roadmap that loaded as someone else's loads it again, as a demotion
// does: it may be theirs.
export function useRoomAuthority({ treeId, status, account, refresh, knownReaderRef, room: { sessionRef, sceneRef } }) {
  const [lapsed, setLapsed] = useState(false);
  const [demotion, setDemotion] = useState(null); // { edits, cardOpen } | null
  const [claims, setClaims] = useState(0); // trees any tab's claims took from this device to the account
  const prevAuthRef = useRef(status);
  const suspectRef = useRef(false);
  const demotedRef = useRef(false);
  const claimRunRef = useRef(false);

  // Account authority comes from the shell; a lapse retains this document's device owner.
  useEffect(() => { if (account) confirmDeviceOwner(account.id); }, [account]);

  const kickClaim = useCallback(() => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    claimLocalTrees({ openTreeId: treeId, openSession: () => sessionRef.current })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim();
  }, [kickClaim]);

  useEffect(() => onTreeClaimed(() => setClaims((count) => count + 1)), []);

  // A sign-in or sign-out must reconnect: the socket’s principal is fixed at connect.
  useEffect(() => {
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
      sessionRef.current?.forceReconnect();
      kickClaim();
      return;
    }
    if (prev === 'signed-in') {
      if (suspectRef.current) { suspectRef.current = false; setLapsed(true); }
      sessionRef.current?.forceReconnect();
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

  return { lapsed, demotion, setDemotion, claims };
}

const deviceTrees = new LocalTreeRegistry();

// Who holds the room as its owner, and where (`place`): on a tree that lives only on this device, whoever is at the device,
// signed in or not, until a claim takes the tree to the account (asked again whenever any tab's claim lands, `claims`, and
// whenever the account changes in this document); on any other,
// the account once the server has answered for it in this document (`confirmed` in the shell's auth context; a page that
// starts with no connection stands on the cached account, which is not one) and while its session has not lapsed. Null for
// anyone else. The room goes into trees, attaches them and says where it acts for its holder alone.
export function useRoomHolder({ owner, treeId, account, confirmed, lapsed, claims, registry = deviceTrees }) {
  const onDevice = useMemo(() => owner && registry.onDevice(treeId) !== null, [owner, treeId, claims, account?.id]);
  const accountId = owner && !onDevice && confirmed && !lapsed ? account?.id ?? null : null;
  return useMemo(() => {
    if (onDevice) return { place: 'device' };
    return accountId ? { place: 'account', account: accountId } : null;
  }, [onDevice, accountId]);
}
