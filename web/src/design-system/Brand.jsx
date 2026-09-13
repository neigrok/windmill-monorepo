import React from 'react';

export function BrandMark({ size = 28 }) {
  return <img src="/brand-mark.svg" alt="" width={size} height={size} style={{ display: 'block', flex: 'none', objectFit: 'contain' }} />;
}

export function BrandWordmark({ size = 28, className, style }) {
  return (
    <span className={className} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.35em', verticalAlign: 'middle',
      whiteSpace: 'nowrap', fontFamily: 'var(--font-display)', fontWeight: 700, ...style,
    }}>
      <BrandMark size={size} />
      <span>Windmill</span>
    </span>
  );
}

export function BrandLogo({ width = 128, style }) {
  return <img src="/brand-logo.svg" alt="Windmill" width={width} height={width * 620 / 512} style={{ display: 'block', ...style }} />;
}
