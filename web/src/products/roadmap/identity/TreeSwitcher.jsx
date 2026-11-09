// Rows wear a tag — "on this device" for unclaimed local trees, "synced" for the rest — and every
// edit routes by that tag, never by presence in the server list.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../design-system';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { dismissOverlayOutside } from '../board/BoardControls.jsx';
import { ROADMAP_SHEET } from '../copy.js';
import { t } from '../i18n/index.js';

// Unclaimed device rows edit the local seams and must never see the server.
function seamOf(tree) {
  if (tree.origin === 'device') return tree.claimed ? null : 'local';
  return tree.origin === 'server' ? 'server' : null;
}

function tagOf(tree) {
  if (!tree.origin) return null;
  return tree.origin === 'device' && !tree.claimed ? t('roadmap.switcher.onDevice') : t('roadmap.switcher.synced');
}

function agoFrom(updatedAt) {
  if (!updatedAt) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return t('roadmap.ago.justNow');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('roadmap.ago.minutesShort', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('roadmap.ago.hoursShort', { count: hrs });
  const days = Math.round(hrs / 24);
  return days < 7 ? t('roadmap.ago.daysShort', { count: days }) : t('roadmap.ago.weeksShort', { count: Math.round(days / 7) });
}

export function TreeSwitcher({ current, listTrees, onNew, onRename, onPreviewTitle, onDelete }) {
  const [open, setOpen] = useState(false);
  const [trees, setTrees] = useState(null); // null = not loaded; [] = loaded, none
  const [hoverId, setHoverId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const editingRef = useRef(null); // mirrors editingId/confirmId for the document-level listeners
  const confirmRef = useRef(null);
  const commitRef = useRef(null);
  const goTimerRef = useRef(null); // an editable row's click waits a beat so a double-click can become the editor
  const swallowRef = useRef(null); // {rowId, at} — a blur-commit eats the one click that caused it
  editingRef.current = editingId;
  confirmRef.current = confirmId;

  // Load the registry each time the menu opens; degrades to the current tree alone when it can't answer.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    listTrees().then((rows) => { if (!cancelled) setTrees(rows); });
    return () => { cancelled = true; };
  }, [open, listTrees]);

  useEffect(() => {
    if (!open) return undefined;
    // Clicking away commits an in-flight rename: blur may never fire once the menu unmounts.
    const onDown = (event) => {
      const close = () => {
        if (editingRef.current != null) commitRef.current?.();
        setOpen(false);
        triggerRef.current?.focus();
      };
      dismissOverlayOutside(event, rootRef.current, close);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (editingRef.current != null) return; // the field's own esc handler restores it
      if (confirmRef.current != null) { setConfirmId(null); return; }
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    clearTimeout(goTimerRef.current);
    setEditingId(null);
    setConfirmId(null);
    setHoverId(null);
    setFlashId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onClaimed = (event) => setTrees((prev) => (Array.isArray(prev)
      ? prev.map((row) => (row.id === event.detail?.treeId ? { ...row, claimed: true } : row))
      : prev));
    window.addEventListener('wm-tree-claimed', onClaimed);
    return () => window.removeEventListener('wm-tree-claimed', onClaimed);
  }, [open]);

  useEffect(() => {
    if (editingId != null) inputRef.current?.select(); // the name arrives pre-selected
  }, [editingId]);

  // The gold flash retires on a timer: under prefers-reduced-motion the animation never runs, so
  // animationend alone would leave the class stuck forever.
  useEffect(() => {
    if (flashId == null) return undefined;
    const timer = setTimeout(() => setFlashId(null), 750);
    return () => clearTimeout(timer);
  }, [flashId]);

  useEffect(() => () => clearTimeout(goTimerRef.current), []);

  const rows = mergeCurrent(trees, current);

  const go = (id) => {
    setOpen(false);
    if (!id || id === current?.id) return;
    track('roadmap_sheet', { step: 'switch', door: 'switcher' });
    window.location.hash = `#/app/${id}`;
  };

  const startEdit = (tree) => {
    clearTimeout(goTimerRef.current); // the click that preceded the pencil/double-click must not still navigate
    setConfirmId(null);
    setDraft(tree.title ?? '');
    setEditingId(tree.id);
  };

  const commitEdit = () => {
    const id = editingRef.current;
    if (id == null) return;
    editingRef.current = null; // re-entry guard: blur and outside-close can both land here
    setEditingId(null);
    const before = rows.find((r) => r.id === id)?.title ?? '';
    const next = draft.trim();
    if (!next) {
      setFlashId(id); // an empty commit keeps the old name
      onPreviewTitle?.(id, before);
      return;
    }
    if (next === before.trim()) return void onPreviewTitle?.(id, before);
    setTrees((prev) => (Array.isArray(prev) ? prev.map((r) => (r.id === id ? { ...r, title: next } : r)) : prev));
    // Local rows route to the local seams by tag — they never PATCH the server.
    const seam = seamOf(rows.find((r) => r.id === id) ?? {});
    new Promise((resolve) => resolve(onRename?.(id, next, { local: seam === 'local' }))).then(() => {
      track('roadmap_sheet', { step: 'rename', door: 'switcher' });
    }, (error) => {
      reportUnexpectedFailure('roadmap-switcher-rename', error);
      track('roadmap_sheet', { step: 'rename', door: 'switcher', outcome: 'failed' });
      onPreviewTitle?.(id, before);
      listTrees().then((fresh) => setTrees(fresh));
    });
  };
  commitRef.current = commitEdit;

  const cancelEdit = () => {
    const id = editingRef.current;
    if (id == null) return;
    editingRef.current = null;
    setEditingId(null);
    onPreviewTitle?.(id, rows.find((r) => r.id === id)?.title ?? '');
  };

  const confirmDelete = async (tree) => {
    setConfirmId(null);
    try {
      await onDelete?.(tree.id, { local: seamOf(tree) === 'local' });
    } catch (error) {
      reportUnexpectedFailure('roadmap-switcher-delete', error);
      track('roadmap_sheet', { step: 'delete', door: 'switcher', outcome: 'failed' });
      return; // a refusal leaves the row standing
    }
    track('roadmap_sheet', { step: 'delete', door: 'switcher' });
    const remaining = (Array.isArray(trees) ? trees : []).filter((r) => r.id !== tree.id);
    setTrees(remaining);
    if (tree.id !== current?.id) return;
    setOpen(false); // land on the newest remaining, or hand bare #/app to the resolver
    window.location.hash = remaining.length ? `#/app/${remaining[0].id}` : '#/app';
  };

  const liveDraft = editingId != null && editingId === current?.id;
  const name = (liveDraft ? draft : current?.title)?.trim() || t('roadmap.untitled');

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', maxWidth: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) track('roadmap_sheet', { step: 'open', door: 'switcher' });
          setOpen((v) => !v);
        }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          marginLeft: 0, padding: '0 4px 0 0',
          border: 'none', borderRadius: 'var(--radius-full)', cursor: 'pointer',
          background: open ? 'var(--color-brand-soft)' : 'transparent',
          boxShadow: open ? '0 0 0 1.5px var(--accent-terracotta-200)' : 'none',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 24,
          color: 'var(--text-primary)', maxWidth: '100%',
          transition: 'background var(--duration-fast) var(--ease-standard)',
          height: 44, lineHeight: '32px',
        }}
      >
        <span title={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <Caret />
      </button>

      {open && (
        <div role="menu" style={menu}>
          <div style={groupLabel}>{t('roadmap.switcher.yours')}</div>
          {rows.map((tree) => {
            const isCurrent = tree.id === current?.id;
            const editable = seamOf(tree) !== null;
            const editing = editingId === tree.id;
            const confirming = confirmId === tree.id;
            const rowTitle = tree.title?.trim() || t('roadmap.untitled');
            return (
              <div key={tree.id} role="menuitem" tabIndex={0}
                className={flashId === tree.id ? 'st-switcher-flash' : undefined}
                onClick={(e) => {
                  const swallow = swallowRef.current;
                  if (swallow?.rowId === tree.id && Date.now() - swallow.at < 350) {
                    swallowRef.current = null; // this click blurred the editor into a commit — it never switches trees
                    return;
                  }
                  if (editing || confirming) return;
                  if (!editable) return void go(tree.id); // no editor behind this row — navigate instantly
                  if (e.detail > 1) return void clearTimeout(goTimerRef.current); // second click of a double-click
                  clearTimeout(goTimerRef.current);
                  goTimerRef.current = setTimeout(() => go(tree.id), 220); // a beat of patience keeps the double-click door open
                }}
                onDoubleClick={() => { if (editable && !editing && !confirming) startEdit(tree); }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if ((e.key === 'Enter' || e.key === ' ') && !editing && !confirming) { e.preventDefault(); go(tree.id); }
                }}
                onMouseEnter={() => setHoverId(tree.id)}
                onMouseLeave={() => setHoverId((h) => (h === tree.id ? null : h))}
                style={{
                  ...row,
                  cursor: editing || confirming ? 'default' : 'pointer',
                  background: isCurrent ? 'var(--color-brand-soft)'
                    : hoverId === tree.id && !confirming ? 'var(--surface-hover)' : 'transparent',
                  boxShadow: editing ? 'inset 0 0 0 1.5px var(--accent-terracotta-400)' : undefined,
                }}
              >
                <Ring done={tree.done} total={tree.total} kind={tree.dominantKind} />
                {editing ? (
                  <input ref={inputRef} value={draft} aria-label={t('roadmap.switcher.nameLabel')} maxLength={200}
                    onChange={(e) => { setDraft(e.target.value); onPreviewTitle?.(tree.id, e.target.value); }}
                    onBlur={() => { swallowRef.current = { rowId: tree.id, at: Date.now() }; commitEdit(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={editField}
                  />
                ) : confirming ? (
                  <span style={rowText}>
                    <span style={confirmCopy}>{t('roadmap.switcher.deleteConfirm', { title: rowTitle })}</span>
                    <span style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); confirmDelete(tree); }} style={confirmDeleteBtn}>{t('roadmap.switcher.delete')}</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmId(null); }} style={confirmKeepBtn}>{t('roadmap.switcher.keep')}</button>
                    </span>
                  </span>
                ) : (
                  <span style={rowText}>
                    <span style={rowName} title={tree.title?.trim() || undefined}>{rowTitle}</span>
                    <RowMeta tree={tree} />
                  </span>
                )}
                {editable && !editing && !confirming && (
                  <span style={{
                    display: 'inline-flex', gap: 2, flex: 'none',
                    opacity: hoverId === tree.id ? 1 : 0,
                    pointerEvents: hoverId === tree.id ? 'auto' : 'none',
                    transition: 'opacity var(--duration-fast) var(--ease-standard)',
                  }}>
                    <button type="button" aria-label={t('roadmap.switcher.rename', { title: rowTitle })} style={action}
                      onClick={(e) => { e.stopPropagation(); startEdit(tree); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-brand-soft)'; e.currentTarget.style.color = 'var(--accent-terracotta-600)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}>
                      <Icon name="pencil" size={12} />
                    </button>
                    <button type="button" aria-label={t('roadmap.switcher.deleteTree', { title: rowTitle })} style={action}
                      onClick={(e) => { e.stopPropagation(); setConfirmId(tree.id); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-danger-bg)'; e.currentTarget.style.color = 'var(--accent-brick-500)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}>
                      <Icon name="trash-2" size={12} />
                    </button>
                  </span>
                )}
                {isCurrent && !editing && !confirming && <Check />}
              </div>
            );
          })}

          <div style={divider} />

          <button type="button" role="menuitem" onClick={() => { setOpen(false); track('roadmap_sheet', { step: 'new', door: 'switcher' }); onNew(); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{ ...row, fontWeight: 800 }}>
            <span style={bud} />
            {t('roadmap.switcher.newTree')}
          </button>

          <button type="button" role="menuitem" aria-label={t('roadmap.switcher.browse')}
            onClick={() => { setOpen(false); track('roadmap_sheet', { step: 'browse', door: 'switcher' }); window.location.hash = '#/browse'; }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={row}>
            <span style={publicGlyph} aria-hidden><Icon name="compass" size={14} /></span>
            <span style={{ flex: 1, fontWeight: 700 }}>{ROADMAP_SHEET.plantedInPublic}</span>
            <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--text-tertiary)' }} aria-hidden><Icon name="arrow-right" size={13} /></span>
          </button>
        </div>
      )}
    </div>
  );
}

export default TreeSwitcher;

function mergeCurrent(trees, current) {
  const list = Array.isArray(trees) ? trees : [];
  if (!current) return list;
  if (list.some((tree) => tree.id === current.id)) return list;
  return [{ id: current.id, title: current.title, done: current.done, total: current.total, dominantKind: current.dominantKind }, ...list];
}

function readout(tree) {
  const ago = agoFrom(tree.updatedAt);
  const count = tree.total != null ? t('roadmap.switcher.progress', { done: tree.done ?? 0, total: tree.total }) : null;
  return [count, ago].filter(Boolean).join(' · ');
}

// The tag span is keyed by its text so a live flip remounts it into the cross-fade.
function RowMeta({ tree }) {
  const meta = readout(tree);
  const tag = tagOf(tree);
  return (
    <span style={rowMeta}>
      {meta}
      {tag && <span key={tag} className="st-switcher-tag">{meta ? ' · ' : ''}{tag}</span>}
    </span>
  );
}

function Caret() {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" fill="none" style={{ opacity: 1, flexShrink: 0, color: 'var(--text-secondary)', transition: 'opacity var(--duration-fast) var(--ease-standard)' }}>
      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" />
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

function Ring({ done = 0, total, kind }) {
  const hue = hueOf(kind).base;
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
const row = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', boxSizing: 'border-box' };
const rowText = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 };
const rowName = { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowMeta = { fontSize: '9.5px', color: 'var(--text-tertiary)' };
const editField = {
  flex: 1, minWidth: 0, padding: 0, margin: 0, border: 'none', outline: 'none',
  background: 'transparent', font: 'inherit', fontWeight: 700, color: 'var(--text-primary)',
};
const action = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 0, border: 'none', borderRadius: 'var(--radius-sm)',
  background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
  transition: 'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)',
};
const confirmCopy = { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const confirmDeleteBtn = {
  padding: '2px 8px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  background: 'var(--color-danger-bg)', color: 'var(--accent-brick-500)',
  fontFamily: 'inherit', fontSize: '10.5px', fontWeight: 800,
};
const confirmKeepBtn = {
  padding: '2px 8px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  background: 'transparent', color: 'var(--text-tertiary)',
  fontFamily: 'inherit', fontSize: '10.5px', fontWeight: 700,
};
const divider = { height: 1, background: 'var(--border-subtle)', margin: '4px 6px' };
const bud = { width: 15, height: 15, flex: 'none', borderRadius: '50%', border: '2px dashed var(--accent-terracotta-400)', background: 'var(--color-brand-soft)', boxSizing: 'border-box' };
const publicGlyph = { width: 16, height: 16, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' };
