import React from 'react';

export function Tag({ children, onRemove, selected = false }) {
  const [hover, setHover] = React.useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 12px',
        borderRadius: 'var(--radius-full)',
        background: selected ? 'var(--color-brand-soft)' : hover ? 'var(--surface-hover)' : 'var(--surface-sunken)',
        border: selected ? '1px solid var(--accent-terracotta-400)' : '1px solid var(--border-subtle)',
        color: selected ? 'var(--color-brand-hover)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        transition: 'background var(--duration-fast) var(--ease-standard)',
      }}
    >
      {children}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label="Remove"
          style={{
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'inherit',
            opacity: 0.6,
            fontSize: '14px',
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
