import React from 'react';
import { Ghost, GhostBar } from '../../design-system/index.js';

// A width, not a max-width: in this flex column a max-width alone sizes to content.
const COLUMN = { width: 'min(560px, 100%)', margin: '0 auto', padding: '28px 16px 96px' };

const CARD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 16px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  background: 'var(--surface-card)',
};

export function RoutinesGhost() {
  return (
    <Ghost>
      <div style={COLUMN}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1, 2].map((card) => (
            <div key={card} style={CARD}>
              <GhostBar width="46%" height={12} tone="var(--neutral-200)" />
              <GhostBar width="72%" height={9} />
              <GhostBar width="54%" height={9} />
            </div>
          ))}
        </div>
      </div>
    </Ghost>
  );
}
