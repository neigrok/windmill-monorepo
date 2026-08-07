// The canvas's data, bound to React. Everything that decides anything lives in pageStore.js — the
// device cache, the window read, the write ordering, the stamp rule — so this file is only the
// three things React actually owns: one store per mounted canvas, a subscription to its snapshot,
// and the auth status that tells it whether there is an account to sync with.
//
// The store is connected on every settled change of who is signed in, because that flip is the
// claim: signing in sends everything written on this device while nobody was, oldest first.
// 'loading' is deliberately not a connect — a status nobody has resolved yet is not a signed-out
// writer, and treating it as one would say "saved on this device" about a page bound for an account.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { PageStore } from './pageStore.js';

export function usePages() {
  const { status } = useAuth();
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = new PageStore();
  const store = storeRef.current;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    if (status === 'loading') return;
    store.connect(status === 'signed-in');
  }, [store, status]);

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
