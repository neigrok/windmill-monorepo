import React from 'react';

export function Input({ label, placeholder, value, onChange, error, type = 'text', icon = null }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)' }}>
      {label && <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</span>}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-card)',
          border: `1.5px solid ${error ? 'var(--color-danger)' : focus ? 'var(--accent-terracotta-400)' : 'var(--border-default)'}`,
          boxShadow: focus ? 'var(--focus-ring)' : 'none',
          transition: 'box-shadow var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
        }}
      >
        {icon && <span style={{ width: 16, height: 16, color: 'var(--text-tertiary)' }}>{icon}</span>}
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            font: 'inherit',
            fontSize: 'var(--text-base)',
            color: 'var(--text-primary)',
            width: '100%',
          }}
        />
      </span>
      {error && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  );
}
