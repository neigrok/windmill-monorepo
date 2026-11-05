import React, { useEffect, useRef, useState } from 'react';
import { Icon, Card } from '../../../../design-system';
import { NodeAnnotation, ReadOnlyStateChip, SheetStateFruit, SheetRelations } from '../StepPanel.jsx';
import { KindChoice } from '../../board/BoardControls.jsx';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../../theme.js';
import { COMPOSER, deleteCostLine } from '../../copy.js';
import { kindChoices } from '../../model/Legend.js';

const verbBase = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-2)',
  flex: 1,
  minHeight: 44,
  padding: '0 var(--space-3)',
  borderRadius: 'var(--radius-md)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  cursor: 'pointer',
};

const barkVerb = {
  ...verbBase,
  background: 'var(--surface-card)',
  border: '1.5px solid var(--color-bark)',
  color: 'var(--color-bark)',
};

// A locked step offers nothing; a completed one offers the reversal; everything else marks done.
// The root is included: blocking root completion would freeze all progress.
export function progressVerb(state) {
  if (state === 'complete') return 'uncomplete';
  if (state === 'locked') return null;
  return 'complete';
}

export function TabletEditor({ node, state, prerequisites = [], unlocks = [], completedAt, legend = [], autoFocusName = false, deletable = true, onRename, onAddStep, onConnect, onSetKind, onMarkDone, onUnmarkDone, onDelete, onJump }) {
  const [editingName, setEditingName] = useState(!!autoFocusName);
  const [draft, setDraft] = useState(node?.label ?? '');
  const inputRef = useRef(null);
  const escapedRef = useRef(false); // Esc reverts — the blur that follows must not commit

  useEffect(() => {
    if (!editingName) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingName]);

  if (!node) return null;

  const currentKind = node.color ?? DEFAULT_NODE_COLOR;
  const hue = KIND_CSS[currentKind] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  const progress = progressVerb(state);
  const blocker = state === 'locked' ? prerequisites.find((prerequisite) => !prerequisite.complete)?.label : null;
  const showChip = state === 'complete' || state === 'locked';
  const hasDag = prerequisites.length > 0 || unlocks.length > 0;

  const commitOrRevertName = () => {
    setEditingName(false);
    if (escapedRef.current) {
      escapedRef.current = false;
      setDraft(node.label);
      return;
    }
    const label = draft.trim();
    if (label !== node.label.trim()) onRename(node.id, label);
  };

  return (
    <Card style={{ maxHeight: '70vh', overflowY: 'auto' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 34 }}>
        <SheetStateFruit state={state} hue={hue} />
        {editingName ? (
          <input
            ref={inputRef}
            className="st-step-name-input"
            value={draft}
            placeholder="Name this step"
            style={{ flex: 1, minWidth: 0, minHeight: 34 }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitOrRevertName}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape') { event.preventDefault(); escapedRef.current = true; event.currentTarget.blur(); }
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className={`st-step-name ${node.label ? '' : 'st-step-name--empty'}`}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flex: 1, minWidth: 0, minHeight: 34 }}
              onClick={() => { setDraft(node.label); setEditingName(true); }}
            >
              <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label || 'Name this step'}</span>
              <Icon name="pencil" size={15} />
            </button>
            {showChip && <ReadOnlyStateChip state={state} hue={hue} completedAt={completedAt} />}
          </>
        )}
      </div>

      <NodeAnnotation description={node.description} links={node.links} />

      {blocker && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          <Icon name="lock" size={13} color="var(--text-tertiary)" />
          <span>Finish <strong style={{ color: 'var(--text-secondary)' }}>{blocker}</strong> to unlock</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {progress && (
          <button
            type="button"
            style={progress === 'complete' ? { ...verbBase, background: hue.base, border: `1.5px solid ${hue.ring}`, color: 'var(--text-on-accent)' } : barkVerb}
            onClick={() => {
              if (progress === 'complete') return onMarkDone(node.id);
              onUnmarkDone(node.id);
            }}
          >
            <Icon name={progress === 'complete' ? 'check' : 'rotate-ccw'} size={16} color={progress === 'complete' ? '#fff' : undefined} />
            {progress === 'complete' ? 'Mark done' : 'Mark not done'}
          </button>
        )}
        <button type="button" style={barkVerb} onClick={() => onAddStep(node.id)}>
          <Icon name="plus" size={16} />
          Add step
        </button>
        <button type="button" style={barkVerb} onClick={() => onConnect(node.id)}>
          <Icon name="git-branch-plus" size={16} />
          Connect
        </button>
      </div>

      <div className="st-step-kind">
        <KindChoice
          kinds={kindChoices(legend)}
          value={currentKind}
          label={COMPOSER.kind}
          follow={false}
          onChoose={(choice) => { if (choice !== currentKind) onSetKind(node.id, choice); }}
        />
      </div>

      {deletable && (
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)', width: '100%', minHeight: 44, padding: '0 var(--space-3)', border: 0, borderRadius: 'var(--radius-md)', background: 'none', fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-bark)', cursor: 'pointer' }}
          onClick={() => onDelete(node.id)}
        >
          <Icon name="trash-2" size={16} color="var(--color-bark)" />
          {deleteCostLine(unlocks.length)}
        </button>
      )}

      {hasDag && <div style={{ height: 1, background: 'var(--border-subtle)', margin: 'var(--space-1) 0' }} />}
      <SheetRelations title="Needs" items={prerequisites} onJump={onJump} />
      <SheetRelations title="Unlocks" items={unlocks} onJump={onJump} />
    </div>
    </Card>
  );
}
