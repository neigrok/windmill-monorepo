import React from 'react';

export function Card({ children, padding = 'var(--space-6)', hoverable = false, style = {} }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onMouseEnter={() => hoverable && setHover(true)}
      onMouseLeave={() => hoverable && setHover(false)}
      style={{
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-subtle)',
        padding,
        boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'box-shadow var(--duration-base) var(--ease-soft), transform var(--duration-base) var(--ease-soft)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
