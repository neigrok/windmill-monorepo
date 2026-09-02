// Everything an echo draws inside a page: the tab on the edge, the ink it opens, the once-ever card.
// The tab is the same with or without One; what differs is one tap in.

import React, { useEffect, useRef, useState } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';
import { KINDLE_MS, resumedOnMount } from './arrival.js';

// Nothing is dimmed past legibility, so the ladder stops at half.
const LADDER = [1, 0.82, 0.64, 0.5];
// Half the kindle: the glyph swaps at the ramp's midpoint, under the numeral's own cross-fade, so the
// digit is never seen changing at full weight.
const SWAP_MS = KINDLE_MS / 2;

// What is behind the tab, said at EVERY width. It is the only place a reader who cannot see the face
// learns how much a page holds, and it is also the whole of what an arrival announces: one
// vocabulary, not two, and never a word that would make the light a notification.
export function passagesBehind(count) {
  return `${count} ${count === 1 ? 'passage' : 'passages'} you wrote before`;
}

// What the tab IS, given whether the margin has room (`marginOpen`, decided once in useEchoes.js).
// With the margin open the ink has nowhere to appear — the panel IS the page's ink and it is already
// there — so the tab is not a disclosure at all: it is the control that holds the panel on this page,
// and it never claims to open or close anything. `held` is this page holding the panel, `addressed`
// is the panel on this page by the scroll's own choice, `aged` is neither. Narrower than that, the
// panel does not exist and the tab is the disclosure it looks like, ✕ and `aria-expanded` included.
//
// Pure and exported because a control that announces a state it does not have is otherwise only
// visible by opening a browser at two widths.
export function edgeTabProps({ marginOpen, open, standing, held, addressed, count }) {
  // The act the tab performs is the second half of the sentence, not a replacement for the first.
  const behind = passagesBehind(count);
  if (marginOpen) {
    if (held) return { state: 'held', face: 'count', label: `${behind} — follow the scroll again` };
    return {
      state: addressed ? 'addressed' : 'aged',
      face: 'count',
      label: `${behind} — hold panel on this page`,
    };
  }
  if (open) return { state: 'open', face: 'close', expanded: true, label: 'Close what you wrote before' };
  return {
    state: standing ? 'current' : 'aged',
    face: 'count',
    expanded: false,
    label: behind,
  };
}

export function PageEchoes({ echoes, day, standing = false }) {
  const { verify } = echoes;
  const page = echoes.pageOf(day);
  const marginOpen = Boolean(echoes.marginOpen);
  const open = echoes.openDay === day;
  const first = echoes.firstEchoDay === day;
  // Read off the panel's own answer rather than worked out here, so a tab cannot say it is the page
  // the panel describes while the panel describes another.
  const onPanel = marginOpen && echoes.marginDay === day;
  const held = onPanel && echoes.heldDay === day;
  // Orthogonal to every state above: a page can be aged and lit, held and lit. The arrival is what
  // the journal now holds, not what this control is.
  const arrival = echoes.lit && echoes.lit.day === day && echoes.lit.kindledAt ? echoes.lit : null;

  // The tab carries a count while closed, so quotes are re-located on mount, not on open.
  useEffect(() => { verify(day); }, [verify, day]);

  if (!page) return null;
  // Hold the panel here, hand it back to the scroll, or — where there is no panel — open and close
  // the page's own ink. Either way the press spends whatever light is on this page: it has been seen.
  const press = () => {
    echoes.spendLight(day);
    if (marginOpen) return held ? echoes.followScroll() : echoes.holdPanel(day);
    if (open) return echoes.closeInk();
    return echoes.openInk(day);
  };
  return (
    <>
      <div className="je-tab-rail">
        <EdgeTab
          count={page.matches.length}
          tab={edgeTabProps({
            marginOpen, open, standing, held, addressed: onPanel && !held, count: page.matches.length,
          })}
          arrival={arrival}
          fresh={!echoes.presentedBefore(day)}
          settling={echoes.settling === day}
          taken={echoes.taken === day}
          onInView={echoes.litInView}
          onClick={press}
        />
      </div>
      {!marginOpen && open && <PageInk echoes={echoes} page={page} />}
      {first && <FirstEcho echoes={echoes} page={page} />}
    </>
  );
}

// The tab wears what the rule above decided: the count on its face at every width but one, and the
// labelling of whichever control it is there. On top of that it wears the arrival, which is a light
// and nothing else — no step, no flicker, no repeat swell, each of which would be a fresh transient,
// and a transient is the one thing that yanks a writer out of a sentence.
function EdgeTab({ count, tab, arrival, fresh, settling, taken, onInView, onClick }) {
  const faceRef = useRef(null);
  // BOTH DECIDED ONCE, AT MOUNT, because both are facts about this element rather than about the
  // page. A tab mounting into a dwell already under way resumes it — without that, a scroll that
  // remounts the page would re-kindle a light that has been burning for a minute.
  //
  // And `is-born` belongs to the element's FIRST paint or to nothing. The tab is drawn by the read,
  // unverified, and armed a body fetch later; a ramp applied at arming would find a tab that has
  // been on screen at full weight for a round trip, drop it to zero and fade it back — a step, and
  // the one abrupt onset this whole design exists to carry none of. So the ramp goes where the
  // appearance actually is: a tab whose page the reader had not been shown when this element first
  // rendered. On the mount's own read every page is already presented, so a cold canvas ramps
  // nothing; a page that arrives mid-session ramps in, which is the case the ramp was written for.
  const [resumed, setResumed] = useState(() => resumedOnMount(arrival?.kindledAt, Date.now()));
  const [born] = useState(() => fresh);
  useEffect(() => {
    if (!resumed) return undefined;
    const frame = requestAnimationFrame(() => setResumed(false));
    return () => cancelAnimationFrame(frame);
  }, [resumed]);

  // ONLY WHILE THE TAB IS IN THE VIEWPORT does anything spend the light, so the lit tab is the one
  // that says where it is. With no observer to ask — a surface that is not a browser — it answers
  // yes: a light that can never be spent would outlast the reading, which is the worse failure.
  useEffect(() => {
    if (!arrival) return undefined;
    if (typeof IntersectionObserver === 'undefined' || !faceRef.current) {
      onInView(true);
      return () => onInView(false);
    }
    const watch = new IntersectionObserver(
      ([entry]) => onInView(entry.isIntersecting && entry.intersectionRatio >= 1),
      { threshold: 1 },
    );
    watch.observe(faceRef.current);
    return () => { watch.disconnect(); onInView(false); };
  }, [arrival, onInView]);

  const classes = ['je-tab', `je-tab-${tab.state}`];
  if (arrival) classes.push('je-tab-lit');
  if (resumed) classes.push('is-resumed');
  if (born) classes.push('is-born');
  // The two ways a light leaves. Neither is a state of the tab, and both are gone once the ramp they
  // name has run, so nothing the scroll does to this tab is ever slowed by an arrival that is over.
  if (settling) classes.push('is-settling');
  if (taken) classes.push('is-taken');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      aria-expanded={tab.expanded}
      aria-label={tab.label}
    >
      <span className="je-tab-face" ref={faceRef} aria-hidden="true">
        {tab.face === 'close' ? (
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ) : <TabCount count={count} />}
      </span>
    </button>
  );
}

// A count that changes on a tab already drawn swaps at the ramp's midpoint, under a cross-fade of its
// own, so the box holds still while the numeral changes. Exported because the one thing it exists to
// prevent — a digit changing at full weight — happens 600ms after a change nobody is watching for,
// and is otherwise only visible by opening a browser and pressing twice at the right spacing. The rendered digit is held back the 600ms
// the fade takes to reach its floor — the reader sees the old count dim out and the new one come up,
// never a digit flipping at full weight.
export function TabCount({ count }) {
  const [shown, setShown] = useState(count);
  // The count this cross-fade is carrying to, not a flag: a second change arriving mid-fade has to
  // move this value, or the fade it started under would end on the old clock and leave the digit to
  // change afterwards at full weight — which is the one thing the fade is here to prevent.
  const [swapTo, setSwapTo] = useState(null);
  useEffect(() => {
    if (count === shown) return undefined;
    setSwapTo(count);
    const half = setTimeout(() => setShown(count), SWAP_MS);
    return () => clearTimeout(half);
  }, [count, shown]);
  useEffect(() => {
    if (swapTo === null) return undefined;
    const done = setTimeout(() => setSwapTo(null), KINDLE_MS);
    return () => clearTimeout(done);
  }, [swapTo]);
  return <span className={'je-tab-count' + (swapTo === null ? '' : ' is-swapping')}>{shown}</span>;
}

// A colour change announces nothing, so one region says what landed — the tab's own words, once, and
// never the word "new": that it is said at all is what says it is news.
export function EchoLive({ arrival }) {
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!arrival) return undefined;
    // Cleared first: a reader whose second arrival holds the same count would otherwise be told
    // nothing at all, because the region's text never changed.
    setSaid('');
    const speak = setTimeout(() => setSaid(passagesBehind(arrival.count)), 60);
    return () => clearTimeout(speak);
  }, [arrival]);
  return <p className="je-live" aria-live="polite">{said}</p>;
}

// With One, every passage found, oldest at the bottom; without One, the nearest cut, then the dates.
function PageInk({ echoes, page }) {
  const [nearest, ...rest] = page.matches;
  const ref = useRef(null);
  const scroller = echoes.canvas?.scroller ?? null;

  // Forward only, and only within a screen: a page still being flown to is the flight's business.
  useEffect(() => {
    if (!scroller || !ref.current) return;
    const frame = scroller.getBoundingClientRect();
    const rise = ref.current.getBoundingClientRect().top - (frame.top + frame.height * 0.42);
    if (rise > 0 && rise < frame.height) scroller.scrollTop += rise;
  }, [scroller, page.day]);

  if (page.entitled) {
    return (
      <div className="je-ink" ref={ref}>
        {page.matches.map((match, index) => (
          <InkRow
            key={match.day}
            match={match}
            triggerDay={page.day}
            dim={LADDER[Math.min(index, LADDER.length - 1)]}
            onOpen={() => echoes.walkTo(page.day, match)}
            onUseful={() => echoes.markUseful(page.day, match.day)}
            onNotUseful={() => echoes.retireMatch(page.day, match.day)}
          />
        ))}
      </div>
    );
  }
  // The cut passage can be answered too.
  return (
    <div className="je-ink" ref={ref}>
      <InkRow
        match={nearest}
        triggerDay={page.day}
        onOpen={() => echoes.openSheet(page.day)}
        onUseful={() => echoes.markUseful(page.day, nearest.day)}
        onNotUseful={() => echoes.retireMatch(page.day, nearest.day)}
      />
      <InkDates matches={rest} onOpen={(match) => echoes.walkTo(page.day, match)} />
      <FreePath match={nearest} />
    </div>
  );
}

// Said once, below tonight's page, never during the first run.
function FirstEcho({ echoes, page }) {
  const { claimFirstEcho } = echoes;
  useEffect(() => { claimFirstEcho(); }, [claimFirstEcho]);
  const [nearest] = page.matches;
  return (
    <div className="je-first">
      <p className="je-first-lead">Something you wrote before is close to tonight.</p>
      <p className="je-first-note">
        This is the first time that’s happened. From now on it’s the tab on the edge.
      </p>
      <InkRow match={nearest} triggerDay={page.day} onOpen={() => echoes.walkTo(page.day, nearest)} />
    </div>
  );
}
