import React from 'react';

export function Select({ label, value, onChange, options }) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value) || options[0];
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)' }}>
      {label && <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700 }}>{label}</span>}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-card)',
          border: `1.5px solid ${open ? 'var(--accent-terracotta-400)' : 'var(--border-default)'}`,
          boxShadow: open ? 'var(--focus-ring)' : 'none',
          fontSize: 'var(--text-base)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {current?.label}
        <span style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--duration-fast) var(--ease-standard)' }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 6,
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            overflow: 'hidden',
            zIndex: 10,
            animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
          }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              onClick={() => { onChange?.(o.value); setOpen(false); }}
              style={{
                padding: '10px 14px',
                fontSize: 'var(--text-base)',
                background: o.value === value ? 'var(--color-brand-soft)' : 'transparent',
                color: o.value === value ? 'var(--color-brand-hover)' : 'var(--text-primary)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { if (o.value !== value) e.currentTarget.style.background = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { if (o.value !== value) e.currentTarget.style.background = 'transparent'; }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
