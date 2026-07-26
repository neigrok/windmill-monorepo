// The on-canvas color key that is also its own editor (F6). A kind names one of six
// hues; a node's color IS its hue. The parent docks this card bottom-left in screen
// space and supplies each kind's `count` — we never read nodes or compute counts, we
// only render what we're given. Collapsed we're a pill of the in-use dots; expanded
// we're a row per kind. At rest a row is just swatch + name; on card-hover the
// "working face" surfaces — counts, remove ×, "+ Add a kind", the collapse chip.
// Single-click a row highlights that kind; double-click the label opens the plaque
// (label + "what belongs here?" description). The swatch opens a six-hue popover with
// the taken hues disabled. Read-only (no edit handlers) drops all of that chrome.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../design-system/Icon.jsx';
import { NODE_COLORS, NODE_COLOR_NAMES } from '../../theme.js';

const capHue = (hue) => hue.charAt(0).toUpperCase() + hue.slice(1);

export function KindLegend({
  kinds = [],
  defaultOpen = true,
  onOpenChange,
  selectedId = null,
  onHighlight,
  onRename,
  onRecolor,
  onAdd,
  onRemove,
  onDescribe,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hover, setHover] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [swatchId, setSwatchId] = useState(null);
  const clickTimer = useRef(null);
  const labelRef = useRef(null);
  const descRef = useRef(null);
  const editRowRef = useRef(null);
  const swatchRef = useRef(null);

  const editable = Boolean(onRename || onRecolor || onAdd || onRemove || onDescribe);
  const canEditRow = Boolean(onRename || onDescribe);
  const inUse = kinds.filter((k) => k.count > 0);
  const takenHues = new Set(kinds.map((k) => k.hue));
  const freeHue = NODE_COLOR_NAMES.find((h) => !takenHues.has(h)) || null;
  // Editing shows every kind (so empties can be recoloured or removed); a read-only
  // legend only voices the hues actually on the canvas.
  const rows = editable ? kinds : inUse;

  useEffect(() => {
    if (editingId === null) return;
    const input = labelRef.current || descRef.current;
    input?.focus();
    input?.select();
  }, [editingId]);

  // Click-away closes whichever floating layer is open: an editing plaque commits, a
  // swatch popover just dismisses.
  useEffect(() => {
    if (editingId === null && swatchId === null) return;
    const onDown = (event) => {
      if (editingId !== null && !editRowRef.current?.contains(event.target)) finishEdit();
      if (swatchId !== null && !swatchRef.current?.contains(event.target)) setSwatchId(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [editingId, swatchId, labelDraft, descDraft]);

  const toggleOpen = (next) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // Single/double grammar borrowed from the checklist: a lone click schedules the
  // highlight; a double-click on the label cancels it and opens the plaque instead.
  const scheduleHighlight = (id) => {
    if (clickTimer.current) return;
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onHighlight?.(selectedId === id ? null : id);
    }, 200);
  };

  const beginEdit = (k) => {
    if (!canEditRow) return;
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setSwatchId(null);
    setEditingId(k.id);
    setLabelDraft(k.label);
    setDescDraft(k.description || '');
  };

  const commitLabel = () => {
    const k = kinds.find((c) => c.id === editingId);
    if (!k || !onRename) return;
    const label = labelDraft.trim();
    if (label !== k.label) onRename(k.id, label); // empty commit → unlabeled
  };
  const commitDesc = () => {
    const k = kinds.find((c) => c.id === editingId);
    if (!k || !onDescribe) return;
    const description = descDraft.trim();
    if (description !== (k.description || '')) onDescribe(k.id, description);
  };
  const finishEdit = () => {
    commitLabel();
    commitDesc();
    setEditingId(null);
  };

  const pickHue = (k, hue) => {
    const disabled = kinds.some((other) => other.id !== k.id && other.hue === hue);
    if (disabled) return;
    if (hue !== k.hue) onRecolor?.(k.id, hue);
    setSwatchId(null);
  };

  if (!editable && inUse.length < 2) return null;

  const card = {
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--text-sm)',
    background: 'var(--surface-card)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-md)',
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggleOpen(true)}
        aria-label="Show colour legend"
        style={{
          ...card,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderRadius: 'var(--radius-full)',
          cursor: 'pointer',
          animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
        }}
      >
        {inUse.map((k) => (
          <span
            key={k.id}
            title={k.label || capHue(k.hue)}
            style={{ width: 12, height: 12, borderRadius: 'var(--radius-full)', background: NODE_COLORS[k.hue].base }}
          />
        ))}
      </button>
    );
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...card, position: 'relative', minWidth: 176, padding: '10px 8px', animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)' }}
    >
      {(hover || editingId !== null) && (
        <button
          type="button"
          onClick={() => toggleOpen(false)}
          aria-label="Collapse legend"
          title="Collapse"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'inline-flex',
            padding: 3,
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          <Icon name="minus" size={14} />
        </button>
      )}

      {rows.map((k) => {
        const editing = editingId === k.id;
        const selected = selectedId === k.id;
        const empty = !k.label || k.label.trim() === '';
        return (
          <div
            key={k.id}
            ref={editing ? editRowRef : undefined}
            title={!editing ? (k.description || undefined) : undefined}
            onClick={editing ? undefined : () => scheduleHighlight(k.id)}
            onMouseEnter={(e) => { if (!selected && !editing) e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = selected ? 'var(--color-brand-soft)' : 'transparent'; }}
            style={{
              display: 'flex',
              alignItems: editing ? 'flex-start' : 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              background: selected ? 'var(--color-brand-soft)' : 'transparent',
              cursor: editing ? 'default' : 'pointer',
            }}
          >
            {/* swatch — opens the six-hue popover when recolouring is on offer */}
            <div ref={swatchId === k.id ? swatchRef : undefined} style={{ position: 'relative', flexShrink: 0, marginTop: editing ? 3 : 0 }}>
              <button
                type="button"
                aria-label={onRecolor ? `Recolour ${k.label || capHue(k.hue)}` : undefined}
                onClick={(e) => { e.stopPropagation(); if (onRecolor) setSwatchId((id) => (id === k.id ? null : k.id)); }}
                style={{
                  width: 14,
                  height: 14,
                  padding: 0,
                  border: 'none',
                  borderRadius: 'var(--radius-full)',
                  background: NODE_COLORS[k.hue].base,
                  boxShadow: `inset 0 0 0 1.5px ${NODE_COLORS[k.hue].ring}`,
                  cursor: onRecolor ? 'pointer' : 'default',
                }}
              />
              {swatchId === k.id && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 6,
                    display: 'flex',
                    gap: 6,
                    padding: 8,
                    background: 'var(--surface-card)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 20,
                    animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
                  }}
                >
                  {NODE_COLOR_NAMES.map((hue) => {
                    const isCurrent = hue === k.hue;
                    const disabled = kinds.some((other) => other.id !== k.id && other.hue === hue);
                    return (
                      <button
                        key={hue}
                        type="button"
                        disabled={disabled}
                        title={disabled ? `${capHue(hue)} — in use` : capHue(hue)}
                        onClick={(e) => { e.stopPropagation(); pickHue(k, hue); }}
                        style={{
                          width: 18,
                          height: 18,
                          padding: 0,
                          border: 'none',
                          borderRadius: 'var(--radius-full)',
                          background: NODE_COLORS[hue].base,
                          boxShadow: isCurrent ? `0 0 0 2px var(--surface-card), 0 0 0 3.5px ${NODE_COLORS[hue].ring}` : 'none',
                          opacity: disabled ? 0.25 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* body — the plaque when editing, otherwise the label voice */}
            {editing ? (
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                {onRename ? (
                  <input
                    ref={labelRef}
                    value={labelDraft}
                    placeholder={capHue(k.hue)}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onBlur={commitLabel}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); commitLabel(); descRef.current?.focus(); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                    }}
                    style={{
                      width: '100%',
                      padding: '2px 6px',
                      border: '1px solid var(--border-default)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-card)',
                      color: 'var(--text-primary)',
                      fontFamily: 'inherit',
                      fontSize: 'var(--text-sm)',
                      fontWeight: 700,
                    }}
                  />
                ) : (
                  <span style={{ fontWeight: empty ? 600 : 700, color: empty ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                    {empty ? capHue(k.hue) : k.label}
                  </span>
                )}
                {onDescribe && (
                  <input
                    ref={descRef}
                    value={descDraft}
                    maxLength={80}
                    placeholder="What belongs here?"
                    onChange={(e) => setDescDraft(e.target.value)}
                    onBlur={commitDesc}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); finishEdit(); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                    }}
                    style={{
                      width: '100%',
                      padding: '2px 6px',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-card)',
                      color: 'var(--text-secondary)',
                      fontFamily: 'inherit',
                      fontSize: 'var(--text-xs)',
                      fontWeight: 400,
                    }}
                  />
                )}
              </div>
            ) : (
              <span
                onDoubleClick={() => beginEdit(k)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: empty ? 600 : 700,
                  color: empty ? 'var(--text-tertiary)' : 'var(--text-primary)',
                }}
              >
                {empty ? capHue(k.hue) : k.label}
              </span>
            )}

            {/* trailing working face — a count for in-use kinds, a remove × for empties */}
            {!editing && hover && (
              k.count > 0 ? (
                <span style={{ flexShrink: 0, fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {k.count}
                </span>
              ) : onRemove ? (
                <button
                  type="button"
                  aria-label={`Remove ${k.label || capHue(k.hue)}`}
                  onClick={(e) => { e.stopPropagation(); onRemove(k.id); }}
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    padding: 2,
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    background: 'transparent',
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="x" size={13} />
                </button>
              ) : null
            )}
          </div>
        );
      })}

      {/* "+ Add a kind" — hover-revealed, only while a free hue remains to hand out */}
      {hover && onAdd && freeHue && (
        <button
          type="button"
          onClick={() => onAdd(freeHue)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            marginTop: 2,
            padding: '6px 8px',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            fontFamily: 'inherit',
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Icon name="plus" size={13} />
          Add a kind
        </button>
      )}
    </div>
  );
}

export default KindLegend;
