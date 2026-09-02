// A mono date, a mood pip and an energy tick, sticky by CSS. The pip and tick are read-only, and today
// draws neither: today's values live in the strip under the field. Both glyphs read the five/three bands
// of scaleBands.js, never the raw 0–10, and both say "answered" even when the answer was zero.

import React from 'react';
import { energyBars, moodBand } from './scaleBands.js';
import { stampWeekday } from './echoes/echoDates.js';

// `addressed` is the echo margin describing THIS page: the date lifts from --journal-ink-dim to lamp
// and nothing else moves. No weight change and no box of its own — a sticky row that reflowed would
// change the canvas's geometry, which journal.md:56 forbids at any scroll speed. The pip and the tick
// keep their own colours: those encode data, and lamp would overwrite meaning.
export function DayMarker({
  date, mood = null, energy = null, wordCount = 0, isToday = false, trailing = null, addressed = false,
}) {
  return (
    <header className={'journal-marker' + (addressed ? ' is-addressed' : '')}>
      <span className="journal-meta">
        {stampWeekday(date)}
        {wordCount > 0 && ` · ${wordCount} ${wordCount === 1 ? 'WORD' : 'WORDS'}`}
        {trailing}
      </span>
      {!isToday && (
        <span className="journal-glyphs" aria-hidden="true">
          <MoodPip mood={mood} />
          <EnergyTick energy={energy} />
        </span>
      )}
    </header>
  );
}

// Every day the canvas draws was written, so there is no hollow pip here — only an unanswered one.
function MoodPip({ mood }) {
  const band = moodBand(mood);
  if (band == null) return <span className="journal-pip" />;
  return <span className="journal-pip" style={{ background: `var(--mood-${band})` }} />;
}

// The baseline is the only thing telling "energy 0–3, recorded" from "energy never answered".
function EnergyTick({ energy }) {
  const bars = energyBars(energy);
  return (
    <span className={'journal-tick' + (energy != null ? ' is-set' : '')}>
      {[1, 2, 3].map((step) => (
        <span key={step} className={'journal-tick-bar' + (step <= bars ? ' is-on' : '')} />
      ))}
    </span>
  );
}
