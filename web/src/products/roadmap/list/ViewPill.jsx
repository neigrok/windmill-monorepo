import React from 'react';

const LIST_GLYPH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M8.5 6h12.5M8.5 12h12.5M8.5 18h12.5" />
    <circle cx="3.6" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="3.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="3.6" cy="18" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

const TREE_GLYPH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <circle cx="12" cy="4.8" r="2.5" />
    <circle cx="5.4" cy="19.2" r="2.5" />
    <circle cx="18.6" cy="19.2" r="2.5" />
    <path d="M12 7.3v3c0 3.3-6.6 3.1-6.6 6.5" />
    <path d="M12 10.3c0 3.3 6.6 3.1 6.6 6.5" />
  </svg>
);

const SEGMENTS = [
  { view: 'list', label: 'List view', glyph: LIST_GLYPH },
  { view: 'tree', label: 'Tree view', glyph: TREE_GLYPH },
];

export function ViewPill({ view, onSwitch }) {
  return (
    <div className="st-list-viewpill" role="group" aria-label="Switch view">
      {SEGMENTS.map((segment) => (
        <button
          key={segment.view}
          type="button"
          className="st-list-viewpill-seg"
          data-active={view === segment.view}
          aria-label={segment.label}
          aria-pressed={view === segment.view}
          onClick={() => { if (view !== segment.view) onSwitch(segment.view); }}
        >
          <span className="st-list-viewpill-fill">{segment.glyph}</span>
        </button>
      ))}
    </div>
  );
}

export default ViewPill;
