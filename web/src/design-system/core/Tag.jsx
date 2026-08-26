import React from 'react';

// `sm` is the dense row's tag: the same pill at the size a meta line can carry. The selected edge is
// `--chip-selected-edge`, a role a room may answer for itself; every other colour here is a shared
// role and follows the room it is dropped into on its own.
const sizes = {
  sm: { padding: '3px 9px', fontSize: 'var(--text-xs)' },
  md: { padding: '6px 12px', fontSize: 'var(--text-sm)' },
};

export function Tag({ children, onRemove, selected = false, size = 'md' }) {
  const [hover, setHover] = React.useState(false);
  const s = sizes[size] ?? sizes.md;
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: s.padding,
        borderRadius: 'var(--radius-full)',
        background: selected ? 'var(--color-brand-soft)' : hover ? 'var(--surface-hover)' : 'var(--surface-sunken)',
        border: selected ? '1px solid var(--chip-selected-edge)' : '1px solid var(--border-subtle)',
        color: selected ? 'var(--color-brand-hover)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-body)',
        fontSize: s.fontSize,
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
