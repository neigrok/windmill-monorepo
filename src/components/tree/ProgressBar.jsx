import React from 'react';

export function ProgressBar({ value, max = 100, label, tone = 'brand' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const fill = {
    brand: 'linear-gradient(90deg, var(--accent-terracotta-400), var(--accent-gold-400))',
    success: 'var(--color-success)',
  }[tone];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)', width: '100%' }}>
      {label && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-secondary)' }}>
          <span>{label}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      )}
      <div style={{ height: 10, borderRadius: 'var(--radius-full)', background: 'var(--surface-sunken)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: fill,
            borderRadius: 'var(--radius-full)',
            transition: 'width var(--duration-slow) var(--ease-soft)',
          }}
        />
      </div>
    </div>
  );
}
