// The canvas — one continuous scroll, oldest at the top, today at the bottom.
// Opening restores to the bottom instantly (a restore, not an entrance; the
// cursor waits for nothing); a dated position scrolls that day into view, and a
// search result flies to the exact passage and lights it for a beat. Days present
// at first paint never animate — only ones that arrive later fade in from below.
// Today is the last block: writing happens inline in a growing textarea, mood and
// energy sit in thumb reach, and a mono note fades in after each write naming where
// the words actually are. When the account could not be read the canvas says so and
// draws nothing implying it is empty — a read that failed is not a first run.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePages } from './usePages.js';
import { DayMarker } from './DayMarker.jsx';
import { MoodDots } from './MoodDots.jsx';
import { EnergyBars } from './EnergyBars.jsx';
import { TalkButton } from './TalkButton.jsx';
import { PageEchoes } from './echoes/PageEchoes.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SETTLE_FRAMES = 6;   // how long a flight keeps correcting while the canvas grows under it

function wordCount(body) {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function Canvas({ focusDate = null, flyTo = null, echoes = null, onNeedSignIn = () => {} }) {
  const {
    today, history, loading, firstRun, readState,
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

  const dayElement = (date) => scrollRef.current?.querySelector(`[data-date="${date}"]`) ?? null;

  const scrollToDay = (date, block = 'start') => {
    const el = dayElement(date);
    if (el) el.scrollIntoView({ block });
  };

  // The echoes surfaces measure inside this canvas from outside it — the margin follows the scroll,
  // the ink footer counts what is below the fold — so the canvas hands them the scroller it already
  // holds and the lookup it already does. Nothing out there names `.journal-scroll` or `[data-date]`
  // any more: a rename here is a compile-time move, not a silent no-op three files away.
  const { holdCanvas } = echoes || {};
  useEffect(() => {
    if (!holdCanvas) return undefined;
    holdCanvas({ scroller: scrollRef.current, dayElement });
    return () => holdCanvas(null);
  }, [holdCanvas]);

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
  //
  // Loading months of history PREPENDS them above the target, which slides it out from under the
  // flight while it is in the air — so keep re-aiming for a few frames rather than firing once and
  // hoping the layout was finished. A hundred milliseconds of correction nobody can see, versus
  // landing at the bottom of the canvas roughly half the time.
  useEffect(() => {
    if (!flyTo || loading) return;
    let cancelled = false;
    const hasSpan = flyTo.lo != null;   // a search hit or an echo lights a span; a picked day just lands
    if (hasSpan) setHighlight(flyTo);
    (async () => {
      await extendTo(flyTo.day);
      if (cancelled) return;
      const aim = (frames) => {
        if (cancelled) return;
        scrollToDay(flyTo.day, 'center');
        if (frames > 0) requestAnimationFrame(() => aim(frames - 1));
      };
      requestAnimationFrame(() => {
        if (cancelled) return;
        aim(SETTLE_FRAMES);
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

  // The page you are standing on — its tab burns at full weight, every other page's has aged. The
  // edge of the canvas is a map of where you keep circling, and the map says where you are.
  const standingOn = focusDate || today;

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
        echoes={echoes}
        standing={day.date === standingOn}
      />,
    );
  }
  const todayMonth = today.slice(0, 7);
  if (todayMonth !== lastMonth) rendered.push(<MonthDivider key={`m-${todayMonth}`} iso={today} />);

  return (
    <div className="journal-scroll" ref={scrollRef}>
      <div className="journal-column">
        {rendered}

        {readState === 'failed' && (
          <p className="journal-unread">
            Couldn’t reach your journal just now — this is only what’s on this device.
            Anything you write is kept here until the rest can be read.
          </p>
        )}

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
          <div className="journal-page">
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
            {echoes && <PageEchoes echoes={echoes} day={today} standing={today === standingOn} />}
          </div>
          <div className="journal-controls">
            <MoodDots value={mood} onChange={toggleMood} />
            <EnergyBars value={energy} onChange={toggleEnergy} />
            <TalkButton
              onTranscript={(text) => setBody(body ? `${body.replace(/\s+$/, '')} ${text}` : text)}
              onNeedSignIn={onNeedSignIn}
            />
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

// The writing and its echoes share one positioning context — .journal-page — because an echo's tab
// hangs off the right edge of the paragraph it belongs to, and its ink opens directly under it.
// Nothing an echo draws is ever above the cursor or on the day chip.
function DayBlock({ day, born, highlight = null, echoes = null, standing = false }) {
  return (
    <article className={'journal-day' + (born ? ' journal-born' : '')} data-date={day.date}>
      <DayMarker date={day.date} mood={day.mood} energy={day.energy} written={day.written} wordCount={wordCount(day.body)} />
      <div className="journal-page">
        {day.written
          ? <div className="journal-prose">{highlight ? markSpan(day.body, highlight) : day.body}</div>
          : <div className="journal-gap">nothing written</div>}
        {echoes && <PageEchoes echoes={echoes} day={day.date} standing={standing} />}
      </div>
    </article>
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

// Mono, one line per write, fading in and easing back out — never a button, never a spinner, never
// a toast. Each state names where the words actually are, and none of them may flatter: a browser
// that refused the bytes while the network was down is holding nothing, and says so.
const SAVE_NOTES = {
  saved: 'saved',
  device: 'saved on this device',
  offline: 'offline · saved here',
  unsaved: 'not saved — no room on this device',
};

function SavedNote({ state, tick }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (tick === 0) return undefined;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [tick]);
  return <span className={'journal-saved' + (visible ? ' is-on' : '')}> · {SAVE_NOTES[state] ?? 'saved'}</span>;
}
