// Indexes the active replica's pages locally, starting lexical and re-ranking when the neural model loads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { corpus, SCOPE } from '../pages.js';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { captureError } from '../../../telemetry/sentry.js';
import { track } from '../../../telemetry/beacon.js';
import { SearchIndex } from './searchIndex.js';
import { LexicalEmbedder } from './lexicalEmbedder.js';

export function useSearch(active, account = null) {
  const records = useSyncRecords(SCOPE);
  const build = useRef(0);
  const activeIndexRef = useRef(null);
  const neuralRef = useRef(null);
  const aliveRef = useRef(true);
  const builtForRef = useRef(undefined);   // the account the live index was built for
  const [ready, setReady] = useState(false);      // lexical index built — search is usable
  const [indexing, setIndexing] = useState(false); // the one-time lexical build
  const [sharpening, setSharpening] = useState(false); // neural index building in the background
  const [mode, setMode] = useState('lexical');    // which embedder the active index uses
  const [needsConnection, setNeedsConnection] = useState(false); // the model could not come up without one
  const [version, setVersion] = useState(0);       // bumps when the active index changes, to re-rank
  const [source, setSource] = useState('account'); // where the indexed pages came from

  useEffect(() => {
    if (!active) return;
    // Whatever is in hand was built for somebody else: it stops answering the moment the account changes.
    activeIndexRef.current = null;
    setReady(false);
    setMode('lexical');
    setNeedsConnection(false);
    builtForRef.current = { account, replica: records.replica };
    const generation = ++build.current;
    neuralRef.current?.dispose();
    (async () => {
      setIndexing(true);
      const read = corpus({ account });
      const pages = read.pages;
      if (!aliveRef.current || build.current !== generation) return;
      setSource(read.source);

      const lexical = new SearchIndex(new LexicalEmbedder());
      await lexical.ingest(pages);
      if (!aliveRef.current || build.current !== generation) return;
      activeIndexRef.current = lexical;
      setReady(true);
      setIndexing(false);
      setVersion((v) => v + 1);

      try {
        const { NeuralEmbedder } = await import('./neural/neuralEmbedder.js');
        if (!aliveRef.current || build.current !== generation) return;
        const neural = new NeuralEmbedder();
        neuralRef.current = neural;
        await neural.ready;
        if (!aliveRef.current || build.current !== generation) return;
        setSharpening(true);
        const meaning = new SearchIndex(neural);
        await meaning.ingest(pages);
        if (!aliveRef.current || build.current !== generation) return;
        activeIndexRef.current = meaning;
        setMode('neural');
        setSharpening(false);
        setVersion((v) => v + 1);
        track('journal_search_meaning', { outcome: 'ready' });
      } catch {
        if (!aliveRef.current || build.current !== generation) return;
        setSharpening(false);
        // Search stays lexical. Offline, what meaning lacks comes with a connection; online, the model failing is a fault.
        const offline = globalThis.navigator?.onLine === false;
        setNeedsConnection(offline);
        track('journal_search_meaning', { outcome: offline ? 'needs_connection' : 'failed' });
        if (!offline) captureError('journal', 'journal-search-meaning', '', '/journal');
      }
    })();
  }, [active, account, records]);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; build.current++; neuralRef.current?.dispose(); }; }, []);

  const search = useCallback(async (text) => {
    const index = activeIndexRef.current;
    if (!index || builtForRef.current?.account !== account || builtForRef.current?.replica !== records.replica || !text.trim()) return [];
    return index.query(text.trim());
  }, [account, records.replica]);

  return { ready: ready && builtForRef.current?.account === account && builtForRef.current?.replica === records.replica,
    indexing, sharpening, mode, needsConnection, version, source, search };
}
