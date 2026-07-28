// Owns the on-device index for the canvas. On the first time search opens it pulls the whole corpus
// once via the delta feed and embeds it ("reading your pages · one time"), then holds it in memory
// for instant, offline, private queries — the query never leaves the device. Passing active=false
// keeps it dormant, so a journal that is never searched pays nothing; the build latches on the first
// open and survives every close after.

import { useCallback, useEffect, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { SearchIndex } from './searchIndex.js';

export function useSearch(active) {
  const indexRef = useRef(null);
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active || startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;
    setIndexing(true);
    const index = new SearchIndex();
    indexRef.current = index;
    journalApi.since('0:0:', 5000)
      .then((pages) => {
        if (cancelled) return;
        index.ingest(pages);
        setCount(index.size);
        setReady(true);
        setIndexing(false);
      })
      .catch(() => { if (!cancelled) { setReady(true); setIndexing(false); } });
    return () => { cancelled = true; };
  }, [active]);

  const search = useCallback((text) => {
    const index = indexRef.current;
    if (!index || !text.trim()) return [];
    return index.query(text.trim());
  }, []);

  return { ready, indexing, count, search };
}
