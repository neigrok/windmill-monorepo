// The settings page's shared visual language: a titled block, and the small set of style
// tokens the four sections lay their rows out with. One home for the look so Profile,
// Connected tools, Sessions and Your data read as one page, not four.

import React from 'react';

export function Section({ title, children }) {
  return (
    <section style={wrap}>
      <h2 style={heading}>{title}</h2>
      {children}
    </section>
  );
}

export default Section;

const wrap = { borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginTop: 16 };
const heading = {
  fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 800, letterSpacing: '.01em',
  color: 'var(--text-primary)', margin: '0 0 10px',
};

export const styles = {
  calmLine: { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' },
  rowMain: { flex: 1, minWidth: 0 },
  primaryText: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metaText: { fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: 1 },
  fieldLabel: { fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)', margin: '0 0 5px' },
  readonly: { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)' },
  tag: {
    fontSize: '9px', fontWeight: 800, letterSpacing: '.05em', color: 'var(--accent-olive-600)',
    background: 'var(--accent-olive-50)', borderRadius: 'var(--radius-full)', padding: '2px 8px', flex: 'none',
  },
  dashedRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
    padding: '10px', marginTop: 8, boxSizing: 'border-box',
    border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-md)', background: 'transparent',
    fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-secondary)',
    textDecoration: 'none', cursor: 'pointer',
  },
};

// The quiet × on a session/grant row — a small icon button that warms on hover, never a
// brick. Shared so every revoke affordance in settings looks identical.
export function QuietX({ label, onClick, disabled = false }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 'var(--radius-full)', cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? 'var(--surface-hover)' : 'transparent',
        color: hover && !disabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
        opacity: disabled ? 0.4 : 1, fontSize: 16, lineHeight: 1,
        transition: 'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)',
      }}
    >
      ×
    </button>
  );
}
