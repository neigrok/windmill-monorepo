import React, { useState } from 'react';

// A real checkbox under the paint: the input carries focus, the space key and the state a screen
// reader announces, and the wrapping label makes the whole control one hit target.
export function Switch({ checked, onChange, label }) {
  const [ring, setRing] = useState(false); // keyboard focus only — a pointer press draws no ring

  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
      <input
        type="checkbox"
        role="switch"
        checked={!!checked}
        onChange={(event) => onChange?.(event.target.checked)}
        onFocus={(event) => setRing(event.target.matches(':focus-visible'))}
        onBlur={() => setRing(false)}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, margin: 0, pointerEvents: 'none' }}
      />
      <span
        style={{
          width: 40,
          height: 24,
          borderRadius: '999px',
          background: checked ? 'var(--color-brand)' : 'var(--neutral-300)',
          position: 'relative',
          transition: 'background var(--duration-base) var(--ease-standard)',
          boxShadow: ring ? '0 0 0 3px rgba(188, 108, 66, .35)' : 'none',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: checked ? 19 : 3,
            width: 18,
            height: 18,
            borderRadius: '999px',
            background: '#fff',
            boxShadow: 'var(--shadow-xs)',
            transition: 'left var(--duration-base) var(--ease-soft)',
          }}
        />
      </span>
      {label && <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>{label}</span>}
    </label>
  );
}
