// The multi-select bulk bar (M5): long-press enters multi-select and this bar replaces the
// sheet — an "N selected" count with Done, the recolor swatch row, and a full-width Delete.
// Bottom-docked on the phone (a finger acts here, not a floating chip); `inPanel` drops the
// fixed positioning so the tablet seats it in-flow in the detail panel column. Bark/cream
// chrome — tools stay neutral, and the swatches are the one place category hue shows. Every
// control clears the 44px touch floor. One surface at a time: SkillTreeView mounts this only in
// multiMode, never beside the sheet or an aim bar. Purely presentational — every verb dispatches
// through the bulk* handlers SkillTreeView passes, which reuse the desktop editor's undoable gestures.

import React from 'react';
import { Icon } from '../../../components';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../../theme.js';

function cap(hue) {
  return hue.charAt(0).toUpperCase() + hue.slice(1);
}

const shellBase = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  padding: 'var(--space-3)',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-lg)',
};

const shellFixed = {
  position: 'fixed',
  left: 'var(--space-4)',
  right: 'var(--space-4)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--space-4))',
  zIndex: 40,
};

const shellInPanel = { width: '100%' };

const countLabel = {
  flex: 1,
  minWidth: 0,
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  color: 'var(--text-primary)',
};

const doneButton = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0 var(--space-4)',
  flexShrink: 0,
  border: '1.5px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--color-bark)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  cursor: 'pointer',
};

const deleteButton = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-2)',
  width: '100%',
  minHeight: 44,
  padding: '0 var(--space-3)',
  border: '1.5px solid var(--color-bark)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bark)',
  color: 'var(--surface-card)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  cursor: 'pointer',
};

export function BulkBar({ count = 0, kinds = [], ringedKind = null, onRecolor, onDelete, onDone, inPanel = false }) {
  const legendKinds = kinds.length > 0 ? kinds : Object.keys(NODE_COLORS).map((h) => ({ id: h, hue: h }));
  const plural = count === 1 ? '' : 's';
  return (
    <div style={{ ...shellBase, ...(inPanel ? shellInPanel : shellFixed) }} role="group" aria-label={`${count} selected`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span style={countLabel}>{count} selected</span>
        <button type="button" style={doneButton} onClick={onDone}>Done</button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label="Recolor selected steps">
        {legendKinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-label={`Set kind to ${kind.label || cap(kind.hue)}`}
            style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, background: 'none', cursor: 'pointer' }}
            onClick={() => onRecolor(kind.hue)}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: (NODE_COLORS[kind.hue] ?? NODE_COLORS[DEFAULT_NODE_COLOR]).base,
                boxShadow: kind.hue === ringedKind ? '0 0 0 3px var(--text-primary)' : '0 0 0 1px var(--border-default)',
              }}
            />
          </button>
        ))}
      </div>

      <button type="button" style={deleteButton} onClick={onDelete}>
        <Icon name="trash-2" size={16} color="var(--surface-card)" />
        Delete {count} step{plural}
      </button>
    </div>
  );
}

export default BulkBar;
