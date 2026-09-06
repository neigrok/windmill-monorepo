import React, { useRef } from 'react';
import { Icon } from '../Icon.jsx';

// A three-or-so-way choice drawn as one bar: `options` are `{ value, label, icon? }`, `value` the
// chosen one. A radiogroup for the keyboard — arrows move the choice, one tab stop for the bar —
// and the chosen segment's card slides between them unless motion is reduced. The bar is named by
// `label`, or by the element `labelledBy` points at. A value no option carries checks nothing.
export function SegmentedControl({ label, labelledBy, options, value, onChange }) {
  const buttons = useRef([]);
  const index = options.findIndex((option) => option.value === value);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const move = (event, from) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const jump = { Home: 0, End: options.length - 1 }[event.key];
    if (step === undefined && jump === undefined) return;
    event.preventDefault();
    const to = jump ?? (from + step + options.length) % options.length;
    onChange?.(options[to].value);
    buttons.current[to]?.focus();
  };

  return (
    <div
      className="wm-segmented"
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <style>{SEGMENTED_CSS}</style>
      {index >= 0 && (
        <span
          className="wm-segmented-thumb"
          aria-hidden="true"
          style={{
            width: `calc((100% - 4px - ${(options.length - 1) * 2}px) / ${options.length})`,
            transform: `translateX(calc(${index * 100}% + ${index * 2}px))`,
            transition: reduced ? 'none' : 'transform var(--duration-fast) var(--ease-standard)',
          }}
        />
      )}
      {options.map((option, i) => {
        const checked = i === index;
        return (
          <button
            key={option.value}
            ref={(el) => { buttons.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange?.(option.value)}
            onKeyDown={(event) => move(event, i)}
            className="wm-segmented-segment"
            style={{ transition: reduced ? 'none' : 'color var(--duration-fast) var(--ease-standard)' }}
          >
            {option.icon && <Icon name={option.icon} size={14} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// The hover, the checked ink and the family's focus ring are pseudo-class work, so the bar carries
// its own sheet; every value is a token.
const SEGMENTED_CSS = `
.wm-segmented { position: relative; display: grid; gap: 2px; box-sizing: border-box; height: 28px; padding: 2px; border: none;
  border-radius: var(--radius-full); background: var(--surface-sunken); font-family: var(--font-body); }
.wm-segmented-thumb { position: absolute; top: 2px; left: 2px; height: 24px; box-sizing: border-box; border-radius: var(--radius-full);
  background: var(--surface-card); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-xs); }
.wm-segmented-segment { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0;
  height: 24px; padding: 0 10px 0 8px; border: none; border-radius: var(--radius-full); background: transparent; outline: none;
  color: var(--text-tertiary); font-family: inherit; font-size: var(--text-xs); font-weight: 700; line-height: 1; cursor: pointer; }
.wm-segmented-segment:hover { background: var(--surface-hover); color: var(--text-secondary); }
.wm-segmented-segment[aria-checked="true"] { color: var(--text-primary); }
.wm-segmented-segment[aria-checked="true"]:hover { background: transparent; }
.wm-segmented-segment[aria-checked="true"] svg { color: var(--text-link); }
.wm-segmented-segment:focus-visible { box-shadow: var(--focus-ring); }
`;

export default SegmentedControl;
