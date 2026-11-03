import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmDeviceOwner } from './persistence/LocalTreeRegistry.js';
import { claimLocalTrees } from './sync/claimLocalTrees.js';
import { isOwnershipRefusal, isSessionRefusal } from './sync/refusals.js';

// Who holds this room: the session's lapse, the claim of device trees at sign-in, and the demotion an ownership refusal forces.
export function useRoomAuthority({ treeId, status, account, refresh, collabRef, sceneRef }) {
  const [lapsed, setLapsed] = useState(false);
  const [demotion, setDemotion] = useState(null); // { edits, cardOpen } | null
  const prevAuthRef = useRef(status);
  const suspectRef = useRef(false);
  const demotedRef = useRef(false);
  const claimRunRef = useRef(false);

  // Account authority comes from the shell; a lapse retains this document's device owner.
  useEffect(() => { if (account) confirmDeviceOwner(account.id); }, [account]);

  const kickClaim = useCallback(() => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    claimLocalTrees({ openTreeId: treeId, openSession: () => collabRef.current })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim();
  }, [kickClaim]);

  // A sign-in or sign-out must reconnect: the socket’s principal is fixed at connect.
  useEffect(() => {
    const prev = prevAuthRef.current;
    prevAuthRef.current = status;
    if (prev === status) return;
    if (status === 'signed-in') {
      if (demotedRef.current) { window.location.reload(); return; }
      setLapsed(false);
    }
    if (prev === 'loading' && status === 'signed-in') {
      kickClaim();
      return;
    }
    if (prev === 'ghost' && status === 'signed-in') {
      collabRef.current?.forceReconnect();
      kickClaim();
      return;
    }
    if (prev === 'signed-in') {
      if (suspectRef.current) { suspectRef.current = false; setLapsed(true); }
      collabRef.current?.forceReconnect();
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
      setDemotion({ edits: collabRef.current?.pendingEditCount?.() ?? 0, cardOpen: true });
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

  return { lapsed, demotion, setDemotion };
}
