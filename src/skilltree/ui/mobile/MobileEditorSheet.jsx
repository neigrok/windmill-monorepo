// The phone editor sheet (M1): the read-only detail grown a set of editing verbs for
// the tree's owner. It flows top-to-bottom — rename-in-place title, state chip, the
// bark verb rail, the recolor swatches (all inside the ~300px peek), then the DAG
// (description, branch, Needs, Unlocks) on expand, and Delete alone at the foot. Purely
// presentational: every verb dispatches through the handlers SkillTreeView passes, which
// wrap the same handle* callbacks the desktop editor uses (with a mobile undo snackbar).

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../components';
import { NodeAnnotation, ReadOnlyStateChip, ReadOnlyRelations } from '../StepPanel.jsx';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../../theme.js';
import { deleteCostLine, progressVerb } from './editorSheet.js';

const RO_DOT = { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 };

function cap(hue) {
  return hue.charAt(0).toUpperCase() + hue.slice(1);
}

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

export function MobileEditorSheet({ node, state, prerequisites = [], unlocks = [], completedAt, kinds = [], autoFocusName = false, onRename, onAddStep, onSetKind, onMarkDone, onUnmarkDone, onDelete }) {
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
  const hue = NODE_COLORS[currentKind] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  const legendKinds = kinds.length > 0 ? kinds : Object.keys(NODE_COLORS).map((h) => ({ id: h, hue: h }));
  const branchLabel = kinds.find((kind) => kind.hue === currentKind)?.label || cap(currentKind);
  const isRoot = prerequisites.length === 0;
  const progress = progressVerb(state);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', paddingTop: 'var(--space-2)' }}>
      {editingName ? (
        <input
          ref={inputRef}
          className="st-step-name-input"
          value={draft}
          placeholder="Name this step"
          style={{ minHeight: 44 }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitOrRevertName}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') { event.preventDefault(); escapedRef.current = true; event.currentTarget.blur(); }
          }}
        />
      ) : (
        <button
          type="button"
          className={`st-step-name ${node.label ? '' : 'st-step-name--empty'}`}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 44 }}
          onClick={() => { setDraft(node.label); setEditingName(true); }}
        >
          <span style={{ ...RO_DOT, background: hue.base }} aria-hidden />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label || 'Name this step'}</span>
          <Icon name="pencil" size={16} />
        </button>
      )}

      <ReadOnlyStateChip state={state} hue={hue} completedAt={completedAt} />

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {progress === 'complete' && (
          <button
            type="button"
            style={{ ...verbBase, background: hue.base, border: `1.5px solid ${hue.ring}`, color: '#fff' }}
            onClick={() => onMarkDone(node.id)}
          >
            <Icon name="check" size={16} color="#fff" />
            Mark done
          </button>
        )}
        {progress === 'uncomplete' && (
          <button type="button" style={barkVerb} onClick={() => onUnmarkDone(node.id)}>
            <Icon name="rotate-ccw" size={16} />
            Mark not done
          </button>
        )}
        <button type="button" style={barkVerb} onClick={() => onAddStep(node.id)}>
          <Icon name="plus" size={16} />
          Add step
        </button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label="Recolor this step">
        {legendKinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-label={`Set kind to ${kind.label || cap(kind.hue)}`}
            style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, background: 'none', cursor: 'pointer' }}
            onClick={() => { if (kind.hue !== currentKind) onSetKind(node.id, kind.hue); }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: (NODE_COLORS[kind.hue] ?? NODE_COLORS[DEFAULT_NODE_COLOR]).base,
                boxShadow: kind.hue === currentKind ? '0 0 0 3px var(--text-primary)' : '0 0 0 1px var(--border-default)',
              }}
            />
          </button>
        ))}
      </div>

      <NodeAnnotation description={node.description} links={node.links} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)' }}>
        <span style={{ ...RO_DOT, width: 9, height: 9, background: hue.base }} aria-hidden />
        {branchLabel}
      </div>

      <ReadOnlyRelations title="Needs" items={prerequisites} empty="None — this is a starting point." />
      <ReadOnlyRelations title="Unlocks" items={unlocks} empty="Nothing yet — this is a leaf." />

      {!isRoot && (
        <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)', width: '100%', minHeight: 44, padding: '0 var(--space-3)', border: 0, borderRadius: 'var(--radius-md)', background: 'none', fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-bark)', cursor: 'pointer' }}
            onClick={() => onDelete(node.id)}
          >
            <Icon name="trash-2" size={16} color="var(--color-bark)" />
            {deleteCostLine(unlocks.length)}
          </button>
        </div>
      )}
    </div>
  );
}

export default MobileEditorSheet;
