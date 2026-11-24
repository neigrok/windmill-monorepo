// Indexes the active replica's pages locally, starting lexical and re-ranking when the neural model loads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { corpus, SCOPE } from '../pages.js';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { syncSession } from '../../../platform/sync/session.js';
import { captureError } from '../../../telemetry/sentry.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { SearchIndex } from './searchIndex.js';
import { LexicalEmbedder } from './lexicalEmbedder.js';
import { NeuralEmbedder } from './neural/neuralEmbedder.js';

const MEANING_USED_KEY = 'windmill:journal-search-meaning';

// Whether search by meaning has come up in this browser before, which is all "the first time" can mean.
const firstUseHere = {
  happened() { try { return globalThis.localStorage?.getItem(MEANING_USED_KEY) === 'used'; } catch { return false; } },
  record() { try { globalThis.localStorage?.setItem(MEANING_USED_KEY, 'used'); } catch { /* offline, it is a first time again */ } },
};

// The engine's word on the connection, an unreachable server included, and the browser's where no engine is open.
const engineConnection = () => syncSession.engine?.getSnapshot()?.connection
  ?? (globalThis.navigator?.onLine === false ? 'offline' : 'online');

// Search by meaning for one opening of search: its model comes up once, in one worker, however often the pages change,
// and how that went is told once. Offline, a browser where it never came up needs a connection the first time; one where
// it came up before and is kept no longer (the browser refused or dropped the weights) answers in words alone.
export class MeaningModel {
  constructor({ embedder = () => new NeuralEmbedder(), connection = engineConnection, firstUse = firstUseHere,
    serviceWorker = globalThis.navigator?.serviceWorker ?? null, track = trackEvent, report = captureError } = {}) {
    Object.assign(this, { connection, firstUse, serviceWorker, track, report, embedder: null, disposed: false, refusalTold: false });
    // The service worker says when the browser would not keep the weights it just served (public/sw.js).
    this.heard = (event) => {
      if (event.data?.type !== 'model-not-kept' || this.refusalTold || this.disposed) return;
      this.refusalTold = true;
      this.track('journal_search_meaning', { outcome: 'cache_refused' });
    };
    serviceWorker?.addEventListener('message', this.heard);
    this.ready = this.bringUp(embedder);
  }

  // Settles to how the model came up: `ready`, `needs_connection`, `unkept`, `failed`, or `closed` when search closed first.
  async bringUp(embedder) {
    try {
      this.embedder = embedder();
      await this.embedder.ready;
    } catch (error) {
      if (this.disposed) return 'closed';
      const outcome = this.connection() === 'online' ? 'failed' : this.firstUse.happened() ? 'unkept' : 'needs_connection';
      this.track('journal_search_meaning', { outcome });
      if (outcome === 'failed') this.report('journal', 'journal-search-meaning', error?.stack ?? '', '/journal', { step: error?.step ?? 'worker' });
      return outcome;
    }
    if (this.disposed) return 'closed';
    this.firstUse.record();
    this.track('journal_search_meaning', { outcome: 'ready' });
    return 'ready';
  }

  // The pages indexed by meaning, or null when the model is not up or its worker fails them.
  async index(pages) {
    if (await this.ready !== 'ready') return null;
    const index = new SearchIndex(this.embedder);
    try {
      await index.ingest(pages);
      return index;
    } catch (error) {
      if (!this.disposed) this.report('journal', 'journal-search-meaning', error?.stack ?? '', '/journal', { step: 'index' });
      return null;
    }
  }

  dispose() {
    this.disposed = true;
    this.serviceWorker?.removeEventListener('message', this.heard);
    this.embedder?.dispose();
  }
}

export function useSearch(active, account = null, openMeaning = () => new MeaningModel()) {
  const records = useSyncRecords(SCOPE);
  const build = useRef(0);
  const activeIndexRef = useRef(null);
  const meaningRef = useRef(null);
  const builtForRef = useRef(undefined);   // the account the live index was built for
  const [ready, setReady] = useState(false);      // lexical index built — search is usable
  const [indexing, setIndexing] = useState(false); // the one-time lexical build
  const [sharpening, setSharpening] = useState(false); // neural index building in the background
  const [mode, setMode] = useState('lexical');    // which embedder the active index uses
  const [needsConnection, setNeedsConnection] = useState(false); // the model could not come up without one
  const [version, setVersion] = useState(0);       // bumps when the active index changes, to re-rank
  const [source, setSource] = useState('account'); // where the indexed pages came from

  // One opening of search, one meaning model: declared before the index so it is open when the first index is built.
  useEffect(() => {
    if (!active) return undefined;
    const meaning = openMeaning();
    meaningRef.current = meaning;
    return () => {
      build.current++;
      meaning.dispose();
      if (meaningRef.current === meaning) meaningRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    // Whatever is in hand was built for somebody else: it stops answering the moment the account changes.
    activeIndexRef.current = null;
    setReady(false);
    setSharpening(false);
    setMode('lexical');
    setNeedsConnection(false);
    builtForRef.current = { account, replica: records.replica };
    const generation = ++build.current;
    const stale = () => build.current !== generation;
    const meaning = meaningRef.current;
    (async () => {
      setIndexing(true);
      const read = corpus({ account });
      setSource(read.source);

      const lexical = new SearchIndex(new LexicalEmbedder());
      await lexical.ingest(read.pages);
      if (stale()) return;
      activeIndexRef.current = lexical;
      setReady(true);
      setIndexing(false);
      setVersion((v) => v + 1);

      const outcome = await meaning.ready;
      if (stale()) return;
      if (outcome !== 'ready') { setNeedsConnection(outcome === 'needs_connection'); return; }
      setSharpening(true);
      const index = await meaning.index(read.pages);
      if (stale()) return;
      setSharpening(false);
      if (!index) return;
      activeIndexRef.current = index;
      setMode('neural');
      setVersion((v) => v + 1);
    })();
  }, [active, account, records]);

  const search = useCallback(async (text) => {
    const index = activeIndexRef.current;
    if (!index || builtForRef.current?.account !== account || builtForRef.current?.replica !== records.replica || !text.trim()) return [];
    return index.query(text.trim());
  }, [account, records.replica]);

  return { ready: ready && builtForRef.current?.account === account && builtForRef.current?.replica === records.replica,
    indexing, sharpening, mode, needsConnection, version, source, search };
}
