import React from 'react';

export function Tabs({ tabs, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-full)', width: 'fit-content', fontFamily: 'var(--font-body)' }}>
      {tabs.map((t) => {
        const isActive = t.value === value;
        return (
          <button
            key={t.value}
            onClick={() => onChange?.(t.value)}
            style={{
              padding: '8px 18px',
              borderRadius: 'var(--radius-full)',
              border: 'none',
              background: isActive ? 'var(--surface-card)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 700,
              fontSize: 'var(--text-sm)',
              boxShadow: isActive ? 'var(--shadow-xs)' : 'none',
              cursor: 'pointer',
              transition: 'background var(--duration-base) var(--ease-soft), box-shadow var(--duration-base) var(--ease-soft)',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
