import React from 'react';

export function IconButton({ icon, label, size = 'md', variant = 'ghost', active = false, onClick }) {
  const dims = { sm: 32, md: 40, lg: 48 };
  const d = dims[size];
  const [hover, setHover] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const bg = active
    ? 'var(--color-brand-soft)'
    : hover
    ? 'var(--surface-hover)'
    : variant === 'filled'
    ? 'var(--surface-card)'
    : 'transparent';
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: d,
        height: d,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-full)',
        border: variant === 'filled' ? '1px solid var(--border-default)' : '1px solid transparent',
        background: bg,
        color: active ? 'var(--color-brand)' : 'var(--text-primary)',
        boxShadow: focused ? 'var(--focus-ring)' : 'none',
        cursor: 'pointer',
        transition: 'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
      }}
    >
      <span style={{ width: '1.2em', height: '1.2em', display: 'inline-flex' }}>{icon}</span>
    </button>
  );
}
