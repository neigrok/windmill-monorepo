// SkillTreeView mounts exactly one of this, its sibling remove-link bar, or the sheet — never two.
// `inPanel` drops the fixed positioning so the tablet seats it in the detail panel column.

import React from 'react';
import { Icon } from '../../../../design-system';

const shellBase = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-2) var(--space-3)',
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

const prompt = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const pill = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0 var(--space-4)',
  flexShrink: 0,
  borderRadius: 'var(--radius-md)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  cursor: 'pointer',
};

const iconButton = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  flexShrink: 0,
  padding: 0,
  border: 0,
  borderRadius: 'var(--radius-md)',
  background: 'none',
  color: 'var(--color-bark)',
  cursor: 'pointer',
};

const SEGMENTS = [
  { direction: 'unlocks', label: 'unlocks →' },
  { direction: 'needs', label: '← needs' },
];

export function AimBar({ sourceLabel, direction, onToggleDirection, onCancel, inPanel = false }) {
  const label = sourceLabel || 'this step';
  return (
    <div style={{ ...shellBase, ...(inPanel ? shellInPanel : shellFixed) }} role="group" aria-label="Choose a step to connect">
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <span style={prompt}>
          {direction === 'needs'
            ? <>Tap a prerequisite for <strong>{label}</strong></>
            : <>Tap the step <strong>{label}</strong> unlocks</>}
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }} role="group" aria-label="Link direction">
          {SEGMENTS.map((segment) => {
            const active = direction === segment.direction;
            return (
              <button
                key={segment.direction}
                type="button"
                aria-pressed={active}
                onClick={() => { if (!active) onToggleDirection(); }}
                style={{
                  ...pill,
                  flex: 1,
                  padding: '0 var(--space-3)',
                  border: `1.5px solid ${active ? 'var(--color-bark)' : 'var(--border-default)'}`,
                  background: active ? 'var(--color-bark)' : 'var(--surface-card)',
                  color: active ? 'var(--surface-card)' : 'var(--color-bark)',
                }}
              >
                {segment.label}
              </button>
            );
          })}
        </div>
      </div>
      <button type="button" style={iconButton} aria-label="Cancel connect" onClick={onCancel}>
        <Icon name="x" size={20} color="var(--color-bark)" />
      </button>
    </div>
  );
}

export function RemoveLinkBar({ onRemove, onCancel, inPanel = false }) {
  return (
    <div style={{ ...shellBase, ...(inPanel ? shellInPanel : shellFixed) }} role="group" aria-label="Remove this link">
      <span style={{ ...prompt, flex: 1, minWidth: 0 }}>Remove this link?</span>
      <button
        type="button"
        onClick={onCancel}
        style={{ ...pill, border: '1.5px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--color-bark)' }}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onRemove}
        style={{ ...pill, border: '1.5px solid var(--color-bark)', background: 'var(--color-bark)', color: 'var(--surface-card)' }}
      >
        Remove
      </button>
    </div>
  );
}
