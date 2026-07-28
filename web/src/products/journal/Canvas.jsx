// The canvas — one continuous scroll, oldest at the top, today at the bottom.
// Opening restores to the bottom instantly (a restore, not an entrance; the
// cursor waits for nothing); a dated position scrolls that day into view, and a
// search result flies to the exact passage and lights it for a beat. Days present
// at first paint never animate — only ones that arrive later fade in from below.
// Today is the last block: writing happens inline in a growing textarea, mood and
// energy sit in thumb reach, and a mono "saved" fades in after typing stops.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export function Canvas({ focusDate = null, flyTo = null, echoDays = new Map(), onOpenEcho = () => {} }) {
  const {
    today, history, loading, firstRun,
    body, mood, energy, saveState, saveTick,
    setBody, toggleMood, toggleEnergy, extendTo,
  } = usePages();

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const restoredRef = useRef(false);
  const bornSet = useRef(null); // the dates present at first paint — these never animate
  const [highlight, setHighlight] = useState(null); // { day, lo, hi } — a search hit, lit for a beat

  if (!loading && !bornSet.current) {
    bornSet.current = new Set(history.map((day) => day.date));
    bornSet.current.add(today);
  }
  const isBorn = (date) => (bornSet.current ? !bornSet.current.has(date) : false);

  const scrollToDay = (date, block = 'start') => {
    const el = scrollRef.current?.querySelector(`[data-date="${date}"]`);
    if (el) el.scrollIntoView({ block });
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

  // Fly to a search hit: bring its day to centre, neighbours intact, and light the
  // matched passage for a beat — a position, never a detail view. A hit older than the
  // rendered window is loaded first (extendTo), then scrolled once it's in the DOM; a hit
  // on today lands in the composer, its span selected, since today is a field not prose.
  useEffect(() => {
    if (!flyTo || loading) return;
    let cancelled = false;
    const hasSpan = flyTo.lo != null;   // a search hit or an echo lights a span; a picked day just lands
    if (hasSpan) setHighlight(flyTo);
    (async () => {
      await extendTo(flyTo.day);
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        scrollToDay(flyTo.day, 'center');
        if (hasSpan && flyTo.day === today && textareaRef.current) {
          const field = textareaRef.current;
          field.focus({ preventScroll: true });
          field.setSelectionRange(flyTo.lo, flyTo.hi);
        }
      });
    })();
    const fade = hasSpan ? setTimeout(() => setHighlight(null), 2600) : null;
    return () => { cancelled = true; if (fade) clearTimeout(fade); };
  }, [flyTo, loading, extendTo, today]);

  const rendered = [];
  let lastMonth = null;
  for (const day of history) {
    const month = day.date.slice(0, 7);
    if (month !== lastMonth) {
      rendered.push(<MonthDivider key={`m-${month}`} iso={day.date} />);
      lastMonth = month;
    }
    const dayHighlight = highlight && highlight.day === day.date ? highlight : null;
    rendered.push(
      <DayBlock
        key={day.date}
        day={day}
        born={isBorn(day.date)}
        highlight={dayHighlight}
        hasEcho={echoDays.has(day.date)}
        onOpenEcho={onOpenEcho}
      />,
    );
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

function DayBlock({ day, born, highlight = null, hasEcho = false, onOpenEcho }) {
  const echoMark = hasEcho ? <EchoMark onClick={() => onOpenEcho(day.date)} /> : null;
  return (
    <article className={'journal-day' + (born ? ' journal-born' : '')} data-date={day.date}>
      <DayMarker date={day.date} mood={day.mood} energy={day.energy} written={day.written} wordCount={wordCount(day.body)} trailing={echoMark} />
      {day.written
        ? <div className="journal-prose">{highlight ? markSpan(day.body, highlight) : day.body}</div>
        : <div className="journal-gap">nothing written</div>}
    </article>
  );
}

// The echo's whole presence on the canvas: a small lamp glyph on the day that resonated. Never a
// count, never a badge with a number — a light left on. Tapping it opens the echo (JournalApp).
function EchoMark({ onClick }) {
  return (
    <button type="button" className="journal-echo-mark" onClick={onClick} aria-label="An echo — you wrote something like this before">
      <span className="journal-echo-glyph" aria-hidden="true" />
      echo
    </button>
  );
}

// Wrap the matched [lo, hi) char range in a soft lamp-tinted mark — the passage a search flew to.
function markSpan(body, { lo, hi }) {
  return (
    <>
      {body.slice(0, lo)}
      <mark className="journal-highlight">{body.slice(lo, hi)}</mark>
      {body.slice(hi)}
    </>
  );
}

// Mono "saved" (or "offline · saved here") that fades in on each write and eases
// back out — never a button, never a spinner, never a toast.
function SavedNote({ state, tick }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (tick === 0) return undefined;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [tick]);
  const text = state === 'offline' ? 'offline · saved here' : 'saved';
  return <span className={'journal-saved' + (visible ? ' is-on' : '')}> · {text}</span>;
}
