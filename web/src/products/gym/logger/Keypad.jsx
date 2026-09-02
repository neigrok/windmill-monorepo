import React, { useEffect, useState } from 'react';
import { backspace, echoOf, isKeyLive, KEYS, openPad, parseEntry, pressKey } from './entry.js';

// C21: the ten digits and the decimal separator speak themselves under a screen reader. The two
// glyphs do not, so each carries the name that is read in its place — ± in the bytes the routine
// target's own sign control carries, so one control met on two screens is called one thing.
const DELETE = '⌫';
const SPOKEN = { '±': 'Flip the sign — band-assisted', [DELETE]: 'Delete' };

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
      onClick={onCancel}
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
              aria-label={SPOKEN[key]}
              onClick={() => setPad((held) => pressKey(held, key, mode))}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="gym-keypad-actions">
          <button type="button" className="gym-keypad-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="gym-keypad-back" onClick={() => setPad(backspace)} aria-label={SPOKEN[DELETE]}>{DELETE}</button>
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
