// The TreeSwitcher (F1·F2 §4) — the tree identity plaque and the one home for "which
// tree am I in". At rest it's just the tree's name; hover reveals the caret; clicking
// drops a menu of YOUR roadmaps (current one checked) plus the "New tree" bud row that
// lands on the birth canvas. Switching is navigation — it points the hash at #/app/:id
// and the app reloads that tree. Your rows also carry the hover-revealed pencil + trash
// (rename-tree spec §01): the row itself becomes the editor — pencil or double-click to
// open it (your rows defer their click a beat so the double-click door stays open),
// ↵/blur commits, esc restores, a whitespace-only commit restores the old name
// under a gold flash (a tree always has a name) — and delete confirms inline in the row,
// never a dialog. Mutations are injected (onRename/onDelete) like listTrees is.
//
// Rows now come from the union list (anon-first-tree F3) and wear a tag — "on this
// device" for unclaimed local trees, "synced" for the rest — that flips in a 150ms
// cross-fade as a claim lands (wm-tree-claimed). Edits route by that tag, never by
// presence in the server list: a local row's pencil/trash reach only the local seams.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components';

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

// Which seam a row's pencil/trash reach (anon-first-tree F3): server rows edit through
// the registry (PATCH/DELETE); unclaimed device rows edit the local seams and must never
// see the server; a device row already claimed but not currently vouched for (signed
// out) offers neither. The merged-in current row (offline, someone else's tree) has no
// origin and gets no editor either — exactly the old rule, by tag instead of by list.
function seamOf(tree) {
  if (tree.origin === 'device') return tree.claimed ? null : 'local';
  return tree.origin === 'server' ? 'server' : null;
}

function tagOf(tree) {
  if (!tree.origin) return null;
  return tree.origin === 'device' && !tree.claimed ? 'on this device' : 'synced';
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

export function TreeSwitcher({ current, listTrees, onNew, onRename, onPreviewTitle, onDelete }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [trees, setTrees] = useState(null); // null = not loaded; [] = loaded, none
  const [hoverId, setHoverId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const editingRef = useRef(null); // mirrors editingId/confirmId for the document-level listeners
  const confirmRef = useRef(null);
  const commitRef = useRef(null);
  const goTimerRef = useRef(null); // an editable row's click waits a beat so a double-click can become the editor
  const swallowRef = useRef(null); // {rowId, at} — a blur-commit eats the one click that caused it
  editingRef.current = editingId;
  confirmRef.current = confirmId;

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
    // Clicking away commits an in-flight rename (blur may never fire once the menu
    // unmounts); esc peels one layer — the field restores itself, a confirm folds back,
    // and only then does the menu close.
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (editingRef.current != null) commitRef.current?.();
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (editingRef.current != null) return; // the field's own esc handler restores it
      if (confirmRef.current != null) { setConfirmId(null); return; }
      setOpen(false);
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

  // A claim landing while the menu is open flips that row's tag in place —
  // "on this device" → "synced", one 150ms cross-fade (anon-first-tree §02).
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

  // The gold flash retires on a timer: under prefers-reduced-motion the animation never
  // runs, so animationend alone would leave the class stuck forever.
  useEffect(() => {
    if (flashId == null) return undefined;
    const timer = setTimeout(() => setFlashId(null), 750);
    return () => clearTimeout(timer);
  }, [flashId]);

  useEffect(() => () => clearTimeout(goTimerRef.current), []);

  // The current tree always shows, even before the list resolves or if it never does.
  const rows = mergeCurrent(trees, current);

  const go = (id) => {
    setOpen(false);
    if (id && id !== current?.id) window.location.hash = `#/app/${id}`;
  };

  const startEdit = (t) => {
    clearTimeout(goTimerRef.current); // the click that preceded the pencil/double-click must not still navigate
    setConfirmId(null);
    setDraft(t.title ?? '');
    setEditingId(t.id);
  };

  const commitEdit = () => {
    const id = editingRef.current;
    if (id == null) return;
    editingRef.current = null; // re-entry guard: blur and outside-close can both land here
    setEditingId(null);
    const before = rows.find((r) => r.id === id)?.title ?? '';
    const next = draft.trim();
    if (!next) {
      setFlashId(id); // empty commits keep the old name — the gold flash says so, wordlessly
      onPreviewTitle?.(id, before);
      return;
    }
    if (next === before.trim()) return void onPreviewTitle?.(id, before);
    setTrees((prev) => (Array.isArray(prev) ? prev.map((r) => (r.id === id ? { ...r, title: next } : r)) : prev));
    // Optimism with a receipt: if the rename is refused (offline, signed out, not yours),
    // the plaque falls back to truth and the rows re-read the registry. Local rows route
    // to the local seams by tag — they never PATCH the server.
    const seam = seamOf(rows.find((r) => r.id === id) ?? {});
    Promise.resolve(onRename?.(id, next, { local: seam === 'local' })).catch(() => {
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

  const confirmDelete = async (t) => {
    setConfirmId(null);
    try { await onDelete?.(t.id, { local: seamOf(t) === 'local' }); } catch { return; } // a refusal leaves the row standing
    const remaining = (Array.isArray(trees) ? trees : []).filter((r) => r.id !== t.id);
    setTrees(remaining);
    if (t.id !== current?.id) return;
    setOpen(false); // the current tree left — land on the newest remaining, or hand bare #/app to the resolver
    window.location.hash = remaining.length ? `#/app/${remaining[0].id}` : '#/app';
  };

  // While the current tree's row is the editor, the plaque follows every keystroke —
  // the field IS the title.
  const liveDraft = editingId != null && editingId === current?.id;
  const name = (liveDraft ? draft : current?.title)?.trim() || 'Untitled roadmap';

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
        <span title={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <Caret shown={hover || open} />
      </button>

      {open && (
        <div role="menu" style={menu}>
          <div style={groupLabel}>YOURS</div>
          {rows.map((t) => {
            const isCurrent = t.id === current?.id;
            const editable = seamOf(t) !== null;
            const editing = editingId === t.id;
            const confirming = confirmId === t.id;
            const rowTitle = t.title?.trim() || 'Untitled roadmap';
            return (
              <div key={t.id} role="menuitem" tabIndex={0}
                className={flashId === t.id ? 'st-switcher-flash' : undefined}
                onClick={(e) => {
                  const swallow = swallowRef.current;
                  if (swallow?.rowId === t.id && Date.now() - swallow.at < 350) {
                    swallowRef.current = null; // this click blurred the editor into a commit — it never switches trees
                    return;
                  }
                  if (editing || confirming) return;
                  if (!editable) return void go(t.id); // no editor behind this row — navigate instantly
                  if (e.detail > 1) return void clearTimeout(goTimerRef.current); // second click of a double-click
                  clearTimeout(goTimerRef.current);
                  goTimerRef.current = setTimeout(() => go(t.id), 220); // a beat of patience keeps the double-click door open
                }}
                onDoubleClick={() => { if (editable && !editing && !confirming) startEdit(t); }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if ((e.key === 'Enter' || e.key === ' ') && !editing && !confirming) { e.preventDefault(); go(t.id); }
                }}
                onMouseEnter={() => setHoverId(t.id)}
                onMouseLeave={() => setHoverId((h) => (h === t.id ? null : h))}
                style={{
                  ...row,
                  cursor: editing || confirming ? 'default' : 'pointer',
                  background: isCurrent ? 'var(--color-brand-soft)'
                    : hoverId === t.id && !confirming ? 'var(--surface-hover)' : 'transparent',
                  boxShadow: editing ? 'inset 0 0 0 1.5px var(--accent-terracotta-400)' : undefined,
                }}
              >
                <Ring done={t.done} total={t.total} kind={t.dominantKind} />
                {editing ? (
                  <input ref={inputRef} value={draft} aria-label="Tree name" maxLength={200}
                    onChange={(e) => { setDraft(e.target.value); onPreviewTitle?.(t.id, e.target.value); }}
                    onBlur={() => { swallowRef.current = { rowId: t.id, at: Date.now() }; commitEdit(); }}
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
                    <span style={confirmCopy}>Delete {rowTitle}? This can’t be undone</span>
                    <span style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); confirmDelete(t); }} style={confirmDeleteBtn}>Delete</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmId(null); }} style={confirmKeepBtn}>Keep</button>
                    </span>
                  </span>
                ) : (
                  <span style={rowText}>
                    <span style={rowName} title={t.title?.trim() || undefined}>{rowTitle}</span>
                    <RowMeta tree={t} />
                  </span>
                )}
                {editable && !editing && !confirming && (
                  <span style={{
                    display: 'inline-flex', gap: 2, flex: 'none',
                    opacity: hoverId === t.id ? 1 : 0,
                    pointerEvents: hoverId === t.id ? 'auto' : 'none',
                    transition: 'opacity var(--duration-fast) var(--ease-standard)',
                  }}>
                    <button type="button" aria-label={`Rename ${rowTitle}`} style={action}
                      onClick={(e) => { e.stopPropagation(); startEdit(t); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-brand-soft)'; e.currentTarget.style.color = 'var(--accent-terracotta-600)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}>
                      <Icon name="pencil" size={12} />
                    </button>
                    <button type="button" aria-label={`Delete ${rowTitle}`} style={action}
                      onClick={(e) => { e.stopPropagation(); setConfirmId(t.id); }}
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

// The row's second line: progress + recency, then the registry tag. The tag span is
// keyed by its text so a live flip remounts it into the 150ms cross-fade.
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
