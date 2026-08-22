// The canvas's data, bound to React. Everything that decides anything lives in pageStore.js — the
// device cache, the window read, the write ordering, the stamp rule — so this file is only the
// three things React actually owns: one store per mounted canvas, a subscription to its snapshot,
// and the auth status that tells it whether there is an account to sync with.
//
// The store is connected on every settled change of WHO is signed in — the account id, not merely
// the fact of a session — because that id is what the device tier is scoped by (pageCache.js) and a
// change of it is either the claim or a hand-over. Signing in sends everything written on this
// device while nobody was, oldest first; signing in as somebody else opens their own scope and
// leaves the previous account's pages where they are, unreadable from here.
//
// `account` and not `user`: the shell paints the face from a remembered hint on the first frame,
// but a hint is the DEVICE claiming an identity, and a device cannot tell its owner from a stranger
// holding it. `account` is only ever an id the server confirmed on this document load, so a cold
// boot with no network opens the anonymous scope rather than the remembered person's pages.
// 'loading' is deliberately not a connect — a status nobody has resolved yet is not a signed-out
// writer, and treating it as one would say "saved on this device" about a page bound for an account.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { PageStore, holdStore } from './pageStore.js';

export function usePages() {
  const { status, account: confirmed } = useAuth();
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = new PageStore();
  const store = storeRef.current;
  const account = confirmed?.id ?? null;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    if (status === 'loading') return;
    store.connect(account);
  }, [store, status, account]);

  // The shell's forgetDevice reaches the canvas through here (routes.js): a store is only
  // forgettable while a canvas is holding it.
  useEffect(() => holdStore(store), [store]);

  useEffect(() => () => store.dispose(), [store]);

  return {
    ...snapshot,
    setBody: useCallback((body) => store.type(body), [store]),
    toggleMood: useCallback((step) => store.tap('mood', step), [store]),
    toggleEnergy: useCallback((step) => store.tap('energy', step), [store]),
    extendTo: useCallback((date) => store.extendTo(date), [store]),
    reachBack: useCallback(() => store.reachBack(), [store]),
  };
}
