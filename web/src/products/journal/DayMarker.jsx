// The day marker — a mono date, a mood pip, and an energy tick. Sticky by CSS
// (position:sticky, never scripted): while a day is under you it pins to the top
// edge. The date/count/saved are all mono so the eye skips them; the pip and tick
// are this day's glance summary — read-only, and how the two scales are learned by
// looking up. TODAY DRAWS NEITHER: today's values live in the strip under the field,
// where they can still be changed, and one value drawn twice reads as two things.

import React from 'react';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function stamp(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${weekday} ${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

export function DayMarker({ date, mood = null, energy = null, wordCount = 0, isToday = false, trailing = null }) {
  return (
    <header className="journal-marker">
      <span className="journal-meta">
        {stamp(date)}
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

// Every day the canvas draws was written — an unwritten day is not drawn at all — so there is no
// hollow pip here. The zoom's year grid is where a day nobody wrote is still a cell.
function MoodPip({ mood }) {
  if (mood) return <span className="journal-pip" style={{ background: `var(--mood-${mood})` }} />;
  return <span className="journal-pip" />;
}

function EnergyTick({ energy }) {
  return (
    <span className="journal-tick">
      {[1, 2, 3].map((step) => (
        <span key={step} className={'journal-tick-bar' + (energy && step <= energy ? ' is-on' : '')} />
      ))}
    </span>
  );
}
