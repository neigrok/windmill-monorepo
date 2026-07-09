import React from 'react';

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

// Fruit look per state: glossy radial-gradient body + a matching glow.
const fruitStyles = {
  locked: {
    body: 'radial-gradient(circle at 34% 28%, var(--neutral-200), var(--neutral-300) 75%)',
    ring: 'var(--node-locked-border)',
    icon: 'var(--node-locked-icon)',
    glow: 'none',
  },
  available: {
    body: 'radial-gradient(circle at 34% 28%, var(--accent-olive-200), var(--accent-olive-500) 80%)',
    ring: 'var(--node-available-border)',
    icon: '#FFFFFF',
    glow: 'var(--glow-olive)',
  },
  active: {
    body: 'radial-gradient(circle at 34% 28%, var(--accent-gold-200), var(--accent-gold-500) 80%)',
    ring: 'var(--node-active-border)',
    icon: '#FFFFFF',
    glow: 'var(--glow-gold)',
  },
  complete: {
    body: 'radial-gradient(circle at 34% 28%, var(--accent-gold-200), var(--accent-terracotta-600) 85%)',
    ring: 'var(--node-complete-border)',
    icon: '#FFFFFF',
    glow: 'var(--glow-terracotta)',
  },
};

export function SkillNode({ label, state = 'locked', icon = null, size = 64, onClick, pulse = true }) {
  const s = fruitStyles[state] || fruitStyles.locked;
  const [hover, setHover] = React.useState(false);
  const interactive = state !== 'locked';
  const seed = hashStr(label || 'node');
  const hasLeaf = state !== 'locked' && seed % 3 !== 0; // leaves are common but imperfect — skip on ~1/3
  const leafSide = seed % 2 === 0 ? 1 : -1;
  const leafRotate = leafSide * (18 + (seed % 14));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)', width: size + 40 }}>
      <div style={{ position: 'relative', width: size, height: size + 12 }}>
        {/* stem */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            width: 4,
            height: 14,
            marginLeft: -2,
            borderRadius: 2,
            background: state === 'locked' ? 'var(--color-bark-dry)' : 'var(--color-bark)',
            boxShadow: state === 'locked' ? 'none' : 'inset -1px 0 0 var(--color-bark-shadow)',
          }}
        />
        {/* leaf — small, imperfect, only on some unlocked nodes */}
        {hasLeaf && (
          <svg
            width="20" height="14" viewBox="0 0 20 14"
            style={{ position: 'absolute', top: -3, left: leafSide > 0 ? '58%' : '22%', transform: `rotate(${leafRotate}deg)` }}
          >
            <path d="M1 9 C 4 -1, 16 -1, 19 6 C 12 6, 5 9, 1 9 Z" fill="var(--color-leaf-light)" stroke="var(--color-leaf-vein)" strokeWidth="0.6" />
          </svg>
        )}
        <button
          onClick={interactive ? onClick : undefined}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: size,
            height: size,
            borderRadius: '58% 62% 55% 60% / 60% 55% 62% 55%',
            border: `2px solid ${s.ring}`,
            background: s.body,
            boxShadow: (state === 'available' || state === 'active' || state === 'complete') ? s.glow : 'var(--shadow-xs)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: interactive ? 'pointer' : 'default',
            color: s.icon,
            transform: hover && interactive ? 'scale(1.06)' : 'scale(1)',
            transition: 'transform var(--duration-base) var(--ease-soft), box-shadow var(--duration-base) var(--ease-soft)',
            animation: pulse && (state === 'available' || state === 'active')
              ? `${state === 'available' ? 'wm-pulse-glow-olive' : 'wm-pulse-glow-gold'} var(--duration-glow) var(--ease-glow) infinite`
              : 'none',
          }}
        >
          <span style={{ width: size * 0.4, height: size * 0.4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
        </button>
      </div>
      {label && (
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: state === 'locked' ? 'var(--text-tertiary)' : 'var(--text-primary)', textAlign: 'center' }}>
          {label}
        </span>
      )}
    </div>
  );
}
