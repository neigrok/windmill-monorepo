// Search — semantic and on-device. A feeling finds the passage that never used the word; every hit
// states why it matched and, when chosen, flies the canvas to that spot (it never opens a detail
// view — that is the whole payoff of never paginating). The query and the vectors never leave the
// device, and the footer says so plainly.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from './useSearch.js';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${weekday} ${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

export function SearchOverlay({ open, onClose, onSelect }) {
  const { ready, indexing, count, search } = useSearch(open);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  // `count` moves 0 → N when the one-time index build finishes; without it a query typed mid-build
  // would keep showing its empty result even after the corpus is ready.
  const results = useMemo(
    () => (open && query.trim() ? search(query) : []),
    [open, query, search, count],
  );

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
        <p className="journal-search-foot">
          {indexing
            ? 'reading your pages · one time'
            : 'Matched by meaning, on your device. Nothing is sent anywhere to search.'}
        </p>
      </div>
    </div>
  );
}
