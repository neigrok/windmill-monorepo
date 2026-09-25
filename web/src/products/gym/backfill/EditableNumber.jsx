import React, { useState } from 'react';
import { steppedValue, typedValue, valueLabel } from './draft.js';

// A number edited where it is drawn. Enter commits and moves down, Tab walks load → reps → the next
// row's load, and ↑/↓ step the load by the plate step and the reps by one. Text that is not a number
// is dropped on the way out and the value stands. A number typed, or confirmed with Enter, is
// committed even when it equals the one drawn: choosing it is the point.
export function EditableNumber({ value, field, label, stepKg = null, lift = null, onFocus, onCommit }) {
  // `{ typed }` while focused: the text the lifter has typed, or null while the cell still reads the
  // draft — which it keeps reading, so a value carried in while it holds the focus is the one shown.
  const [editing, setEditing] = useState(null);
  const raw = value == null ? '' : String(value);
  const shown = editing ? editing.typed ?? raw : valueLabel(value, field);

  const commit = (text) => {
    const typed = typedValue(text, field);
    if (typed !== undefined) onCommit(typed);
  };

  const keyed = (event) => {
    const input = event.currentTarget;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const typed = editing?.typed == null ? value : typedValue(editing.typed, field);
      const next = steppedValue(typed === undefined ? value : typed, field, event.key === 'ArrowUp' ? 1 : -1, stepKg);
      setEditing({ typed: null });
      onCommit(next);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (editing?.typed == null) commit(raw);
      const below = rowAfter(input)?.querySelector(`[data-field="${field}"]`);
      if (below) below.focus();
      else input.blur();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && field === 'reps') {
      const next = rowAfter(input)?.querySelector('[data-field="load"]');
      if (!next) return;
      event.preventDefault();
      next.focus();
    }
  };

  const classes = ['gym-num', shown === '' && 'is-empty', lift && `is-lifted-${lift.stamp % 2}`].filter(Boolean).join(' ');
  return (
    <input
      className={classes}
      style={{ '--gym-number-chars': Math.max(2, shown.length), ...(lift ? { '--lift-delay': `${lift.delay}ms` } : {}) }}
      data-field={field}
      inputMode={field === 'load' ? 'decimal' : 'numeric'}
      aria-label={label}
      value={shown}
      onFocus={(event) => {
        const input = event.currentTarget;
        setEditing({ typed: null });
        onFocus?.();
        window.requestAnimationFrame?.(() => input.select());
      }}
      onChange={(event) => setEditing({ typed: event.target.value })}
      onBlur={() => {
        if (editing?.typed != null) commit(editing.typed);
        setEditing(null);
      }}
      onKeyDown={keyed}
    />
  );
}

function rowAfter(input) {
  const rows = [...input.closest('.gym-past-form').querySelectorAll('.gym-past-set')];
  return rows[rows.indexOf(input.closest('.gym-past-set')) + 1] ?? null;
}
