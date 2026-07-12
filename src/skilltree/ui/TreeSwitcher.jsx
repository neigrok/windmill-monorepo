// The TreeSwitcher (F1·F2 §4) — the tree identity plaque and the one home for "which
// tree am I in". At rest it's just the tree's name; hover reveals the caret; clicking
// drops a menu of YOUR roadmaps (current one checked) plus the "New tree" bud row that
// lands on the birth canvas. Switching is navigation — it points the hash at #/app/:id
// and the app reloads that tree. Purely presentational + one fetch: it reads the
// registry (listTrees) and never mutates a tree itself.

import React, { useEffect, useRef, useState } from 'react';

const KIND_HUE = {
  terracotta: 'var(--accent-terracotta-500)',
  olive: 'var(--accent-olive-500)',
  gold: 'var(--accent-gold-500)',
  sky: 'var(--accent-sky-500)',
  brick: 'var(--color-danger)',
  plum: '#8D4F83',
};

function hueOf(kind) {
  return KIND_HUE[kind] ?? KIND_HUE.terracotta;
}

function agoFrom(updatedAt) {
  if (!updatedAt) return null;
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

export function TreeSwitcher({ current, listTrees, onNew }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [trees, setTrees] = useState(null); // null = not loaded; [] = loaded, none
  const rootRef = useRef(null);

  // Load the registry each time the menu opens — cheap, and it keeps "2h ago" honest
  // without a poll. Degrades to the current tree alone when the registry can't answer.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    listTrees().then((rows) => { if (!cancelled) setTrees(rows); });
    return () => { cancelled = true; };
  }, [open, listTrees]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = current?.title?.trim() || 'Untitled roadmap';
  // The current tree always shows, even before the list resolves or if it never does.
  const rows = mergeCurrent(trees, current);

  const go = (id) => {
    setOpen(false);
    if (id && id !== current?.id) window.location.hash = `#/app/${id}`;
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          marginLeft: 'var(--space-2)', padding: '3px 8px',
          border: 'none', borderRadius: 'var(--radius-full)', cursor: 'pointer',
          background: open ? 'var(--color-brand-soft)' : 'transparent',
          boxShadow: open ? '0 0 0 1.5px var(--accent-terracotta-200)' : 'none',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-sm)',
          color: 'var(--text-primary)', maxWidth: 220,
          transition: 'background var(--duration-fast) var(--ease-standard)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <Caret shown={hover || open} />
      </button>

      {open && (
        <div role="menu" style={menu}>
          <div style={groupLabel}>YOURS</div>
          {rows.map((t) => (
            <button key={t.id} type="button" role="menuitem" onClick={() => go(t.id)}
              onMouseEnter={(e) => { if (t.id !== current?.id) e.currentTarget.style.background = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { if (t.id !== current?.id) e.currentTarget.style.background = 'transparent'; }}
              style={{ ...row, background: t.id === current?.id ? 'var(--color-brand-soft)' : 'transparent' }}>
              <Ring done={t.done} total={t.total} kind={t.dominantKind} />
              <span style={rowText}>
                <span style={rowName}>{t.title?.trim() || 'Untitled roadmap'}</span>
                <span style={rowMeta}>{readout(t)}</span>
              </span>
              {t.id === current?.id && <Check />}
            </button>
          ))}

          <div style={divider} />

          <button type="button" role="menuitem" onClick={() => { setOpen(false); onNew(); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{ ...row, fontWeight: 800 }}>
            <span style={bud} />
            New tree
          </button>
        </div>
      )}
    </div>
  );
}

export default TreeSwitcher;

// The current tree, deduped into the fetched list (or standing alone if the list is
// empty/unavailable) so it always appears and never doubles.
function mergeCurrent(trees, current) {
  const list = Array.isArray(trees) ? trees : [];
  if (!current) return list;
  if (list.some((t) => t.id === current.id)) return list;
  return [{ id: current.id, title: current.title, done: current.done, total: current.total, dominantKind: current.dominantKind }, ...list];
}

function readout(t) {
  const ago = agoFrom(t.updatedAt);
  const count = t.total != null ? `${t.done ?? 0} of ${t.total}` : null;
  return [count, ago].filter(Boolean).join(' · ');
}

function Caret({ shown }) {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ opacity: shown ? 0.7 : 0, transition: 'opacity var(--duration-fast) var(--ease-standard)' }}>
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flex: 'none', color: 'var(--accent-terracotta-600)' }}>
      <path d="M2 6.5L4.8 9L10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A tiny progress ring in the tree's dominant kind — the row's glance-able state.
function Ring({ done = 0, total, kind }) {
  const hue = hueOf(kind);
  if (!total) return <span style={{ ...bud, borderColor: hue, background: 'transparent' }} />;
  const frac = Math.max(0, Math.min(1, done / total));
  const c = 2 * Math.PI * 6;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flex: 'none' }}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border-default)" strokeWidth="2" />
      <circle cx="8" cy="8" r="6" fill="none" stroke={hue} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${frac * c} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

const menu = {
  position: 'absolute', top: 'calc(100% + 8px)', left: 0, minWidth: 244, maxWidth: 300,
  padding: 6, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', zIndex: 40,
  fontFamily: 'var(--font-body)', animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
};
const groupLabel = { padding: '4px 10px 6px', fontSize: '9px', fontWeight: 800, letterSpacing: '.07em', color: 'var(--text-tertiary)' };
const row = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' };
const rowText = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 };
const rowName = { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowMeta = { fontSize: '9.5px', color: 'var(--text-tertiary)' };
const divider = { height: 1, background: 'var(--border-subtle)', margin: '4px 6px' };
const bud = { width: 15, height: 15, flex: 'none', borderRadius: '50%', border: '2px dashed var(--accent-terracotta-400)', background: 'var(--color-brand-soft)', boxSizing: 'border-box' };
