import React from 'react';

const palette = ['var(--accent-terracotta-400)', 'var(--accent-olive-400)', 'var(--accent-gold-400)', 'var(--accent-brick-400)'];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

export function Avatar({ name, src, size = 36 }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const bg = palette[hashName(name) % palette.length];
  return src ? (
    <img
      src={src}
      alt={name}
      style={{ width: size, height: size, borderRadius: '999px', objectFit: 'cover', border: '2px solid var(--surface-card)', boxShadow: 'var(--shadow-xs)' }}
    />
  ) : (
    <div
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '999px',
        background: bg,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-display)',
        fontWeight: 600,
        fontSize: size * 0.4,
        border: '2px solid var(--surface-card)',
        boxShadow: 'var(--shadow-xs)',
      }}
    >
      {initials}
    </div>
  );
}
