// The keypad sheet — the same twelve keys for both numbers, with the comma and the ± stood down
// in reps mode rather than removed, so the geometry a chalked thumb learned never moves.
//
// The guarantee this component exists to keep: an invalid entry never silently reverts and never
// silently dismisses. Return and a tap outside commit exactly like Set — but only when the entry is
// valid; when it is not they leave the sheet up with the message that names the problem. The lifter
// leaves by deciding: Set writes the number, Cancel keeps the one they had.

import React, { useEffect, useState } from 'react';
import { backspace, echoOf, isKeyLive, KEYS, openPad, parseEntry, pressKey } from './entry.js';

export function Keypad({ mode, current, editing = false, onCommit, onCancel }) {
  const [pad, setPad] = useState(() => openPad(current));
  const entry = parseEntry(pad, mode, current);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if (event.key === 'Enter') {
        if (entry.valid) onCommit(entry.value);
        return;
      }
      if (event.key === 'Backspace') {
        setPad(backspace);
        return;
      }
      if (/^[0-9]$/.test(event.key)) setPad((held) => pressKey(held, event.key, mode));
      if (event.key === ',' || event.key === '.') setPad((held) => pressKey(held, ',', mode));
      if (event.key === '-') setPad((held) => pressKey(held, '±', mode));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry.valid, entry.value, mode, onCommit, onCancel]);

  return (
    <div
      className="gym-sheet-catch"
      role="presentation"
      onClick={() => { if (entry.valid) onCommit(entry.value); }}
    >
      <div className="gym-keypad" role="dialog" aria-label={mode === 'weight' ? 'Weight' : 'Reps'} onClick={(event) => event.stopPropagation()}>
        <p className="gym-keypad-title">
          {mode === 'weight' ? 'Weight' : 'Reps'}
          {editing && '  ·  editing a logged set'}
        </p>
        <p className={entry.valid ? 'gym-keypad-echo' : 'gym-keypad-echo is-invalid'}>{echoOf(pad)}</p>
        <p className={entry.valid ? 'gym-keypad-message' : 'gym-keypad-message is-invalid'}>{entry.message}</p>
        <div className="gym-keypad-keys">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={isKeyLive(key, mode) ? 'gym-key' : 'gym-key is-inert'}
              onClick={() => setPad((held) => pressKey(held, key, mode))}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="gym-keypad-actions">
          <button type="button" className="gym-keypad-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="gym-keypad-back" onClick={() => setPad(backspace)} aria-label="Backspace">⌫</button>
          <button
            type="button"
            className={entry.valid ? 'gym-keypad-set' : 'gym-keypad-set is-inert'}
            onClick={() => { if (entry.valid) onCommit(entry.value); }}
          >
            Set
          </button>
        </div>
      </div>
    </div>
  );
}
