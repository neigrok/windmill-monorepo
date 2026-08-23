// The two taps — how the day felt, and how much was in the tank — as one control. The mono word at the
// right names the value last touched; unset it reads `felt`. Both scales are optional, and tapping the
// step you are on clears it (pageStore holds that rule).

import React, { useEffect, useState } from 'react';

const MOOD_STEPS = [1, 2, 3, 4, 5];
const ENERGY_STEPS = [1, 2, 3];

const MOOD_WORDS = ['felt', 'hard', 'low', 'flat', 'good', 'clear'];
const ENERGY_WORDS = [null, 'low', 'steady', 'high'];

const ENERGY_BEAT = 1200;   // how long the word stays on energy after an energy tap

export function ScaleStrip({ mood = null, energy = null, onMood, onEnergy, why = null }) {
  const [energyTaps, setEnergyTaps] = useState(0);   // taps since the word last went back to mood

  useEffect(() => {
    if (!energyTaps) return undefined;
    const timer = setTimeout(() => setEnergyTaps(0), ENERGY_BEAT);
    return () => clearTimeout(timer);
  }, [energyTaps]);

  const onEnergyWord = energyTaps > 0 && energy != null;
  const word = onEnergyWord ? ENERGY_WORDS[energy] : MOOD_WORDS[mood ?? 0];
  const set = onEnergyWord || mood != null;

  return (
    <>
      <div className="journal-controls">
        <div className="journal-mood" role="group" aria-label="Mood">
          {MOOD_STEPS.map((step) => {
            const lit = mood != null && step <= mood;
            const here = mood === step;
            return (
              <button
                key={step}
                type="button"
                className={'journal-mood-dot' + (lit ? ' is-on' : '')}
                style={lit ? { '--dot-color': `var(--mood-${mood})` } : undefined}
                aria-pressed={here}
                aria-label={here ? `Mood ${step} of 5 — press again to clear` : `Mood ${step} of 5`}
                title={here ? `${MOOD_WORDS[step]} — press again to clear` : MOOD_WORDS[step]}
                onClick={() => onMood(step)}
              />
            );
          })}
        </div>
        <span className="journal-scale-rule" aria-hidden="true" />
        <div className="journal-energy" role="group" aria-label="Energy">
          {ENERGY_STEPS.map((step) => {
            const lit = energy != null && step <= energy;
            const here = energy === step;
            return (
              <button
                key={step}
                type="button"
                className={`journal-energy-bar level-${step}` + (lit ? ' is-on' : '')}
                aria-pressed={here}
                aria-label={here ? `Energy ${step} of 3 — press again to clear` : `Energy ${step} of 3`}
                title={here ? `${ENERGY_WORDS[step]} — press again to clear` : ENERGY_WORDS[step]}
                onClick={() => { onEnergy(step); setEnergyTaps((taps) => taps + 1); }}
              />
            );
          })}
        </div>
        <span className={'journal-scale-word' + (set ? ' is-set' : '')} aria-live="polite">{word}</span>
      </div>
      {why && <p className="journal-scale-why">{why}</p>}
    </>
  );
}
