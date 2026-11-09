// Every hit states why it matched and, when chosen, flies the canvas to that spot. It answers on the
// lexical index and re-ranks in place once the meaning model has loaded. Nothing leaves the device.

import React, { useEffect, useRef, useState } from 'react';
import { useSearch } from './useSearch.js';
import { stampWeekday } from '../echoes/echoDates.js';
import { t } from '../i18n/index.js';

export function SearchOverlay({ open, onClose, onSelect, account = null }) {
  const { ready, indexing, sharpening, mode, version, source, search } = useSearch(open, account);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { if (!open) { setQuery(''); setResults([]); } }, [open]);

  // Re-runs when the neural index swaps in (`version`); `live` drops stale async results.
  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); return undefined; }
    let live = true;
    search(query).then((hits) => { if (live) setResults(hits); });
    return () => { live = false; };
  }, [open, query, version, search]);

  if (!open) return null;

  return (
    <div
      className="journal-search"
      role="dialog"
      aria-label={t('journal.search.title')}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="journal-search-panel">
        <input
          ref={inputRef}
          className="journal-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
          placeholder={t('journal.search.placeholder')}
          aria-label={t('journal.search.placeholder')}
        />
        <div className="journal-search-results">
          {query.trim() && ready && results.length === 0 && (
            <p className="journal-search-empty">{t('journal.search.empty')}</p>
          )}
          {results.map((hit) => (
            <button key={hit.day} type="button" className="journal-search-hit" onClick={() => onSelect(hit)}>
              <span className="journal-search-quote">{t('journal.search.quote', { text: hit.text })}</span>
              <span className="journal-search-line">
                <span className="journal-search-why">{hit.why}</span>
                <span className="journal-search-date">{stampWeekday(hit.day)}</span>
              </span>
            </button>
          ))}
        </div>
        {/* Said above the foot rather than instead of it: "nothing leaves the device" is true either way. */}
        {source === 'failed' && (
          <p className="journal-search-unread">{t('journal.search.unread')}</p>
        )}
        <p className={'journal-search-foot' + (sharpening ? ' is-sharpening' : '')}>
          {footNote(indexing, sharpening, mode)}
        </p>
      </div>
    </div>
  );
}

function footNote(indexing, sharpening, mode) {
  if (indexing) return t('journal.search.indexing');
  if (sharpening) return t('journal.search.sharpening');
  if (mode === 'neural') return t('journal.search.neural');
  return t('journal.search.lexical');
}
