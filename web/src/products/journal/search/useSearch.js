// Owns the on-device index for the canvas, and sharpens it in place. The first time search opens it
// pulls the whole corpus once and builds the instant lexical index, so ⌘K answers immediately. Then,
// in the background, it loads the neural model and rebuilds the same corpus as a meaning index; when
// that's ready it swaps in and bumps `version`, so a query already on screen re-ranks from "shares your
// words" to "shares your meaning" without a flicker. If the model never loads, search simply stays
// lexical — there's no broken state to explain. The query never leaves the device either way.
//
// The corpus is the account's pages AND this device's (pageStore.js `corpus`), never the account's
// alone: a signed-out writer's pages are real pages that live on this device, and ⌘K was blind to
// every one of them. `source` rides out with the results so the overlay can say when it is searching
// a journal it could not read all of, rather than answering "nothing close to that yet."

import { useCallback, useEffect, useRef, useState } from 'react';
import { corpus } from '../pageStore.js';
import { SearchIndex } from './searchIndex.js';
import { LexicalEmbedder } from './embedders.js';
import { NeuralEmbedder } from './neural/neuralEmbedder.js';

export function useSearch(active, signedIn = true) {
  const activeIndexRef = useRef(null);
  const neuralRef = useRef(null);
  const aliveRef = useRef(true);
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);      // lexical index built — search is usable
  const [indexing, setIndexing] = useState(false); // the one-time lexical build
  const [sharpening, setSharpening] = useState(false); // neural index building in the background
  const [mode, setMode] = useState('lexical');    // which embedder the active index uses
  const [version, setVersion] = useState(0);       // bumps when the active index changes, to re-rank
  const [source, setSource] = useState('account'); // where the indexed pages came from

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      setIndexing(true);
      const read = await corpus({ signedIn });
      const pages = read.pages;
      if (!aliveRef.current) return;
      setSource(read.source);

      const lexical = new SearchIndex(new LexicalEmbedder());
      await lexical.ingest(pages);
      if (!aliveRef.current) return;
      activeIndexRef.current = lexical;
      setReady(true);
      setIndexing(false);
      setVersion((v) => v + 1);

      try {
        const neural = new NeuralEmbedder();
        neuralRef.current = neural;
        await neural.ready;
        if (!aliveRef.current) return;
        setSharpening(true);
        const meaning = new SearchIndex(neural);
        await meaning.ingest(pages);
        if (!aliveRef.current) return;
        activeIndexRef.current = meaning;
        setMode('neural');
        setSharpening(false);
        setVersion((v) => v + 1);
      } catch {
        if (aliveRef.current) setSharpening(false);   // no model — search stays lexical, silently
      }
    })();
  }, [active, signedIn]);

  useEffect(() => () => { aliveRef.current = false; neuralRef.current?.dispose(); }, []);

  const search = useCallback(async (text) => {
    const index = activeIndexRef.current;
    if (!index || !text.trim()) return [];
    return index.query(text.trim());
  }, []);

  return { ready, indexing, sharpening, mode, version, source, search };
}
