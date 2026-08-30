// The canvas — one continuous scroll, oldest at the top, today at the bottom.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePages } from './usePages.js';
import { DayMarker } from './DayMarker.jsx';
import { ScaleStrip } from './ScaleStrip.jsx';
import { PageEchoes } from './echoes/PageEchoes.jsx';
import { writerTookTheScroll } from './openingGesture.js';
import { proseRuns } from './links.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SETTLE_FRAMES = 6;   // how long a flight keeps correcting while the canvas grows under it

// Every way a writer can take the scroll off the opening canvas. A scroll event is not one of them.
const GESTURES = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

function wordCount(body) {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

const WHY_KEY = 'windmill:journal-scales-why';
const WHY_LINE = 'Mood is what you see when you zoom out to the year. Zero is a real answer; leaving it blank is too.';
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
  const focusedRef = useRef(false);
  const widthRef = useRef(0);        // the composer's last measured width, so a re-wrap is visible
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

  // Grow the composer to its content before the position below measures the bottom — on a change of
  // WIDTH as well as of text. The echo gutter opening at 1240px re-wraps every line the field holds,
  // and lines a field is too short to show are lines the foot is measured short by.
  const sizeToContent = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    widthRef.current = ta.clientWidth;
  };
  useLayoutEffect(sizeToContent, [body]);

  // Taken in a layout effect before paint, and again on every resize: a cold load lays out several times
  // and a position taken while the scroller has no overflow does nothing. Ends when the writer makes a
  // gesture — see openingGesture.js for why a scroll event cannot be the one that ends it.
  const takePosition = () => {
    const scroller = scrollRef.current;
    if (!openingRef.current || !scroller) return;
    const landed = focusDate ? dayElement(focusDate) : null;
    if (landed) landed.scrollIntoView({ block: 'start' });
    else scroller.scrollTop = scroller.scrollHeight;
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
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const ta = textareaRef.current;
      if (ta && ta.clientWidth !== widthRef.current) sizeToContent();
      takeRef.current();
    });
    // The scroller's own box never changes as days stream in; the column's and the composer's do.
    observer?.observe(scroller);
    if (columnRef.current) observer?.observe(columnRef.current);
    if (textareaRef.current) observer?.observe(textareaRef.current);
    const taken = (event) => {
      if (!openingRef.current) return;
      const insideField = textareaRef.current?.contains(event.target) === true;
      if (writerTookTheScroll({ type: event.type, key: event.key ?? null, insideField })) {
        openingRef.current = false;
      }
    };
    for (const type of GESTURES) scroller.addEventListener(type, taken, { passive: true });
    return () => {
      observer?.disconnect();
      for (const type of GESTURES) scroller.removeEventListener(type, taken);
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
            <div className="journal-composer">
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
              {/* The field's own glyphs are transparent; these are the ones you read. Same font, same
                  box, same wrapping — so the paint sits exactly on the text the caret is moving through. */}
              <div className="journal-input-paint" aria-hidden="true"><Prose text={body} inert /></div>
            </div>
            {echoes && <PageEchoes echoes={echoes} day={today} standing={today === standingOn} />}
          </div>
          <ScaleStrip day={today} mood={mood} energy={energy} onMood={setMood} onEnergy={setEnergy} why={why} />
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
        <div className="journal-prose"><Prose text={day.body} highlight={highlight} /></div>
        {echoes && <PageEchoes echoes={echoes} day={day.date} standing={standing} />}
      </div>
    </article>
  );
}

// The writing, with its links live and the flown-to span lit. Both are ranges over the same text, so
// one pass of runs settles them together rather than one wrapping the other.
function Prose({ text, highlight = null, inert = false }) {
  return proseRuns(text, { highlight }).map((run) => {
    const painted = run.marked ? <mark className="journal-highlight">{run.text}</mark> : run.text;
    if (!run.href) return <React.Fragment key={run.lo}>{painted}</React.Fragment>;
    // Under the composer the anchor is paint, not a target: the caret has to be able to land in a URL
    // to fix a typo in it, and a click that opened a tab instead would make that impossible.
    if (inert) return <span key={run.lo} className="journal-link">{painted}</span>;
    return (
      <a key={run.lo} className="journal-link" href={run.href} target="_blank" rel="noreferrer noopener nofollow">
        {painted}
      </a>
    );
  });
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
