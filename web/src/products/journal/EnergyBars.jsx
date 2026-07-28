// The energy scale — three bars of rising height. Tapping a step fills the bars
// up to it (180ms, in CSS); tapping the current step again clears it. Optional
// always. Olive, the growth accent — never the mood hue, never red.

import React from 'react';

const STEPS = [1, 2, 3];

export function EnergyBars({ value = null, onChange }) {
  return (
    <div className="journal-energy" role="group" aria-label="Energy">
      {STEPS.map((step) => {
        const lit = value != null && step <= value;
        return (
          <button
            key={step}
            type="button"
            className={`journal-energy-bar level-${step}` + (lit ? ' is-on' : '')}
            aria-pressed={value === step}
            aria-label={`Energy ${step} of 3`}
            onClick={() => onChange(step)}
          />
        );
      })}
    </div>
  );
}
