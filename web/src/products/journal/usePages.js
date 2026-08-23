// One store per mounted canvas; everything that decides anything lives in pageStore.js. Connected on
// every settled change of the confirmed account id, which is what the device tier is scoped by
// (pageCache.js) — never the shell's remembered hint. 'loading' is not a connect: an unresolved status is
// not a signed-out writer.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { localDay, watchLocalDay } from './hlc.js';
import { PageStore, holdStore } from './pageStore.js';

// One clock for the whole room, so the canvas, the echoes and the year grid never stand on different days.
export function useToday() {
  const [today, setToday] = useState(localDay);
  useEffect(() => watchLocalDay(setToday), []);
  return today;
}

export function usePages() {
  const { status, account: confirmed } = useAuth();
  const today = useToday();
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = new PageStore();
  const store = storeRef.current;
  const account = confirmed?.id ?? null;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    if (status === 'loading') return;
    store.connect(account);
  }, [store, status, account]);

  // Ordered after connect: a rollover reads the account's window and needs to know whose journal it is.
  useEffect(() => {
    store.rollOver(today);
  }, [store, today]);

  // A store is only forgettable while a canvas is holding it.
  useEffect(() => holdStore(store), [store]);

  useEffect(() => () => store.dispose(), [store]);

  return {
    ...snapshot,
    setBody: useCallback((body) => store.type(body), [store]),
    setMood: useCallback((value) => store.set('mood', value), [store]),
    setEnergy: useCallback((value) => store.set('energy', value), [store]),
    extendTo: useCallback((date) => store.extendTo(date), [store]),
    reachBack: useCallback(() => store.reachBack(), [store]),
  };
}
