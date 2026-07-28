// The canvas — one continuous scroll, oldest at the top, today at the bottom.
// Opening restores to the bottom instantly (a restore, not an entrance; the
// cursor waits for nothing); a dated position scrolls that day into view.
// Days present at first paint never animate — only ones that arrive later fade
// in from below. Today is the last block: writing happens inline in a growing
// textarea, mood and energy sit in thumb reach, and a mono "saved" fades in
// after typing stops.

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { usePages } from './usePages.js';
import { DayMarker } from './DayMarker.jsx';
import { MoodDots } from './MoodDots.jsx';
import { EnergyBars } from './EnergyBars.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function wordCount(body) {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function Canvas({ focusDate = null }) {
  const {
    today, history, loading, firstRun,
    body, mood, energy, saveState, saveTick,
    setBody, toggleMood, toggleEnergy,
  } = usePages();

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const restoredRef = useRef(false);
  const bornSet = useRef(null); // the dates present at first paint — these never animate

  if (!loading && !bornSet.current) {
    bornSet.current = new Set(history.map((day) => day.date));
    bornSet.current.add(today);
  }
  const isBorn = (date) => (bornSet.current ? !bornSet.current.has(date) : false);

  const scrollToDay = (date) => {
    const el = scrollRef.current?.querySelector(`[data-date="${date}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  };

  // Grow the composer to its content. Runs before the restore below, so the
  // bottom is measured at the field's full height.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  // Restore the position once the window has loaded: a dated hash lands on that
  // day; otherwise the bottom, with the cursor placed in today. No animation.
  useLayoutEffect(() => {
    if (loading || restoredRef.current) return;
    restoredRef.current = true;
    if (focusDate) { scrollToDay(focusDate); return; }
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    textareaRef.current?.focus({ preventScroll: true });
  }, [loading, focusDate]);

  // A dated hash that changes after mount (navigating to another day) re-scrolls.
  useEffect(() => {
    if (loading || !restoredRef.current || !focusDate) return;
    scrollToDay(focusDate);
  }, [focusDate, loading]);

  const rendered = [];
  let lastMonth = null;
  for (const day of history) {
    const month = day.date.slice(0, 7);
    if (month !== lastMonth) {
      rendered.push(<MonthDivider key={`m-${month}`} iso={day.date} />);
      lastMonth = month;
    }
    rendered.push(<DayBlock key={day.date} day={day} born={isBorn(day.date)} />);
  }
  const todayMonth = today.slice(0, 7);
  if (todayMonth !== lastMonth) rendered.push(<MonthDivider key={`m-${todayMonth}`} iso={today} />);

  return (
    <div className="journal-scroll" ref={scrollRef}>
      <div className="journal-column">
        {rendered}

        <article className="journal-day journal-today" data-date={today}>
          <DayMarker
            date={today}
            mood={mood}
            energy={energy}
            written
            wordCount={wordCount(body)}
            isToday
            trailing={<SavedNote state={saveState} tick={saveTick} />}
          />
          <textarea
            ref={textareaRef}
            className="journal-input"
            rows={1}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={firstRun ? 'Start anywhere. Nothing here is graded.' : ''}
            aria-label="Write today"
            spellCheck
          />
          <div className="journal-controls">
            <MoodDots value={mood} onChange={toggleMood} />
            <EnergyBars value={energy} onChange={toggleEnergy} />
          </div>
          {firstRun && <p className="journal-privacy">Nobody sees this but you.</p>}
        </article>
      </div>
    </div>
  );
}

function MonthDivider({ iso }) {
  const [year, month] = iso.split('-').map(Number);
  return <div className="journal-month">{MONTHS[month - 1]} {year}</div>;
}

function DayBlock({ day, born }) {
  return (
    <article className={'journal-day' + (born ? ' journal-born' : '')} data-date={day.date}>
      <DayMarker date={day.date} mood={day.mood} energy={day.energy} written={day.written} wordCount={wordCount(day.body)} />
      {day.written
        ? <div className="journal-prose">{day.body}</div>
        : <div className="journal-gap">nothing written</div>}
    </article>
  );
}

// Mono "saved" (or "offline · saved here") that fades in on each write and eases
// back out — never a button, never a spinner, never a toast.
function SavedNote({ state, tick }) {
  const [visible, setVisible] = React.useState(false);
  useEffect(() => {
    if (tick === 0) return undefined;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [tick]);
  const text = state === 'offline' ? 'offline · saved here' : 'saved';
  return <span className={'journal-saved' + (visible ? ' is-on' : '')}> · {text}</span>;
}
