// The desktop margin — where a page's ink opens when there is room beside the canvas. It mounts only
// while `marginOpen` (useEchoes.js) says there is, and then it is the page's only ink: nothing opens in
// the column beside it. The space it takes is reserved for the whole mount, so with no page under the
// reading waterline the panel rests empty rather than unmounting.
//
// THE PANEL NAMES THE PAGE IT DESCRIBES. With three or four dated blocks on screen at once, a panel
// that draws one page's echoes and says which one nowhere is an unattributed assertion, in a feature
// whose whole rule is that an echo may only assert what the reader can check from what is on screen.
// The tie is three parts of one mark, all read off ONE day: the STAMP wears that page's own date in
// the day row's own type and NAMES it; the RULE crosses the empty gutter from the row's right edge to
// the panel's border and AIMS; the row's own date stamp lifts to lamp and CONFIRMS. The stamp is the
// load-bearing half — the rule is never counted toward legibility, and where the geometry cannot be
// drawn honestly (`tieAim` below) it is dropped and the tie is still complete in text.
//
// Two entrances with two meanings, and they must not be confused. A FOLLOW is the scroll moving the
// panel to another page's ink; an ARRIVAL is news landing in the page the panel is already beside. An
// arrival never changes which page the panel addresses — that answer is the scroll's and the reader's,
// and nothing the journal receives may take it.

import React, { useEffect, useRef, useState } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';
import { stampWeekday } from './echoDates.js';
import { KINDLE_MS } from './arrival.js';

const MARGIN_INK = 2;   // two passages read; past that the column is a list of dates, not prose

// Where the rule's near end sits in viewport px, or null when it may not be drawn at all.
//
// This is the whole of the visibility rule, and every part of it is a measurement. The row has to
// exist on the canvas, and its stamp's centre has to lie in the band the reader can actually see:
// below `.je-trail` while a walk is up, since the trail covers the top of the canvas and occludes the
// day rows under it, and inside the scroll frame at both ends. A line to a row that is not on screen
// is a line pointing confidently at nothing, which is the one failure a strong mark can produce.
//
// During a fling the still-addressed row leaves the band and the rule goes with it — instantly, with
// no fade, because a fade would trail behind a moving row. It returns at the commit.
//
// Pure and exported: the alternative is a judgement that can only be checked by opening a browser and
// flinging the canvas at the right speed.
export function tieAim(stamp, frame, trailBottom = null) {
  if (!stamp || !frame) return null;
  const centre = (stamp.top + stamp.bottom) / 2;
  if (centre < bandTop(frame, trailBottom) || centre > frame.bottom) return null;
  return centre - 0.75;                      // the 1.5px rule straddles the row's own centre line
}

// The top of the band the reader can actually see inside the canvas. Two callers, and they have to
// agree: the mark refuses to point above this line, and the stamp scrolls a row TO it. `.je-trail`
// paints an opaque bar over the top of the canvas during a walk, so the frame's own top is not it.
export function bandTop(frame, trailBottom = null) {
  if (trailBottom == null) return frame.top;
  return Math.max(frame.top, trailBottom);
}

// The bottom edge of whatever is covering the top of the canvas, or null.
//
// IT TAKES THE PANEL AND WALKS UP ITSELF, and that is the point rather than a convenience: `.je-trail`
// is `position: fixed` with an opaque ground and it is a SIBLING of the canvas under `.journal-root`,
// so a lookup starting inside the panel finds nothing at all, the band silently widens to the whole
// frame, and the mark draws a line to a row buried under the bar. Left as a `.parentElement` at the
// call site that mistake is one character and nothing but a browser can see it; folded in here, the
// node the search starts from is a fact this module states once and a test can hold it to.
export function trailBottom(panel) {
  return panel?.parentElement?.querySelector('.je-trail')?.getBoundingClientRect().bottom ?? null;
}

// One frame of the mark: decide, then draw, and tell BOTH halves the same answer. The stub in the
// panel's head is not decoration — it answers the same question the rule does, so a rule that aimed
// while its stub stayed hidden would be two answers to "does this line reach a row you can see".
//
// Everything it needs is handed in, and it hands back the y it used. That is not test scaffolding:
// every line here is a DOM write, so with the elements and the rects injected the whole of the
// drawing is checkable without a browser — and without it, the rule can be made permanently
// invisible (park it, never aim it) with nothing in the suite noticing, because an assertion over
// source text only ever proves that a line is still written, never that it still does anything.
export function aimMark({ rule, stub = null, rootTop = 0, stampRect, frame, trailBottom = null }) {
  const y = tieAim(stampRect, frame, trailBottom);
  rule.hidden = y === null;
  if (stub) stub.hidden = y === null;
  // The y is in VIEWPORT px, because that is the space the rects it came from live in; the rule is
  // positioned against `.journal-root`, which the app shell's `contain: layout paint` puts 52px down.
  if (y !== null) rule.style.setProperty('--je-tie-y', `${y - rootTop}px`);
  return y;
}

export function EchoMargin({ echoes, page, sheeted = false }) {
  const { canvas, verify } = echoes;
  const nearest = page ? page.matches[0] : null;
  const read = page ? (page.entitled ? page.matches.slice(0, MARGIN_INK) : [nearest]) : [];
  const dated = page ? page.matches.slice(read.length) : [];
  const lit = echoes.lit && echoes.lit.kindledAt ? echoes.lit : null;
  const settling = Boolean(echoes.settling);
  const arrival = lit && page && lit.day === page.day ? lit : null;
  const swapping = Boolean(echoes.swapping);
  // HELD is the reader having put the panel here; FOLLOWING is the scroll choosing. Read off the page
  // the panel is DESCRIBING and not off the tab that asked for it: the tab is a control and the tie is
  // an indicator, and keeping them apart is what leaves the tab free to move without touching this.
  const held = Boolean(page) && echoes.heldDay === page.day;
  // The two conditions on the rule that are not measurements: a page to name, and no One sheet over
  // the panel. The sheet dims the panel to 0.26 and the rule HIDES rather than dimming with it —
  // there is no honest weight for a mark that aims at a canvas nobody is reading.
  const drawn = Boolean(page) && !sheeted;

  // The entrance a body has already played, LATCHED. The key below is what replays an entrance, so it
  // may only ever move forward: read straight off `lit`, it would fall back to the follow key the
  // moment the light was spent, unmount the panel's prose and re-fade it under the reader — and the
  // dwell ends on a pointerdown anywhere in the canvas, so one click would do it. It resets when the
  // panel changes page, so following away and back is a follow again rather than a replayed arrival.
  const played = useRef({ day: null, at: '' });
  const onPage = page ? page.day : null;
  if (played.current.day !== onPage) played.current = { day: onPage, at: '' };
  if (arrival) played.current = { day: onPage, at: arrival.kindledAt };
  const entrance = played.current.at;

  // The panel quotes a passage, so it must be located in the live page first — the guard the tab runs.
  // Run on the ADDRESSED page rather than on the one being shown: a network check has no reason to
  // wait out a fade, and the page being checked is the one about to be drawn.
  useEffect(() => { if (echoes.marginDay) verify(echoes.marginDay); }, [verify, echoes.marginDay]);

  // The rest line does not vanish under the ink replacing it: it fades out on the arrival's own clock,
  // underneath the ink coming up, so the swap carries no step of its own.
  // `undefined` until this panel has drawn once, so a panel that MOUNTS onto an arrival — which is
  // what the first echo an account ever gets does, since it opens the margin and arms in one read —
  // does not fade out a rest line that was never on screen.
  const [leaving, setLeaving] = useState(false);
  const wasResting = useRef(undefined);
  useEffect(() => {
    const resting = wasResting.current;
    wasResting.current = !page;
    if (resting === true && page && arrival) setLeaving(true);
  }, [page, arrival]);
  useEffect(() => {
    if (!leaving) return undefined;
    const gone = setTimeout(() => setLeaving(false), KINDLE_MS);
    return () => clearTimeout(gone);
  }, [leaving]);

  // THE TWO CLOCKS, AND WHY THEY ARE NOT ONE. The rule TRACKS its row continuously and CHANGES rows
  // discretely. Tracking carries no transition, ever, and survives `prefers-reduced-motion` untouched;
  // changing is the hard two-beat cut above. Conflating them is what produces a strobe.
  //
  // TRACKING IS NOT PERFECT, AND SAYING OTHERWISE WOULD BE THE WRONG CLAIM TO LEAVE HERE. The brief
  // calls it "the absence of motion relative to the content it is glued to"; it is not, because the
  // rule lives outside `.journal-scroll`. The rows are scrolled by the compositor and the rule only
  // moves when this callback writes the transform, so during a wheel scroll it trails its row.
  // Measured in composited pixels at ~47px/frame: 12-14px behind, against 1px at rest. That is most
  // of a row height — the hairline points just under the date rather than through it — and it snaps
  // on when the scroll stops. The only shape without the lag glues the mark to `.journal-marker`
  // itself, which is a change to the brief's geometry and hands the canvas an echo-family glyph, so
  // it is the design owner's call and not this file's. Until then the stamp is the load-bearing half,
  // which is the whole reason the rule is allowed to be dropped at all.
  //
  // Reads only rects, writes only a custom property that drives a TRANSFORM — never `top`, never
  // `width`, so no frame of a scroll costs a layout. This runs AFTER paint and does not have to run
  // before it: a rule that has not been aimed yet is parked outside `.journal-root`'s own clip by
  // `--je-tie-y`'s default, so the frame before the first write draws nothing rather than a hairline
  // across the top of the screen.
  const ruleRef = useRef(null);
  const stubRef = useRef(null);
  const marginRef = useRef(null);
  // The row this stamp names, brought into the band the reader can SEE — not merely to the frame's
  // top, which during a walk is underneath `.je-trail`'s opaque bar. With no trail up this is exactly
  // `scrollIntoView({ block: 'start' })`, which is what the brief asks for; with one up it clears the
  // bar, and the rule and its stub come back with the row. The ARTICLE is what moves: `.journal-marker`
  // is sticky, so the row itself does not travel with the scroll until its article lets go of it.
  //
  // ONE CASE THIS DOES NOT WIN, and it is not this button's to win: on the page a walk just landed on,
  // `Canvas.jsx` re-takes its own position on every reflow until the reader makes a gesture ON THE
  // CANVAS — a press in this panel is not one — so the scroll moves and is put back inside a frame
  // (measured: 138 -> 33 -> 138). The canvas is parking a walked-to page under the trail and holding
  // it there; that is `takePosition` and `.je-trail` between them, and it is filed rather than worked
  // around here. Everywhere else — a held page scrolled away, C.4's own case — the press lands.
  const goToPage = () => {
    const scroller = canvas?.scroller;
    const article = canvas?.dayElement?.(page.day);
    if (!scroller || !article) return;
    // HELD, because the press is the reader asking for THIS page. Without it the button reliably took
    // the panel off the page it names: the scroll it performs pushes the next echo page over the 0.55
    // waterline, the settle re-picks, and 250ms after pressing "Go to TUE 14 APR" the panel is
    // describing TUE 01 SEP. Measured at four scroll positions, identical every time. A walk already
    // answers a deliberate act this way, and `Follow again` is the undo, already in this head and
    // already appearing exactly when the panel is held — so this is the vocabulary, not a new rule.
    echoes.holdPanel(page.day);
    const frame = scroller.getBoundingClientRect();
    scroller.scrollTop += article.getBoundingClientRect().top - bandTop(frame, trailBottom(marginRef.current));
  };

  useEffect(() => {
    const rule = ruleRef.current;
    const root = marginRef.current?.parentElement ?? null;
    if (!rule || !root) return undefined;
    const scroller = canvas?.scroller ?? null;
    const stampRect = canvas?.stampRect ?? null;
    let pending = 0;
    const aim = () => {
      pending = 0;
      aimMark({
        rule,
        stub: stubRef.current,
        rootTop: root.getBoundingClientRect().top,
        stampRect: scroller && stampRect ? stampRect(page.day) : null,
        frame: scroller ? scroller.getBoundingClientRect() : null,
        trailBottom: trailBottom(marginRef.current),
      });
    };
    aim();
    if (!scroller) return undefined;
    const again = () => { if (!pending) pending = requestAnimationFrame(aim); };
    scroller.addEventListener('scroll', again, { passive: true });
    window.addEventListener('resize', again);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      scroller.removeEventListener('scroll', again);
      window.removeEventListener('resize', again);
    };
  }, [drawn, canvas, page?.day]);

  return (
    <>
      {drawn && (
        <div
          ref={ruleRef}
          className={'je-tie' + (held ? ' is-held' : '') + (swapping ? ' is-out' : '')}
          aria-hidden="true"
        >
          {/* Two elements because there are two independent fades on one mark, and one element would
              make them fight: the outer carries the SWAP, the inner the hover raise. They multiply,
              which is what a raise during a swap-out has to do — and neither can undo the other. */}
          <span className="je-tie-mark" />
        </div>
      )}
      <aside
        ref={marginRef}
        className={'je-margin' + (lit ? ' is-lit' : '') + (settling ? ' is-settling' : '')}
        aria-label="What you wrote before"
      >
        {/* Outside the swap, not inside it: the body is ramping UP, and a line fading out inside it
            would be multiplied by that ramp and so start from nothing — a step, which is the one shape
            this whole entrance exists to avoid. Two layers on one clock is what a cross-fade is. */}
        {leaving && <p className="je-margin-rest is-leaving" aria-hidden="true">No echo on this page.</p>}
        <div className={'je-margin-swap' + (swapping ? ' is-out' : '')}>
          {page && (
            <div className="je-margin-head">
              {/* The rule's near end, in the rule's own weight, on the panel's side of the border. It
                  does NOT sit at the rule's y — the head is sticky at the panel's top and the rule is
                  wherever its row is, measured 354px apart at rest — so the two do not read as one
                  line passing under the border, whatever the brief hoped. What it does carry is the
                  same fact the rule does, in the one place that is always on screen: stub present
                  means the line reaches a row you can see, stub absent means it does not. */}
              {drawn && <span ref={stubRef} className="je-margin-stub" aria-hidden="true" />}
              <button
                type="button"
                className="je-margin-stamp"
                aria-label={`Go to ${stampWeekday(page.day)}`}
                onClick={goToPage}
              >
                {stampWeekday(page.day)}
              </button>
              {/* Only while held, and it needs no caption beside it: a button that says what will
                  happen is itself the read-out that the panel is not following. */}
              {held && (
                <button type="button" className="je-margin-follow" onClick={echoes.followScroll}>
                  Follow again
                </button>
              )}
            </div>
          )}
          {/* The key is what replays an entrance. It carries the arrival's own clock so news landing in
              the page the panel already addresses plays the arrival ramp rather than nothing at all —
              and it carries no day, so the scroll handing the panel from page to page no longer
              remounts the prose under the reader. */}
          <div
            className={'je-margin-body' + (entrance ? ' is-arrival' : '') + (page ? '' : ' is-resting')}
            key={entrance || 'rest'}
          >
            {!page && <p className="je-margin-rest">No echo on this page.</p>}
            {page && read.map((match, index) => (
              <InkRow
                key={match.day}
                match={match}
                triggerDay={page.day}
                size="desk"
                dim={index === 0 ? 1 : 0.78}
                onOpen={() => (page.entitled ? echoes.walkTo(page.day, match) : echoes.openSheet(page.day))}
                onUseful={() => echoes.markUseful(page.day, match.day)}
                onNotUseful={() => echoes.retireMatch(page.day, match.day)}
              />
            ))}
            {page && <InkDates matches={dated} size="desk" onOpen={(match) => echoes.walkTo(page.day, match)} />}
            {page && (page.entitled
              ? <p className="je-margin-foot">This panel follows the scroll.</p>
              : <FreePath match={nearest} />)}
          </div>
        </div>
      </aside>
    </>
  );
}
