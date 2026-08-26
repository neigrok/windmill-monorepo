import React from 'react';

// `href` draws the same button as an anchor — a destination that looks like the action it is — and
// `full` gives it the width of its column, for the one button a narrow screen puts under the thumb.
// `ariaBusy` is for the button that stays tappable while the request it fired is in the air.
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon = null,
  disabled = false,
  onClick,
  type = 'button',
  href = null,
  full = false,
  ariaLabel = null,
  ariaBusy = false,
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
  const [focused, setFocused] = React.useState(false);

  const boxShadow = disabled
    ? 'none'
    : focused
    ? (v.shadow === 'none' ? 'var(--focus-ring)' : `${v.shadow}, var(--focus-ring)`)
    : v.shadow;

  // A disabled anchor keeps no href — the only way an anchor stops being a destination — and says so.
  const Frame = href ? 'a' : 'button';
  const frameProps = href
    ? { href: disabled ? undefined : href, role: 'link', 'aria-disabled': disabled ? 'true' : undefined }
    : { type, disabled };

  return (
    <Frame
      {...frameProps}
      aria-label={ariaLabel ?? undefined}
      aria-busy={ariaBusy ? 'true' : undefined}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: full ? 'flex' : 'inline-flex',
        width: full ? '100%' : undefined,
        boxSizing: 'border-box',
        textDecoration: 'none',
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
        boxShadow,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: `background var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)`,
        transform: active && !disabled ? 'scale(0.97)' : 'scale(1)',
      }}
    >
      {icon && <span style={{ display: 'inline-flex', width: '1.1em', height: '1.1em' }}>{icon}</span>}
      {children}
    </Frame>
  );
}
