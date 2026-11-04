import React from 'react';

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

// `active` means the branch STARTS in a done node.
export function SkillConnector({ from, to, active = false, animate = true, seedKey = '', glowColor = 'var(--connector-active)' }) {
  const seed = hashStr(`${from.x},${from.y}-${to.x},${to.y}-${seedKey}`);
  // A small, stable perpendicular bend so the curve reads as a curve, not a straight line.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = (((seed % 100) / 100) - 0.5) * len * 0.18;
  const cx = (from.x + to.x) / 2 + nx * bend;
  const cy = (from.y + to.y) / 2 + ny * bend;
  const d = `M ${from.x} ${from.y} Q ${cx} ${cy}, ${to.x} ${to.y}`;

  return (
    <path
      d={d}
      fill="none"
      stroke={active ? glowColor : 'var(--connector-inactive)'}
      strokeWidth={active ? 3 : 2}
      strokeLinecap="round"
      style={{
        ...(active ? {} : { opacity: 0.7 }),
        ...(active && animate ? { animation: 'wm-fade-in-up var(--duration-slow) var(--ease-soft)' } : {}),
      }}
    />
  );
}
