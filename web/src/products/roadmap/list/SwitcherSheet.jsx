// Renders through a portal so the scrim clears the list layer's stacking context.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hueOf, hueVars, prefersReducedMotion, useKeyboardInset } from './ListView.jsx';

const CLOSE_MS = 280; // the descent matches the sheet's rise
const SEARCH_THRESHOLD = 8; // trees past this add a search field

const SEARCH_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const CLOSE_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const BUD_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const COMPASS_GLYPH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
  </svg>
);

const ARROW_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

function updatedLabel(updatedAt) {
  if (updatedAt == null) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 7 ? `${days}d ago` : `${Math.round(days / 7)}w ago`;
}

export function SwitcherSheet({ open, trees = [], currentId, onPick, onPlant, onClose, portalTarget }) {
  const [render, setRender] = useState(open);
  const [up, setUp] = useState(false);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const reduced = prefersReducedMotion();
  const kbInset = useKeyboardInset(searchFocused);
  const closeTimer = useRef(null);

  useEffect(() => {
    if (open) {
      if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
      setRender(true);
      setQuery('');
      const raf = requestAnimationFrame(() => setUp(true));
      return () => cancelAnimationFrame(raf);
    }
    setUp(false);
    if (reduced) { setRender(false); return undefined; }
    closeTimer.current = setTimeout(() => { setRender(false); closeTimer.current = null; }, CLOSE_MS);
    return undefined;
  }, [open, reduced]);

  const searchable = trees.length > SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => (q === '' ? trees : trees.filter((tree) => (tree.title || '').toLowerCase().includes(q))),
    [trees, q],
  );

  if (!render) return null;

  const pick = (id) => { onPick(id); onClose(); };

  const sheet = (
    <div className={`st-list-scrim${up ? ' is-open' : ''}`} onClick={onClose} style={kbInset > 0 ? { paddingBottom: `${kbInset}px` } : undefined}>
      <div className={`st-list-picker st-switcher${up ? ' is-up' : ''}`} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Switch tree">
        <div className="st-list-picker-head">
          <span className="st-list-picker-title">Your trees</span>
          <button type="button" className="st-list-picker-close" onClick={onClose} aria-label="Close">{CLOSE_GLYPH}</button>
        </div>
        {searchable && (
          <div className="st-list-picker-search">
            <span className="st-list-picker-search-icon" aria-hidden>{SEARCH_GLYPH}</span>
            <input
              type="text"
              value={query}
              placeholder="Search trees"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
            />
          </div>
        )}
        <div className="st-list-picker-body">
          {rows.map((tree) => {
            const hue = hueOf(tree.dominantKind);
            const total = tree.total ?? 0;
            const done = tree.done ?? 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const updated = updatedLabel(tree.updatedAt);
            const lineage = tree.forkedFrom || null;
            return (
              <button
                key={tree.id}
                type="button"
                className={`st-switcher-row${tree.id === currentId ? ' st-switcher-row--current' : ''}`}
                style={hueVars(hue)}
                aria-current={tree.id === currentId || undefined}
                onClick={() => pick(tree.id)}
              >
                <span className="st-switcher-dot" aria-hidden />
                <span className="st-switcher-main">
                  <span className="st-switcher-name">{tree.title || 'Untitled tree'}</span>
                  <span className="st-switcher-meta">
                    <span className="st-switcher-count">{done}/{total}</span>
                    <span className="st-switcher-bar"><span className="st-switcher-fill" style={{ width: `${pct}%` }} /></span>
                    {updated && <span className="st-switcher-when">{updated}</span>}
                  </span>
                  {lineage && <span className="st-switcher-lineage">Forked from {lineage}</span>}
                </span>
              </button>
            );
          })}
          {rows.length === 0 && <div className="st-list-picker-empty">No trees match.</div>}
        </div>
        <button type="button" className="st-switcher-plant" onClick={() => { onPlant(); onClose(); }}>
          <span className="st-switcher-plant-glyph" aria-hidden>{BUD_GLYPH}</span>
          Plant a new tree
        </button>
        <button type="button" className="st-switcher-public" aria-label="Browse trees planted in public"
          onClick={() => { window.location.hash = '#/browse'; onClose(); }}>
          <span className="st-switcher-public-glyph" aria-hidden>{COMPASS_GLYPH}</span>
          <span className="st-switcher-public-label">Planted in public</span>
          <span className="st-switcher-public-arrow" aria-hidden>{ARROW_GLYPH}</span>
        </button>
      </div>
    </div>
  );

  return createPortal(sheet, portalTarget ?? document.body);
}

export default SwitcherSheet;
