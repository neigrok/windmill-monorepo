import React from 'react';

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon = null,
  disabled = false,
  onClick,
  type = 'button',
}) {
  const sizes = {
    sm: { padding: '8px 14px', fontSize: 'var(--text-sm)', gap: '6px', radius: 'var(--radius-md)' },
    md: { padding: '11px 20px', fontSize: 'var(--text-base)', gap: '8px', radius: 'var(--radius-lg)' },
    lg: { padding: '14px 26px', fontSize: 'var(--text-lg)', gap: '10px', radius: 'var(--radius-lg)' },
  };
  const variants = {
    primary: {
      background: 'var(--color-brand)',
      color: 'var(--text-on-accent)',
      border: '1px solid transparent',
      hoverBg: 'var(--color-brand-hover)',
      activeBg: 'var(--color-brand-active)',
      shadow: 'var(--shadow-sm)',
    },
    secondary: {
      background: 'var(--surface-card)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-default)',
      hoverBg: 'var(--surface-hover)',
      activeBg: 'var(--neutral-200)',
      shadow: 'var(--shadow-xs)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-primary)',
      border: '1px solid transparent',
      hoverBg: 'var(--surface-hover)',
      activeBg: 'var(--neutral-200)',
      shadow: 'none',
    },
    danger: {
      background: 'var(--color-danger)',
      color: 'var(--text-on-accent)',
      border: '1px solid transparent',
      hoverBg: 'var(--accent-brick-600)',
      activeBg: 'var(--accent-brick-600)',
      shadow: 'var(--shadow-sm)',
    },
  };
  const s = sizes[size];
  const v = variants[variant];
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        padding: s.padding,
        fontSize: s.fontSize,
        fontFamily: 'var(--font-body)',
        fontWeight: 700,
        borderRadius: s.radius,
        border: v.border,
        background: disabled ? 'var(--neutral-200)' : active ? v.activeBg : hover ? v.hoverBg : v.background,
        color: disabled ? 'var(--text-tertiary)' : v.color,
        boxShadow: disabled ? 'none' : v.shadow,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: `background var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)`,
        transform: active && !disabled ? 'scale(0.97)' : 'scale(1)',
      }}
    >
      {icon && <span style={{ display: 'inline-flex', width: '1.1em', height: '1.1em' }}>{icon}</span>}
      {children}
    </button>
  );
}
