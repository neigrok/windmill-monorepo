// The canvas — one continuous scroll, oldest at the top, today at the bottom.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePages } from './usePages.js';
import { DayMarker } from './DayMarker.jsx';
import { ScaleStrip } from './ScaleStrip.jsx';
import { PageEchoes } from './echoes/PageEchoes.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SETTLE_FRAMES = 6;   // how long a flight keeps correcting while the canvas grows under it

function wordCount(body) {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

const WHY_KEY = 'windmill:journal-scales-why';
const WHY_LINE = 'Mood is what you see when you zoom out to the year.';
const WHY_READ_MS = 2500;   // on screen this long before the one showing counts as spent

function whySaid() {
  try {
    return localStorage.getItem(WHY_KEY) === 'said';
  } catch {
    return false;   // no storage — the one line may be said twice rather than never
  }
}

export function Canvas({ focusDate = null, flyTo = null, echoes = null, holdWriter = null }) {
  const {
    today, history, loading, firstRun, readState, reach,
    body, mood, energy, saveState, saveTick,
    setBody, setMood, setEnergy, extendTo, reachBack,
  } = usePages();

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const columnRef = useRef(null);
  const openingRef = useRef(true);   // the canvas is still opening — the position is ours to take
  const placedRef = useRef(0);       // where we last put it, so a scroll that is not ours is visible
  const focusedRef = useRef(false);
  const bornSet = useRef(null); // the dates present at first paint — these never animate
  const anchorRef = useRef(null); // distance from the scroll bottom, held across a reach back
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

  // Echoes measure inside this canvas from outside it: it hands them the scroller and the day lookup.
  const { holdCanvas } = echoes || {};
  useEffect(() => {
    if (!holdCanvas) return undefined;
    holdCanvas({ scroller: scrollRef.current, dayElement });
    return () => holdCanvas(null);
  }, [holdCanvas]);

  // The rail gets one thing: a write into today. Nothing out there touches the store or the field.
  useEffect(() => {
    if (!holdWriter) return undefined;
    holdWriter((text) => {
      const written = bodyRef.current;
      setBody(written ? `${written.replace(/\s+$/, '')} ${text}` : text);
    });
    return () => holdWriter(null);
  }, [holdWriter, setBody]);

  // Said once ever, on the first save, and spent by being read rather than by being rendered.
  const [whyDue] = useState(() => !whySaid());
  const why = whyDue && saveTick > 0 && mood == null ? WHY_LINE : null;
  useEffect(() => {
    if (!why) return undefined;
    const timer = setTimeout(() => {
      try { localStorage.setItem(WHY_KEY, 'said'); } catch { /* no storage — it may say itself twice */ }
    }, WHY_READ_MS);
    return () => clearTimeout(timer);
  }, [why]);

  // Grow the composer to its content before the restore below measures the bottom.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  // Taken in a layout effect before paint, and again on every resize: a cold load lays out several times
  // and a position taken while the scroller has no overflow does nothing. Ends when the writer scrolls.
  const takePosition = () => {
    const scroller = scrollRef.current;
    if (!openingRef.current || !scroller) return;
    const landed = focusDate ? dayElement(focusDate) : null;
    if (landed) landed.scrollIntoView({ block: 'start' });
    else scroller.scrollTop = scroller.scrollHeight;
    placedRef.current = scroller.scrollTop;
  };
  const takeRef = useRef(takePosition);
  takeRef.current = takePosition;

  // A position asked for by the URL re-opens the canvas on it, even if the writer had scrolled.
  useLayoutEffect(() => { openingRef.current = true; }, [focusDate]);

  useLayoutEffect(() => {
    takePosition();
    if (loading || focusDate || focusedRef.current) return;
    focusedRef.current = true;
    textareaRef.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => takeRef.current());
    observer?.observe(scroller);
    if (columnRef.current) observer?.observe(columnRef.current);
    // The scroll that is not ours ends the opening: ours always lands where `placedRef` says.
    const onScroll = () => {
      if (openingRef.current && Math.abs(scroller.scrollTop - placedRef.current) > 8) {
        openingRef.current = false;
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  // A reach back prepends above the viewport, so hold the distance from the scroller's bottom — the one
  // distance a prepend cannot change — and put it back once the read settles.
  const startReachBack = () => {
    openingRef.current = false;   // they went looking — the canvas stops taking its own position
    const scroller = scrollRef.current;
    anchorRef.current = scroller ? scroller.scrollHeight - scroller.scrollTop : null;
    reachBack();
  };

  useLayoutEffect(() => {
    if (anchorRef.current == null || reach === 'loading') return;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight - anchorRef.current;
    anchorRef.current = null;
  }, [reach, history.length]);

  // A hit older than the rendered window is loaded first, then scrolled; a hit on today lands in the
  // composer with its span selected. Prepends keep moving the target, so the flight re-aims for a few
  // frames instead of firing once.
  useEffect(() => {
    if (!flyTo || loading) return;
    openingRef.current = false;   // a flight is a position the writer asked for
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

  // Only an account that answered has an edge to reach past, and an empty one shows the first run.
  const showFloor = readState === 'ready' && !(history.length === 0 && reach === 'end');

  return (
    <div className="journal-scroll" ref={scrollRef}>
      <div className="journal-column" ref={columnRef}>
        {showFloor && <CanvasFloor reach={reach} onReach={startReachBack} />}
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
          <ScaleStrip mood={mood} energy={energy} onMood={setMood} onEnergy={setEnergy} why={why} />
          {firstRun && <p className="journal-privacy">Nobody sees this but you.</p>}
        </article>
      </div>
    </div>
  );
}

// One window deeper per press. A failed read is never "the beginning": it offers the step again.
function CanvasFloor({ reach, onReach }) {
  if (reach === 'end') return <p className="journal-floor-end">That’s the start of your journal.</p>;
  if (reach === 'failed') {
    return (
      <p className="journal-floor-failed">
        Couldn’t read further back — this is what’s loaded so far, not where you started.
        <button type="button" className="journal-floor-retry" onClick={onReach}>Try again</button>
      </p>
    );
  }
  // aria-disabled, not disabled: a real `disabled` drops focus to the body mid-press.
  return (
    <button
      type="button"
      className="journal-floor-more"
      onClick={onReach}
      aria-disabled={reach === 'loading'}
      aria-busy={reach === 'loading'}
    >
      {reach === 'loading' ? 'Reading further back…' : 'Read further back'}
    </button>
  );
}

function MonthDivider({ iso }) {
  const [year, month] = iso.split('-').map(Number);
  return <div className="journal-month">{MONTHS[month - 1]} {year}</div>;
}

// The writing and its echoes share one positioning context, .journal-page.
function DayBlock({ day, born, highlight = null, echoes = null, standing = false }) {
  return (
    <article className={'journal-day' + (born ? ' journal-born' : '')} data-date={day.date}>
      <DayMarker date={day.date} mood={day.mood} energy={day.energy} wordCount={wordCount(day.body)} />
      <div className="journal-page">
        <div className="journal-prose">{highlight ? markSpan(day.body, highlight) : day.body}</div>
        {echoes && <PageEchoes echoes={echoes} day={day.date} standing={standing} />}
      </div>
    </article>
  );
}

// Wrap the matched [lo, hi) char range in a mark.
function markSpan(body, { lo, hi }) {
  return (
    <>
      {body.slice(0, lo)}
      <mark className="journal-highlight">{body.slice(lo, hi)}</mark>
      {body.slice(hi)}
    </>
  );
}

// One line per write, naming where the words actually are.
const SAVE_NOTES = {
  saved: 'saved',
  device: 'saved on this device',
  offline: 'offline · saved here',
  unsaved: 'not saved — no room on this device',
  // Settled on any refusal the server will repeat, not only on a page that is too long.
  refused: 'kept here · not synced',
};

function SavedNote({ state, tick }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (tick === 0) return undefined;
    setVisible(true);
    // `refused` is the one state nothing retries, so it stays until the next save changes the answer.
    if (state === 'refused') return undefined;
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [tick, state]);
  return <span className={'journal-saved' + (visible ? ' is-on' : '')}> · {SAVE_NOTES[state] ?? 'saved'}</span>;
}
