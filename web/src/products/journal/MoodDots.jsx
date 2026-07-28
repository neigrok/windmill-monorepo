// The mood scale — five dots, one hue in five steps (dim → the lamp). Tapping a
// step fills the ramp up to it and re-tints the lit dots to that step's hue
// (180ms, in CSS); tapping the current step again clears it. Optional always.

import React from 'react';

const STEPS = [1, 2, 3, 4, 5];

export function MoodDots({ value = null, onChange }) {
  return (
    <div className="journal-mood" role="group" aria-label="Mood">
      {STEPS.map((step) => {
        const lit = value != null && step <= value;
        return (
          <button
            key={step}
            type="button"
            className={'journal-mood-dot' + (lit ? ' is-on' : '')}
            style={lit ? { '--dot-color': `var(--mood-${value})` } : undefined}
            aria-pressed={value === step}
            aria-label={`Mood ${step} of 5`}
            onClick={() => onChange(step)}
          />
        );
      })}
    </div>
  );
}
