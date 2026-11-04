// The tablet owner's panel holds one surface at a time: the selection's editor, or the aim, remove-link and bulk bars.

import React from 'react';
import { Icon } from '../../../../design-system';
import { KIND_CSS } from '../../theme.js';
import { GraphDock } from '../GraphChrome.jsx';
import { TabletEditor } from './TabletEditor.jsx';

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

function AimBar({ sourceLabel, direction, onToggleDirection, onCancel }) {
  const label = sourceLabel || 'this step';
  return (
    <div style={{ ...shellBase, width: '100%' }} role="group" aria-label="Choose a step to connect">
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

function RemoveLinkBar({ onRemove, onCancel }) {
  return (
    <div style={{ ...shellBase, width: '100%' }} role="group" aria-label="Remove this link">
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

const bulkShell = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  padding: 'var(--space-3)',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-lg)',
};

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

function BulkBar({ count, choice, onRecolor, onDelete, onDone }) {
  const plural = count === 1 ? '' : 's';
  return (
    <div style={{ ...bulkShell, width: '100%' }} role="group" aria-label={`${count} selected`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span style={countLabel}>{count} selected</span>
        <button type="button" style={doneButton} onClick={onDone}>Done</button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label="Recolor selected steps">
        {choice.kinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-label={`Set kind to ${kind.label}`}
            style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, background: 'none', cursor: 'pointer' }}
            onClick={() => onRecolor(kind.hue)}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: KIND_CSS[kind.hue].base,
                boxShadow: kind.hue === choice.shared ? '0 0 0 3px var(--text-primary)' : '0 0 0 1px var(--border-default)',
              }}
            />
          </button>
        ))}
      </div>

      {onDelete && (
        <button type="button" style={deleteButton} onClick={onDelete}>
          <Icon name="trash-2" size={16} color="var(--surface-card)" />
          Delete {count} step{plural}
        </button>
      )}
    </div>
  );
}

export function TabletPanel({ tablet, open, top, selectedNode, selectedState, nodesById, prerequisites, unlocks, completedAt, legend, autoFocusName, deletable, onMarkDone, onUnmarkDone, onDelete, onJump, selectedCount, bulkChoice, onBulkRecolor, onBulkDelete, onBulkDone }) {
  const { surface, aim } = tablet;
  return (
    <GraphDock open={open} top={top} tablet tenant={surface === 'editor' ? selectedNode.id : surface}>
      {surface === 'bulk' && (
        <BulkBar count={selectedCount} choice={bulkChoice} onRecolor={onBulkRecolor} onDelete={onBulkDelete} onDone={onBulkDone} />
      )}
      {surface === 'aim' && (
        <AimBar sourceLabel={nodesById.get(aim.sourceId)?.label} direction={aim.direction} onToggleDirection={tablet.flipAimDirection} onCancel={() => tablet.setAim(null)} />
      )}
      {surface === 'remove' && <RemoveLinkBar onRemove={tablet.removeLink} onCancel={() => tablet.setRemoving(null)} />}
      {surface === 'editor' && (
        <TabletEditor
          key={selectedNode.id}
          node={selectedNode}
          state={selectedState}
          prerequisites={prerequisites}
          unlocks={unlocks}
          completedAt={completedAt}
          legend={legend}
          autoFocusName={autoFocusName}
          onRename={tablet.renameStep}
          onAddStep={tablet.addStepUnder}
          onConnect={tablet.enterAim}
          onSetKind={tablet.recolorStep}
          onMarkDone={onMarkDone}
          onUnmarkDone={onUnmarkDone}
          onDelete={onDelete}
          onJump={onJump}
          deletable={deletable}
        />
      )}
    </GraphDock>
  );
}
