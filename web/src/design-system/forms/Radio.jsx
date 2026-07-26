import React from 'react';

export function Radio({ label, checked, onChange }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
      <span
        onClick={() => onChange?.()}
        style={{
          width: 20,
          height: 20,
          borderRadius: '999px',
          border: `1.5px solid ${checked ? 'var(--color-brand)' : 'var(--border-strong)'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'border-color var(--duration-fast) var(--ease-standard)',
        }}
      >
        {checked && <span style={{ width: 10, height: 10, borderRadius: '999px', background: 'var(--color-brand)' }} />}
      </span>
      {label && <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>{label}</span>}
    </label>
  );
}
