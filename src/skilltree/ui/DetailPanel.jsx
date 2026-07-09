// The node inspector: label, current state, prerequisite checklist, and the
// one write path the whole feature exposes to the user — "Mark complete".
// Purely presentational; SkillTreeView derives every prop via UnlockRules.

import React from 'react';
import { Card, Badge, Button, IconButton, Icon } from '../../components';

const STATE_TONE = { locked: 'neutral', available: 'success', active: 'warning', complete: 'brand' };
const STATE_LABEL = { locked: 'Locked', available: 'Available', active: 'In progress', complete: 'Complete' };

export function DetailPanel({ node, state, prerequisites, canComplete, onMarkComplete, onClose }) {
  if (!node) return null;

  return (
    <Card style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 'var(--radius-full)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--surface-sunken)',
              color: 'var(--text-primary)',
            }}
          >
            <Icon name={node.icon} size={20} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)', color: 'var(--text-primary)' }}>
              {node.label}
            </div>
            <Badge tone={STATE_TONE[state] || 'neutral'}>{STATE_LABEL[state] || state}</Badge>
          </div>
        </div>
        <IconButton icon={<Icon name="x" />} label="Close" size="sm" onClick={onClose} />
      </div>

      <div>
        <div
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 800,
            letterSpacing: 'var(--tracking-wide)',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            marginBottom: 'var(--space-2)',
          }}
        >
          Prerequisites
        </div>
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

      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
        {state === 'complete' ? (
          <Badge tone="brand" dot>Completed</Badge>
        ) : (
          <Button variant="primary" disabled={!canComplete} onClick={onMarkComplete} icon={<Icon name="check" />}>
            Mark complete
          </Button>
        )}
      </div>
    </Card>
  );
}
