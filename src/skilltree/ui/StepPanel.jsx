// The docked step panel — the one home for everything about the selected step:
// inline-editable name, kind swatches with live recolor preview, the prerequisite
// checklist + "Mark complete", and the lone destructive control at the bottom.
// Purely presentational; SkillTreeView derives every prop via UnlockRules.

import React, { useEffect, useRef, useState } from 'react';
import { Card, Badge, Button, IconButton, Icon } from '../../components';
import { EventRow } from '../activity/EventRow.jsx';
import { NODE_COLORS, NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';

const STATE_TONE = { locked: 'neutral', available: 'success', active: 'warning', complete: 'brand' };
const STATE_LABEL = { locked: 'Locked', available: 'Available', active: 'In progress', complete: 'Complete' };

export function StepPanel({ node, state, prerequisites, canComplete, canStart, history = [], autoFocusName, onRename, onPreviewKind, onRestoreKind, onSetKind, onStart, onMarkComplete, onReveal, onDelete, onPreviewDeleteCost, onClearDeleteCost, onClose }) {
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

  const commitOrRevertName = () => {
    setEditingName(false);
    if (escapedRef.current) {
      escapedRef.current = false;
      setDraft(node.label);
      return;
    }
    const label = draft.trim();
    if (label !== node.label) onRename(node.id, label);
  };

  return (
    <Card style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', overflowY: 'auto' }}>
      <div className="st-step-header">
        <div className="st-step-identity">
          <span className="st-step-glyph">
            <Icon name={node.icon} size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            {editingName ? (
              <input
                ref={inputRef}
                className="st-step-name-input"
                value={draft}
                placeholder="Name this step"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitOrRevertName}
                onKeyDown={(event) => {
                  event.stopPropagation(); // typing never reaches the ⌘Z / ⌫ / Esc shortcuts
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                  if (event.key === 'Escape') { event.preventDefault(); escapedRef.current = true; event.currentTarget.blur(); }
                }}
              />
            ) : (
              <button
                type="button"
                className={`st-step-name ${node.label ? '' : 'st-step-name--empty'}`}
                onClick={() => { setDraft(node.label); setEditingName(true); }}
              >
                {node.label || 'Unnamed step'}
              </button>
            )}
            <Badge tone={STATE_TONE[state] || 'neutral'}>{STATE_LABEL[state] || state}</Badge>
          </div>
        </div>
        <IconButton icon={<Icon name="x" />} label="Close" size="sm" onClick={onClose} />
      </div>

      <div>
        <div className="st-step-heading">Kind</div>
        <div className="st-step-kinds">
          {NODE_COLOR_NAMES.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`st-step-swatch ${kind === currentKind ? 'st-step-swatch--current' : ''}`}
              style={{ background: NODE_COLORS[kind].base }}
              title={kind}
              aria-label={`Set kind to ${kind}`}
              onPointerEnter={() => onPreviewKind(node.id, kind)}
              onPointerLeave={() => onRestoreKind(node.id)}
              onClick={() => onSetKind(node.id, kind)}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="st-step-heading">Prerequisites</div>
        {prerequisites.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            None — this is a starting point.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {prerequisites.map((prerequisite) => (
              <li
                key={prerequisite.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  color: prerequisite.complete ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
              >
                <Icon
                  name={prerequisite.complete ? 'check' : 'lock'}
                  size={14}
                  color={prerequisite.complete ? 'var(--color-success)' : 'var(--text-tertiary)'}
                />
                {prerequisite.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="st-step-actions">
        {state === 'complete' ? (
          <Badge tone="brand" dot>Completed</Badge>
        ) : state === 'active' ? (
          <Button variant="primary" onClick={onMarkComplete} icon={<Icon name="check" />}>
            Mark complete
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={!canComplete} onClick={onMarkComplete} icon={<Icon name="check" />}>
              Complete
            </Button>
            <Button variant="primary" disabled={!canStart} onClick={onStart} icon={<Icon name="play" />}>
              Start
            </Button>
          </>
        )}
      </div>

      <div>
        <div className="st-step-heading">History</div>
        {history.length === 0 ? (
          <div className="st-step-empty">No activity yet — this step hasn’t been touched.</div>
        ) : (
          <div className="st-step-history">
            {history.map((event) => (
              <EventRow key={event.id} event={event} node={node} now={Date.now()} onReveal={onReveal} />
            ))}
          </div>
        )}
      </div>

      <div className="st-step-danger" style={{ marginTop: 'auto' }}>
        <button
          type="button"
          className="st-step-delete"
          onPointerEnter={() => onPreviewDeleteCost(node.id)}
          onPointerLeave={() => onClearDeleteCost()}
          onClick={() => { onClearDeleteCost(); onDelete(node.id); }}
        >
          <Icon name="trash-2" size={16} />
          Delete step
        </button>
      </div>
    </Card>
  );
}
