import React from 'react';

// Colour comes from `kind`; tier comes from `state` and is shown by treatment alone — the tier never re-hues.
const KINDS = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
const STATES = ['locked', 'available', 'active', 'complete'];

export function SkillNode({
  label,
  kind = 'terracotta',
  state, // 'locked' | 'available' | 'active' | 'complete'
  done = false, // alias: done → 'complete', not-done → 'locked'. Prefer `state`.
  progress = null, // 0–1 sub-task fraction; renders the gauge arc + track. null = no gauge.
  icon = null,
  size = 56, // world units (theme.js NODE_SIZE)
  onClick,
  pulse = false, // infinite breath is opt-in
}) {
  const k = KINDS.includes(kind) ? kind : 'terracotta';
  const s = STATES.includes(state) ? state : done ? 'complete' : 'locked';
  const base = `var(--kind-${k})`;
  const glow = `var(--kind-${k}-glow)`;
  const [hover, setHover] = React.useState(false);
  const noMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // wm-ember frozen at mid-breath: the reduced-motion / pulse-off face
  const emberRest = `0 0 8px 0 color-mix(in srgb, ${glow} 44%, transparent), 0 0 15px 2px color-mix(in srgb, ${glow} 20%, transparent)`;

  const body = {
    locked: {
      background: `color-mix(in oklab, ${base} 22%, var(--surface-card))`,
      border: `1.5px solid color-mix(in oklab, ${base} 52%, var(--border-default))`,
      color: `color-mix(in oklab, ${base} 62%, var(--text-tertiary))`,
      boxShadow: 'var(--shadow-xs)',
    },
    available: {
      background: 'var(--surface-card)',
      border: `2px solid ${base}`,
      color: `color-mix(in oklab, ${base} 80%, var(--text-primary))`,
      boxShadow: 'var(--shadow-xs)',
    },
    active: {
      background: `color-mix(in oklab, ${base} 34%, var(--surface-card))`,
      border: `2px solid ${base}`,
      color: `color-mix(in oklab, ${base} 72%, var(--text-primary))`,
      boxShadow: emberRest,
    },
    complete: {
      background: base,
      border: `2px solid ${base}`,
      color: 'var(--text-on-accent)',
      boxShadow: `0 0 0 4px ${glow}, 0 0 30px ${glow}`,
    },
  }[s];

  const animation =
    !noMotion && pulse && s === 'complete'
      ? 'wm-pulse-node var(--duration-glow) var(--ease-glow) infinite'
      : !noMotion && pulse && s === 'active'
        ? 'wm-ember var(--duration-glow) var(--ease-glow) infinite'
        : 'none';

  // the sub-task gauge: starts at 12 o'clock, clockwise
  const showArc = typeof progress === 'number' && s !== 'complete';
  const frac = showArc ? Math.max(0, Math.min(1, progress)) : 0;
  const arcR = size / 2 + 5;
  const svgSize = size + 14;
  const circ = 2 * Math.PI * arcR;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)', width: size + 40 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        {showArc && (
          <svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={{
              position: 'absolute',
              left: size / 2 - svgSize / 2,
              top: size / 2 - svgSize / 2,
              opacity: s === 'locked' ? 0.32 : 1,
              pointerEvents: 'none',
            }}
          >
            <circle cx={svgSize / 2} cy={svgSize / 2} r={arcR} fill="none" strokeWidth="2"
              stroke={`color-mix(in srgb, ${glow} 36%, transparent)`} />
            {frac > 0 && (
              <circle cx={svgSize / 2} cy={svgSize / 2} r={arcR} fill="none" strokeWidth="2"
                stroke={base} strokeLinecap="round"
                strokeDasharray={`${circ * frac} ${circ}`}
                transform={`rotate(-90 ${svgSize / 2} ${svgSize / 2})`}
                style={{ transition: noMotion ? 'none' : 'stroke-dasharray var(--duration-base) var(--ease-standard)' }} />
            )}
          </svg>
        )}
        <button
          onClick={onClick}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: size,
            height: size,
            borderRadius: '50%',
            ...body,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: onClick ? 'pointer' : 'default',
            opacity: 1,
            '--nd-glow': glow,
            transform: hover && onClick ? 'scale(1.06)' : 'scale(1)',
            transition: 'transform var(--duration-base) var(--ease-soft), box-shadow var(--duration-base) var(--ease-soft), opacity var(--duration-base) var(--ease-soft)',
            animation,
          }}
        >
          <span style={{ width: size * 0.4, height: size * 0.4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
        </button>
      </div>
      {label && (
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: s === 'locked' ? 'var(--text-tertiary)' : s === 'available' ? 'var(--text-secondary)' : 'var(--text-primary)', textAlign: 'center' }}>
          {label}
        </span>
      )}
    </div>
  );
}
