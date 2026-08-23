// Owns the on-device index: the first open builds the lexical index, then the neural model loads in the
// background and the same corpus is rebuilt, swapped in with a `version` bump so a query on screen
// re-ranks. If the model never loads, search stays lexical, and the query never leaves the device either
// way. The corpus is the account's pages and this device's (pageStore.js `corpus`); `source` rides out
// with the results. The index belongs to one account and is dropped when `account` changes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { corpus } from '../pageStore.js';
import { SearchIndex } from './searchIndex.js';
import { LexicalEmbedder } from './embedders.js';
import { NeuralEmbedder } from './neural/neuralEmbedder.js';

export function useSearch(active, account = null) {
  const activeIndexRef = useRef(null);
  const neuralRef = useRef(null);
  const aliveRef = useRef(true);
  const builtForRef = useRef(undefined);   // the account the live index was built for
  const [ready, setReady] = useState(false);      // lexical index built — search is usable
  const [indexing, setIndexing] = useState(false); // the one-time lexical build
  const [sharpening, setSharpening] = useState(false); // neural index building in the background
  const [mode, setMode] = useState('lexical');    // which embedder the active index uses
  const [version, setVersion] = useState(0);       // bumps when the active index changes, to re-rank
  const [source, setSource] = useState('account'); // where the indexed pages came from

  useEffect(() => {
    if (builtForRef.current === account) return;
    // Whatever is in hand was built for somebody else: it stops answering the moment the account changes.
    activeIndexRef.current = null;
    setReady(false);
    setMode('lexical');
    if (!active) return;   // rebuilt on the next open, for whoever is signed in by then
    builtForRef.current = account;
    const generation = account;
    (async () => {
      setIndexing(true);
      const read = await corpus({ account });
      const pages = read.pages;
      if (!aliveRef.current || builtForRef.current !== generation) return;
      setSource(read.source);

      const lexical = new SearchIndex(new LexicalEmbedder());
      await lexical.ingest(pages);
      if (!aliveRef.current || builtForRef.current !== generation) return;
      activeIndexRef.current = lexical;
      setReady(true);
      setIndexing(false);
      setVersion((v) => v + 1);

      try {
        const neural = new NeuralEmbedder();
        neuralRef.current = neural;
        await neural.ready;
        if (!aliveRef.current || builtForRef.current !== generation) return;
        setSharpening(true);
        const meaning = new SearchIndex(neural);
        await meaning.ingest(pages);
        if (!aliveRef.current || builtForRef.current !== generation) return;
        activeIndexRef.current = meaning;
        setMode('neural');
        setSharpening(false);
        setVersion((v) => v + 1);
      } catch {
        if (aliveRef.current) setSharpening(false);   // no model — search stays lexical, silently
      }
    })();
  }, [active, account]);

  useEffect(() => () => { aliveRef.current = false; neuralRef.current?.dispose(); }, []);

  const search = useCallback(async (text) => {
    const index = activeIndexRef.current;
    if (!index || !text.trim()) return [];
    return index.query(text.trim());
  }, []);

  return { ready, indexing, sharpening, mode, version, source, search };
}
