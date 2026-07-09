import React from 'react';

export function Switch({ checked, onChange, label }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
      <span
        onClick={() => onChange?.(!checked)}
        style={{
          width: 40,
          height: 24,
          borderRadius: '999px',
          background: checked ? 'var(--color-brand)' : 'var(--neutral-300)',
          position: 'relative',
          transition: 'background var(--duration-base) var(--ease-standard)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: checked ? 19 : 3,
            width: 18,
            height: 18,
            borderRadius: '999px',
            background: '#fff',
            boxShadow: 'var(--shadow-xs)',
            transition: 'left var(--duration-base) var(--ease-soft)',
          }}
        />
      </span>
      {label && <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>{label}</span>}
    </label>
  );
}
