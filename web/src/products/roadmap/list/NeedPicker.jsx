// Renders through a portal so the scrim and sheet clear the list layer's stacking context.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { treatmentOf } from './outline.js';
import { pickerCandidates } from './editing.js';
import { hueOf, hueVars, prefersReducedMotion, useKeyboardInset } from './ListView.jsx';

const CLOSE_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const SEARCH_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const CLOSE_MS = 280; // the teardown waits for the sheet's rise/descent

export function NeedPicker({ tree, states, targetId, portalTarget, onPick, onClose }) {
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const reduced = prefersReducedMotion();
  const kbInset = useKeyboardInset(searchFocused);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const candidates = useMemo(() => pickerCandidates(tree, targetId), [tree, targetId]);
  const target = tree.nodesById.get(targetId);

  // The target was deleted remotely mid-open: ask the host to close and render nothing.
  useEffect(() => { if (!candidates) onClose(); }, [candidates, onClose]);
  if (!candidates) return null;

  const requestClose = () => {
    if (reduced) { onClose(); return; }
    setShown(false);
    setTimeout(onClose, CLOSE_MS);
  };

  const pick = (id) => {
    onPick(id);
    requestClose();
  };

  const q = query.trim().toLowerCase();
  const matches = (node) => q === '' || (node.label || '').toLowerCase().includes(q);
  const legalRows = candidates.legal.filter(matches);
  const loopingRows = candidates.looping.filter(matches);

  const sheet = (
    <div className={`st-list-scrim${shown ? ' is-open' : ''}`} onClick={requestClose} style={kbInset > 0 ? { paddingBottom: `${kbInset}px` } : undefined}>
      <div className={`st-list-picker${shown ? ' is-up' : ''}`} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="st-list-picker-head">
          <span className="st-list-picker-title">Add a need to “{target?.label || 'this step'}”</span>
          <button type="button" className="st-list-picker-close" onClick={requestClose} aria-label="Close">{CLOSE_GLYPH}</button>
        </div>
        <div className="st-list-picker-search">
          <span className="st-list-picker-search-icon" aria-hidden>{SEARCH_GLYPH}</span>
          <input
            type="text"
            value={query}
            placeholder="Search steps"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
        </div>
        <div className="st-list-picker-body">
          {legalRows.map((node) => (
            <button key={node.id} type="button" className="st-list-picker-row" onClick={() => pick(node.id)}>
              <span className={`st-list-dot st-list-dot--${treatmentOf(states.get(node.id) ?? 'locked')}`} style={hueVars(hueOf(node.color))} aria-hidden />
              <span className="st-list-picker-name">{node.label || 'Untitled step'}</span>
            </button>
          ))}
          {loopingRows.map((node) => (
            <div key={node.id} className="st-list-picker-row st-list-picker-row--loop" aria-disabled="true">
              <span className={`st-list-dot st-list-dot--${treatmentOf(states.get(node.id) ?? 'locked')}`} style={hueVars(hueOf(node.color))} aria-hidden />
              <span className="st-list-picker-name">{node.label || 'Untitled step'}</span>
              <span className="st-list-picker-tag">would loop</span>
            </div>
          ))}
          {legalRows.length === 0 && loopingRows.length === 0 && (
            <div className="st-list-picker-empty">No steps match.</div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(sheet, portalTarget ?? document.body);
}

export default NeedPicker;
