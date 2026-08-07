// Search — semantic and on-device. A feeling finds the passage that never used the word; every hit
// states why it matched and, when chosen, flies the canvas to that spot (it never opens a detail view
// — that is the whole payoff of never paginating). It answers instantly on the lexical index and, once
// the meaning model has loaded, re-ranks the same query in place — the results sharpen while you read
// them. The query and the vectors never leave the device, and the footer says so plainly.

import React, { useEffect, useRef, useState } from 'react';
import { useSearch } from './useSearch.js';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${weekday} ${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

export function SearchOverlay({ open, onClose, onSelect, signedIn = true }) {
  const { ready, indexing, sharpening, mode, version, source, search } = useSearch(open, signedIn);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { if (!open) { setQuery(''); setResults([]); } }, [open]);

  // Run the query against whatever index is active; re-run when the neural index swaps in (version)
  // so the ranking sharpens under a query already on screen. A token drops stale async results.
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
      aria-label="Search"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="journal-search-panel">
        <input
          ref={inputRef}
          className="journal-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
          placeholder="Search a feeling"
          aria-label="Search a feeling"
        />
        <div className="journal-search-results">
          {query.trim() && ready && results.length === 0 && (
            <p className="journal-search-empty">Nothing close to that yet.</p>
          )}
          {results.map((hit) => (
            <button key={hit.day} type="button" className="journal-search-hit" onClick={() => onSelect(hit)}>
              <span className="journal-search-quote">“{hit.text}”</span>
              <span className="journal-search-line">
                <span className="journal-search-why">{hit.why}</span>
                <span className="journal-search-date">{dateLabel(hit.day)}</span>
              </span>
            </button>
          ))}
        </div>
        {/* A journal that could not be read is not a journal with nothing in it — said above the
            foot rather than instead of it, because "nothing leaves the device" is true either way
            and is not the line to drop when the network is down. */}
        {source === 'failed' && (
          <p className="journal-search-unread">
            Couldn’t reach your journal — this searches only what’s on this device.
          </p>
        )}
        <p className={'journal-search-foot' + (sharpening ? ' is-sharpening' : '')}>
          {footNote(indexing, sharpening, mode)}
        </p>
      </div>
    </div>
  );
}

function footNote(indexing, sharpening, mode) {
  if (indexing) return 'reading your pages · one time';
  if (sharpening) return 'sharpening · matching by meaning now';
  if (mode === 'neural') return 'Matched by meaning, on your device. Nothing is sent anywhere to search.';
  return 'Matched on your device. Nothing is sent anywhere to search.';
}
