// Echoes arrive on a read this hook repeats every LIVE_INTERVAL while the tab is visible, so one lands
// and leaves without a reload. The count is the array, never a total computed from something not in
// hand. A quote is re-located in the live body at render or it is not shown — the wire carries passage
// text and an occurrence index, never an offset. Under PAGE_FLOOR pages nothing renders unless the
// server says `floorWaived`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { localDay } from '../hlc.js';
import { hopToHash } from '../openPosition.js';
import { CEILING_MS, PAUSE_MS, SETTLE_MS, armArrival } from './arrival.js';

const PAGE_FLOOR = 20;
// How often an open, visible canvas asks again. The derivation behind an echo takes 10-17 seconds,
// so this is the shortest wait that is not simply guessing, and it stops dead when the tab is hidden.
const LIVE_INTERVAL = 15000;
const FIRST_ECHO_KEY = 'windmill:journal-first-echo';
// The width at which the margin has room beside the canvas, and the ONLY place that number lives.
// This hook answers `marginOpen`, `JournalApp` wears it as `has-margin`, and journal.css takes the
// gutter from that class rather than asking the viewport a second time — one fact, so the panel and
// the edge tab can never disagree about whether a page's ink has anywhere to open.
const MARGIN_MIN_WIDTH = 1240;
// How long the scroll rests before the panel commits to its page — and, because a rested scroll is
// also the plainest evidence a reader has arrived somewhere, before an arrival's light is spent.
//
// THIS IS NOT A MOTION DELAY. It is a rate limit on the underlying FACT: the waterline PROPOSES
// continuously, and the panel's subject only changes once a proposal has held. A fling across four
// pages proposes four times and commits once, at the page the scroll lands on, because a fling has no
// 160ms of rest in it. The motion then runs immediately on the changed fact.
const MARGIN_SETTLE_MS = 160;
// The second guard, and the one the settle cannot give: a page must cross the waterline by this much
// to take the panel or to give it up. Trackpad inertia rests a few pixels past the line, commits,
// drifts, and re-commits; a deadband is the only thing that is not a clock and so cannot be waited out.
const MARGIN_HYSTERESIS = 12;
// Half of the panel's shipped 180ms entrance, split so both halves of the mark share one clock: the
// panel and the rule leave over this, the subject changes while both are at zero, and they come back
// over it. No new duration enters the product. Its other reader is `--je-swap` in journal.css.
const SWAP_MS = 90;
const TAKEN_MS = 150;           // --duration-fast: one feedback beat, for a light a press ended

// `occurrenceHint` is which occurrence of the text this is, not a character position, and only a hint:
// the text search decides whether a quote renders. Answers the char range in this body.
export function locate(body, text, occurrence) {
  if (!body || !text) return null;
  const want = typeof occurrence === 'number' && occurrence >= 0 ? occurrence : 0;
  let from = 0;
  let at = -1;
  for (let n = 0; n <= want; n += 1) {
    at = body.indexOf(text, from);
    if (at < 0) break;
    from = at + text.length;
  }
  if (at < 0) at = body.indexOf(text);      // the hint over-counted — fall back to the first
  return at < 0 ? null : [at, at + text.length];
}


// Two match lists are the same pairing set when they name the same passages — used to keep a page's
// verified flag across a re-read rather than re-fetching bodies that have not moved.
function sameMatches(before, after) {
  if (!before || !after || before.length !== after.length) return false;
  return before.every((match, at) => match.day === after[at].day && match.text === after[at].text);
}

// Which of a page's matches still stand, given the bodies the canvas is holding right now. A match
// into a page nobody edited is left alone — silence about a body is not evidence against a quote —
// and a match into an edited one survives only if its words are still there.
//
// Pure and exported because it is the whole of the retraction rule, and the alternative is a
// judgement that can only be checked by opening a browser.
export function stillStanding(matches, live) {
  return (matches || []).filter((match) => {
    if (!live?.has(match.day)) return true;
    return Boolean(locate(live.get(match.day), match.text, match.occurrenceHint));
  });
}


// What a passage IS, for the memory that decides whether it is news: the day it came from and the
// words themselves. Two passages out of one past day are two pieces of news; keyed by the day alone,
// showing the first would present the second for free.
function passagesOf(matches) {
  return (matches || []).map((match) => `${match.day}\u0000${match.text}`);
}

function marginRoom() {
  try {
    return window.matchMedia(`(min-width: ${MARGIN_MIN_WIDTH}px)`).matches;
  } catch {
    return false;   // nothing to ask — the narrow surface is the one that needs no room
  }
}

// How long the panel and the rule are held at zero while the subject changes under them. NOTHING under
// `prefers-reduced-motion`: journal.css leaves the two fades to the site-wide clamp there, and a gap
// with no fade either side of it is not a cover for a change — it is the only motion left, a blank
// panel for a tenth of a second. Asked at the moment of the swap rather than watched, because the one
// thing that reads it is one `setTimeout` and a preference cannot change between deciding and starting.
function swapGap() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SWAP_MS;
  } catch {
    return SWAP_MS;
  }
}

function seenFirstEcho() {
  try {
    return localStorage.getItem(FIRST_ECHO_KEY) === 'seen';
  } catch {
    return false;
  }
}

// `covered` is the canvas being under something — search, the zoom view, the nudges. An arrival that
// lands then is HELD rather than spent: it kindles on the first frame the canvas is back.
export function useEchoes({
  today = localDay(), account = null, onFly = () => {}, covered = false,
} = {}) {
  const [pages, setPages] = useState(new Map());       // trigger day -> { day, entitled, matches, verified }
  const [floored, setFloored] = useState(false);       // fewer than ~20 pages: the canvas stays quiet
  const [firstEver, setFirstEver] = useState(false);
  const [retiredOffers, setRetiredOffers] = useState(new Set());
  const [openDay, setOpenDay] = useState(null);        // the one page whose ink is open
  const [sheetDay, setSheetDay] = useState(null);
  const [hops, setHops] = useState([]);                // the walk, tonight first
  const [followedDay, setFollowedDay] = useState(null); // which page the scroll puts the margin beside
  const [settledDay, setSettledDay] = useState(null);  // and which of those the panel has committed to
  const [heldDay, setHeldDay] = useState(null);        // the page the reader is holding the panel on
  const [shownSubject, setShownSubject] = useState(null);   // the day the swap machine is settled on
  const [swapping, setSwapping] = useState(false);          // and whether it is on its way out of it
  const [wide, setWide] = useState(marginRoom);        // room for the margin at this viewport width
  // Handed over by Canvas.jsx on mount: its scroller and its day lookup. Every echo surface measures
  // through this rather than querying the canvas's own markup.
  const [canvas, setCanvas] = useState(null);
  const holdCanvas = useCallback((next) => setCanvas(next), []);
  // THE ARRIVAL. One record, not a map, because the calm ceiling is one lit tab at a time:
  // { day, landedAt, kindledAt, count, born }. `kindledAt` is null while the canvas is covered — the
  // light is held, not spent — and the ceiling is measured from `landedAt` either way.
  const [lit, setLit] = useState(null);
  const [litInSight, setLitInSight] = useState(false);   // the lit tab's own answer, from the face
  // A light has two ways out, and they do not look alike: SETTLING is the slow decay a light spends
  // itself in once the writer has surfaced, TAKEN is a press, which ends the dwell with no decay at
  // all. They are marked rather than inferred because the ramps belong to the arrival and to nothing
  // else: a tab's states are the scroll's and the reader's, and those still take effect at once.
  const [settling, setSettling] = useState(null);
  const [taken, setTaken] = useState(null);

  // Asked here rather than in a media query: the tab's behaviour and the panel's presence are then
  // two consequences of one answer, at every width, with nothing to keep in step.
  useEffect(() => {
    const query = typeof window === 'undefined' || !window.matchMedia
      ? null
      : window.matchMedia(`(min-width: ${MARGIN_MIN_WIDTH}px)`);
    if (!query) return undefined;
    const answer = () => setWide(query.matches);
    answer();
    query.addEventListener('change', answer);
    return () => query.removeEventListener('change', answer);
  }, []);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const bodies = useRef(new Map());                    // match day -> live body, fetched once for re-location
  const verifying = useRef(new Set());                 // pages whose bodies are already on the way
  // How many reads of this mount have PRESENTED this account's echoes.
  //
  // Its whole job is naming the first one, because the first one arms nothing: what it finds was
  // already on screen when the journal opened, and lighting it would be a claim about time that is
  // false. A floored reply is deliberately not counted — it presents nothing, and `pagesWritten` can
  // read under the floor for a beat, so counting it would spend the first read on a reply that
  // seeded no memory and let the next read light the whole back catalogue.
  //
  // It is read INSIDE the read, never from an effect: an effect sees whatever number the commit it
  // was batched into left behind, and a tab returning to the foreground starts two reads at once.
  const reads = useRef(0);
  // Bumped whenever the account or the day changes. Every read and every re-location carries the one
  // it started under and drops its answer if it has moved: a poll started before a sign-out lands
  // after it, and without this it would draw the previous account's prose on the new account's
  // canvas — and now light a tab and announce it.
  const era = useRef(0);
  // The days a LATER read added or changed, and so the only ones worth re-locating eagerly. The
  // mount's own read is left to the tabs that draw it, which is what keeps opening the journal from
  // fetching every body of every echo page the account has.
  const landed = useRef(new Set());
  // Presented at rest, and therefore not news. Held in a ref because nothing draws it: making it
  // state would re-render the whole canvas on every poll beat that changed nothing.
  const shown = useRef(new Map());
  const nearestPage = useRef(null);   // the reading waterline's page, for the calm ceiling's choice
  const litNow = useRef(null);        // the light standing right now, read by the arming without re-running it
  const isCovered = useRef(false);

  // The read, as a function rather than only as a mount effect. Echoes arrive SECONDS after a save —
  // the segmenter, the embedder and the curator take 10-17 of them — and until this was callable the
  // only way to see one was to reload the page, which is not a journal behaving like a journal.
  const load = useCallback(() => {
    let cancelled = false;
    const mine = era.current;
    journalApi.echoes('0001-01-01', today)
      .then((reply) => {
        if (cancelled || mine !== era.current) return;
        // Below the floor nothing renders; the server waives it for the accounts building this.
        if (!reply.floorWaived
            && typeof reply.pagesWritten === 'number' && reply.pagesWritten < PAGE_FLOOR) {
          setFloored(true);
          setPages(new Map());
          // NOT counted. `reads` exists to name the read that PRESENTED this account's echoes, and a
          // floored reply presents nothing — it says the canvas stays quiet. Counting it would spend
          // the first read on a reply that seeded no memory, and the next read would then find every
          // page in the account unseen and light one. This same comment block already says why that
          // is reachable: `pagesWritten` can read under the floor for a beat.
          return;
        }
        setFloored(false);
        const found = (reply.pages || []).filter((page) => page.matches?.length);
        if (!reads.current) {
          // THE MOUNT'S FIRST COMPLETED READ ARMS NOTHING, and it says so HERE — as it lands, not
          // through a flag some later effect reads. Everything it found is presented at rest: a page
          // whose echo was already there when the journal opened is not news, and lighting it would
          // be a claim about time that is false.
          shown.current = new Map(found.map((page) => [page.day, new Set(passagesOf(page.matches))]));
        } else {
          // A later read: whatever it added or changed is worth re-locating at once rather than on
          // the next beat, since both the count and the arming wait on that.
          for (const page of found) {
            const held = pagesRef.current.get(page.day);
            if (!held || !sameMatches(held.matches, page.matches)) landed.current.add(page.day);
          }
        }
        reads.current += 1;
        setPages((current) => new Map(found.map((page) => [page.day, {
          day: page.day,
          entitled: page.entitled !== false,
          matches: page.matches,
          // A page already verified against a body that has not moved stays verified, so a re-read
          // never flickers a standing quote back into an unchecked one.
          verified: Boolean(current.get(page.day)?.verified)
            && sameMatches(current.get(page.day)?.matches, page.matches),
        }])));
        setFirstEver(Boolean(reply.firstEchoEver) && !seenFirstEcho());
      })
      .catch(() => { /* no echoes to show — leave the canvas quiet */ });
    return () => { cancelled = true; };
  }, [today, account]);

  useEffect(() => {
    // All of it is the account's own prose, so a change of who is signed in drops it before asking again.
    setPages(new Map());
    setFloored(false);
    setFirstEver(false);
    setOpenDay(null);
    setSheetDay(null);
    setHops([]);
    setFollowedDay(null);
    setSettledDay(null);
    setHeldDay(null);
    setShownSubject(null);
    setSwapping(false);
    bodies.current = new Map();
    verifying.current = new Set();
    era.current += 1;
    reads.current = 0;
    shown.current = new Map();
    landed.current = new Set();
    setLit(null);
    setSettling(null);
    setTaken(null);
    return load();
  }, [today, account, load]);

  // Fetch the bodies these quotes live in, re-locate each one, drop the ones that no longer stand.
  // Fetch the bodies these quotes live in, re-locate each one, drop the ones that no longer stand.
  // `fresh` re-reads bodies the client already holds, which is what makes this a RECHECK rather than
  // a first look: the writer edits the page an echo quotes and the quote has to go without anybody
  // reloading anything.
  const check = useCallback(async (day, fresh = false) => {
    const page = pagesRef.current.get(day);
    if (!page || (!fresh && page.verified) || verifying.current.has(day)) return;
    const mine = era.current;
    // Both captured here: a check that unwinds after the account changed must release ITS OWN
    // marker, not whatever Set the new account has since installed.
    const inFlight = verifying.current;
    inFlight.add(day);
    const days = [...new Set(page.matches.map((match) => match.day))];
    const wanted = fresh ? days : days.filter((d) => !bodies.current.has(d));
    const loaded = await Promise.all(wanted.map(async (d) => {
      try {
        const fetched = await journalApi.page(d);
        return [d, fetched?.body || ''];
      } catch {
        // A body we could not read decides nothing: leaving the quote alone is the honest failure,
        // because dropping it would retire an echo on a dropped connection.
        return [d, bodies.current.get(d) ?? null];
      }
    }));
    inFlight.delete(day);
    // Bodies fetched for an account that is no longer signed in are that account's prose. They may
    // not enter this cache, where a later re-location would read them as the new account's words.
    if (mine !== era.current) return;
    loaded.forEach(([d, body]) => { if (body !== null) bodies.current.set(d, body); });
    setPages((current) => {
      const held = current.get(day);
      if (!held) return current;
      const standing = stillStanding(held.matches, bodies.current);
      const located = standing.map((match) => {
        const span = locate(bodies.current.get(match.day), match.text, match.occurrenceHint);
        return span ? { ...match, lo: span[0], hi: span[1] } : match;
      });
      const next = new Map(current);
      if (!located.length) {
        next.delete(day);                              // never an empty "no echoes" state
        // And forget it. `shown` means presented AT REST on the canvas; a page whose quotes no
        // longer stand has left the canvas, so the next time it appears it is being presented
        // afresh — it lights, and its tab ramps in, rather than coming back invisibly. This is not
        // the reader's "not useful", which is a refusal and stays remembered.
        shown.current.delete(day);
      } else next.set(day, { ...held, matches: located, verified: true });
      return next;
    });
  }, []);

  const verify = useCallback((day) => check(day, false), [check]);

  // ECHOES ARRIVE AND LEAVE WITHOUT A RELOAD, which until now they did not: this hook read once on
  // mount and never again, so a writer saw tonight's echo only by reloading the page and saw a
  // deleted one linger until they did. The pipeline is a segmenter, an embedder and a curator —
  // 10-17 seconds after a save — so the only question was who asks again, and the answer was nobody.
  //
  // Asking again is cheap (one small read of this account's echoes) and it is paused whenever the
  // tab is hidden, so a journal left open in a background tab costs nothing at all.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== 'visible') return;
      load();
      for (const day of pagesRef.current.keys()) check(day, true);
    };
    const wake = () => { if (document.visibilityState === 'visible') again(); };
    const beat = setInterval(again, LIVE_INTERVAL);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      clearInterval(beat);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [load, check]);

  // The canvas is under something whenever the caller's overlays are up OR the One sheet is, which
  // is this hook's own answer — so the caller is never asked to tell us a fact we already hold.
  const under = covered || sheetDay !== null;
  isCovered.current = under;

  // A page a LATER read added or changed is re-located AT ONCE rather than on the next beat: the
  // count and the arming both wait on `verified`, so without this a page that landed this second
  // would state an unchecked count and light up to LIVE_INTERVAL late. Scoped to those days on
  // purpose — sweeping every unverified page would make opening the journal fetch every body of
  // every echo the account has, where the mount's own pages are re-located by the tabs that draw
  // them.
  useEffect(() => {
    for (const day of landed.current) {
      const page = pages.get(day);
      if (!page || page.verified) { landed.current.delete(day); continue; }
      check(day, true);
    }
  }, [pages, check]);

  // THE ARMING. Every read runs it; only the ones carrying something the reader has not been shown
  // light anything. The rule itself is pure and lives in arrival.js — this is the I/O around it.
  nearestPage.current = followedDay;
  litNow.current = lit;
  useEffect(() => {
    if (!reads.current) return;                        // the journal has not answered yet
    const { shown: presented, arrival } = armArrival({
      shown: shown.current,
      pages: [...pages.values()].map((page) => ({
        day: page.day,
        verified: Boolean(page.verified),
        passages: passagesOf(page.matches),
      })),
      openDay,
      nearest: nearestPage.current,
      today,
    });
    shown.current = presented;
    if (!arrival) return;
    const now = Date.now();
    // Read before anything is set: whether the light is MOVING is a fact about the frame the arrival
    // landed in, and a ref re-read afterwards would already be describing the new light.
    const leaving = litNow.current;
    setLit((current) => {
      // More on a page already lit is not a second arrival: the count swaps and the dwell begins
      // again, but the light never re-kindles. A second onset is the one thing that yanks.
      if (current && current.day === arrival.day) return { ...current, count: arrival.count };
      return { day: arrival.day, landedAt: now, kindledAt: isCovered.current ? null : now, count: arrival.count };
    });
    // The one light there is moves to the newer news, so the page losing it DECAYS rather than going
    // dark on the spot — the whole ramp lives on the lit class, and dropping the class alone would
    // take the ramp with it and snap the face.
    setSettling((current) => {
      if (leaving && leaving.day !== arrival.day) return leaving.day;
      return current === arrival.day ? null : current;
    });
  }, [pages, openDay, today]);

  // A light whose page is gone — retired, dismissed, or re-located away — has nothing left to name.
  useEffect(() => {
    if (lit && !pages.has(lit.day)) setLit(null);
  }, [lit, pages]);

  // Held under an overlay, kindled on the first frame the canvas is back. The ceiling still runs from
  // when it landed, so a journal left under ⌘K for two minutes does not owe a light on return.
  useEffect(() => {
    if (!lit || lit.kindledAt || under) return undefined;
    if (Date.now() - lit.landedAt >= CEILING_MS) { setLit(null); return undefined; }
    setLit((current) => (current && !current.kindledAt ? { ...current, kindledAt: Date.now() } : current));
    return undefined;
  }, [lit, under]);

  // THE DWELL — the light waits to be spent. It persists until there is evidence the writer has
  // surfaced, and ONLY WHILE THE TAB IS ON SCREEN: if tonight's echo lands while they are reading
  // March, nothing spends it, and the scroll back is what starts the decay as they arrive. That is
  // what makes firing the instant it lands survivable — nothing has to be caught in flight.
  useEffect(() => {
    if (!lit || !lit.kindledAt || !canvas || under || !litInSight) return undefined;
    const { scroller } = canvas;
    const day = lit.day;
    const spend = () => { setLit(null); setSettling(day); };
    let pause = setTimeout(spend, PAUSE_MS);
    let rest = null;
    const typed = () => { clearTimeout(pause); pause = setTimeout(spend, PAUSE_MS); };
    const scrolled = () => { clearTimeout(rest); rest = setTimeout(spend, MARGIN_SETTLE_MS); };
    const ceiling = setTimeout(spend, Math.max(0, lit.landedAt + CEILING_MS - Date.now()));
    scroller.addEventListener('keydown', typed);
    scroller.addEventListener('scroll', scrolled, { passive: true });
    scroller.addEventListener('focusout', spend);
    scroller.addEventListener('pointerdown', spend);
    return () => {
      clearTimeout(pause);
      if (rest) clearTimeout(rest);
      clearTimeout(ceiling);
      scroller.removeEventListener('keydown', typed);
      scroller.removeEventListener('scroll', scrolled);
      scroller.removeEventListener('focusout', spend);
      scroller.removeEventListener('pointerdown', spend);
    };
  }, [lit, canvas, under, litInSight]);

  // Whether a page has ever been drawn at rest. A tab asks this ONCE, as it mounts, to know whether
  // it is the appearance of a new object or an element that has been on screen all along — which the
  // arming cannot answer, because a tab is drawn by the read and armed a body fetch later.
  const presentedBefore = useCallback((day) => shown.current.has(day), []);

  // The lit tab reports its own visibility, because it is the only thing that knows where it is.
  const litInView = useCallback((seen) => setLitInSight(Boolean(seen)), []);

  // A press ends the dwell with no decay at all: the face the press asked for takes over at feedback
  // speed. Feedback is immediate and never queued, whatever else is in flight.
  const spendLight = useCallback((day) => {
    setLit((current) => (current && current.day === day ? null : current));
    setTaken(day);
  }, []);

  useEffect(() => {
    if (!taken) return undefined;
    const beat = setTimeout(() => setTaken(null), TAKEN_MS);
    return () => clearTimeout(beat);
  }, [taken]);

  useEffect(() => {
    if (!settling) return undefined;
    const decay = setTimeout(() => setSettling(null), SETTLE_MS);
    return () => clearTimeout(decay);
  }, [settling]);

  // What a screen reader gets, since a colour change announces nothing: ONE region, owned here rather
  // than one per tab, saying the tab's own label once per arrival. That it is said at all is what
  // says the news is new — adding the word would make it a notification, and the journal never
  // speaks first.
  const announce = useMemo(
    () => (lit?.kindledAt ? { day: lit.day, count: lit.count, at: lit.kindledAt } : null),
    [lit],
  );

  const openInk = useCallback((day) => setOpenDay(day), []);
  const closeInk = useCallback(() => setOpenDay(null), []);
  // Where the margin is open the tab discloses nothing — the panel is the ink and it is already
  // there — so a press holds the panel on a page instead of the scroll choosing, and a press on the
  // page it is already held on hands it back to the scroll. `openDay` keeps its own single meaning:
  // the ink open in the page column, which exists only below the margin's width.
  const holdPanel = useCallback((day) => setHeldDay(day), []);
  const followScroll = useCallback(() => setHeldDay(null), []);
  const openSheet = useCallback((day) => setSheetDay(day), []);
  const closeSheet = useCallback(() => setSheetDay(null), []);

  // "Not now" — held locally first, posted after, never posted twice.
  const retireOffer = useCallback((day) => {
    setSheetDay((current) => (current === day ? null : current));
    if (retiredOffers.has(day)) return;
    setRetiredOffers((current) => new Set(current).add(day));
    journalApi.dismissEchoOffer(day).catch(() => { /* answered here regardless */ });
  }, [retiredOffers]);

  // "Not useful" on a page: one request for the whole set, never one per match — per-match calls can
  // each fail on their own and leave a page half faded on the next read.
  const retireEcho = useCallback((day) => {
    const held = pagesRef.current.get(day);
    setOpenDay((current) => (current === day ? null : current));
    setHeldDay((current) => (current === day ? null : current));
    setPages((current) => {
      const next = new Map(current);
      next.delete(day);
      return next;
    });
    journalApi.dismissEchoPage(day).catch(() => {
      if (held) setPages((current) => new Map(current).set(day, held));
    });
  }, []);

  // "Not useful" on one pairing: only that passage goes, and a refusal puts it back at once. No retry
  // queue — a queue would be a second, invisible copy of the reader's answer.
  const retireMatch = useCallback((day, matchDay) => {
    const held = pagesRef.current.get(day);
    if (!held) return;
    const kept = held.matches.filter((match) => match.day !== matchDay);
    setPages((current) => {
      const next = new Map(current);
      if (kept.length) next.set(day, { ...held, matches: kept });
      else next.delete(day);                           // never an empty "no echoes" state
      return next;
    });
    journalApi.dismissEcho(day, matchDay).catch(() => {
      setPages((current) => new Map(current).set(day, held));
    });
  }, []);

  // Marked here first, and unmarked again if the server refused, since `useful` is served on the next read.
  const markUseful = useCallback((day, matchDay) => {
    const answer = (useful) => (current) => {
      const held = current.get(day);
      if (!held) return current;
      const matches = held.matches.map((match) => (match.day === matchDay ? { ...match, useful } : match));
      return new Map(current).set(day, { ...held, matches });
    };
    setPages(answer(true));
    journalApi.echoUseful(day, matchDay).catch(() => setPages(answer(false)));
  }, []);

  // A position is a URL: the hop is a hash change, and the canvas loads the day and lights the passage.
  // It goes through `hopToHash` so the entry carries the hop mark — a day walked to is not a day the
  // writer asked for, and a reload taken mid-walk must open on tonight rather than resurrect it.
  const walkTo = useCallback((triggerDay, match) => {
    journalApi.echoOpened(triggerDay, match.day).catch(() => { /* a lost signal changes nothing here */ });
    setHops((current) => {
      const trail = current.length ? current : [today];
      const seen = trail.indexOf(match.day);
      return seen >= 0 ? trail.slice(0, seen + 1) : [...trail, match.day];
    });
    setOpenDay(match.day);
    setHeldDay(match.day);
    hopToHash(`#/journal/${match.day}`);
    onFly({ day: match.day, lo: match.lo, hi: match.hi });
  }, [today, onFly]);

  // Stepping back onto a page already in the trail folds the trail rather than growing a loop.
  const standOn = useCallback((day) => {
    setHops((current) => {
      const seen = current.indexOf(day);
      return seen <= 0 ? [] : current.slice(0, seen + 1);
    });
    setOpenDay(null);
    setHeldDay(null);
    hopToHash(day === today ? '#/journal' : `#/journal/${day}`);
    onFly({ day });
  }, [today, onFly]);

  const backToTonight = useCallback(() => {
    setHops([]);
    setOpenDay(null);
    setHeldDay(null);
    hopToHash('#/journal');
    onFly({ day: today });
  }, [today, onFly]);

  // The once-ever card belongs to the newest page with an echo. The server owns the claim; the device
  // flag can only withhold the card, never assert it.
  const firstEchoDay = useMemo(() => {
    if (!firstEver || !pages.size) return null;
    return [...pages.keys()].sort().pop();
  }, [firstEver, pages]);

  const claimFirstEcho = useCallback(() => {
    try { localStorage.setItem(FIRST_ECHO_KEY, 'seen'); } catch { /* storage unavailable — it may say itself twice */ }
  }, []);

  // The margin sits beside the echo page under the reading waterline, and beside the page the reader
  // pointed it at for as long as that page is on screen; with no echo page on screen at all it goes.
  useEffect(() => {
    if (!pages.size) { setFollowedDay(null); return undefined; }
    if (!canvas) return undefined;
    const { scroller, dayElement } = canvas;
    // The page being read is the last one whose day row has passed the upper half of the canvas.
    // `keep` is the difference between the reader moving and the journal receiving. A scroll or a
    // resize re-decides outright. A change in WHICH PAGES HAVE ECHOES must not: an echo landing on a
    // page further down the same screen would otherwise take the panel off the prose the reader is
    // mid-sentence in, and swap it under them with the 180ms follow — a step, and a far louder one
    // than the light that caused it. An arrival never changes which page the panel addresses.
    const pick = (keep) => {
      const frame = scroller.getBoundingClientRect();
      const waterline = frame.top + frame.height * 0.55;
      const visible = [...pages.keys()]
        .map((day) => [day, dayElement(day)?.getBoundingClientRect()])
        .filter(([, box]) => box && box.bottom > frame.top && box.top < frame.bottom)
        .sort((a, b) => a[1].top - b[1].top);
      const at = (line) => {
        const reading = visible.filter(([, box]) => box.top <= line).pop();
        return (reading || visible[0] || [null])[0];
      };
      const order = visible.map(([day]) => day);
      // THE DEADBAND. Two answers, one for each side of the waterline: a page has to clear the HIGHER
      // line to take the panel, and the page holding it has to fall past the LOWER one to give it up.
      // Between them the incumbent keeps it, so a decelerating scroll that rests three pixels past the
      // line cannot commit, drift, and commit again — which no amount of settling would have stopped,
      // because inertia rests.
      const early = at(waterline - MARGIN_HYSTERESIS);
      const late = at(waterline + MARGIN_HYSTERESIS);
      setFollowedDay((current) => {
        if (keep && current && order.includes(current)) return current;
        const here = order.indexOf(current);
        if (here < 0) return at(waterline);
        if (here < order.indexOf(early)) return early;
        if (here > order.indexOf(late)) return late;
        return current;
      });
    };
    const moved = () => pick(false);
    pick(true);
    scroller.addEventListener('scroll', moved, { passive: true });
    window.addEventListener('resize', moved);
    return () => {
      scroller.removeEventListener('scroll', moved);
      window.removeEventListener('resize', moved);
    };
  }, [pages, canvas]);

  // The follow is committed only once the scroll has rested, so a fast pass crosses pages without
  // strobing the panel.
  useEffect(() => {
    const settle = setTimeout(() => setSettledDay(followedDay), MARGIN_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [followedDay]);

  // THE page the panel sits beside — held where the reader held it, and under the reading waterline
  // otherwise. One answer, because the panel draws that page and every tab reads whether it is the
  // one: a tab deciding this for itself is how a control comes to disagree with what it points at.
  // A hold on a page whose echoes are gone falls through rather than resting the panel on nothing.
  const marginDay = heldDay && pages.has(heldDay) ? heldDay : settledDay;
  // And the page the panel is FOR, which is a page only while there is a panel. Below the margin's
  // width nothing describes a page, so no day row may be lit as though something did.
  const addressedDay = wide ? marginDay : null;

  // THE SWAP — one clock for both halves of the mark. The panel and the rule leave together, the
  // subject changes while both are at zero, and they come back together, so the tie reads as the SAME
  // EVENT as the panel's swap rather than a second one beside it.
  //
  // A GAP AND NOT A CROSS-FADE. For the length of a cross-fade there would be two rules on screen
  // pointing at two pages — a moment of a literally false assertion, and the honesty rule the whole
  // feature stands on is that an echo may only assert what the reader can check. The gap never shows
  // two. And a CUT rather than a slide: the panel's subject did not MOVE, it CHANGED, and a line
  // sweeping the canvas would be the strobe this design exists to carry none of.
  //
  // The first page the panel ever describes takes no gap — there is nothing on screen to leave.
  useEffect(() => {
    // CLEARED HERE, NOT ONLY IN THE TIMER. Change the subject and change it back inside the gap and
    // this effect re-runs with the two days equal again — the cleanup has already killed the timer
    // that would have cleared the flag, so an early return that only returned would leave `swapping`
    // true for ever, holding the panel AND the rule at opacity 0 with the row still lit beside them.
    // A double-press on one tab is enough. The flag belongs to the difference between these two days,
    // so the place that finds them equal is the place that has to say so.
    if (addressedDay === shownSubject) { setSwapping(false); return undefined; }
    const gap = shownSubject === null ? 0 : swapGap();
    if (!gap) { setShownSubject(addressedDay); return undefined; }
    setSwapping(true);
    const swap = setTimeout(() => { setShownSubject(addressedDay); setSwapping(false); }, gap);
    return () => clearTimeout(swap);
  }, [addressedDay, shownSubject]);

  const pageOf = useCallback((day) => (floored ? null : pages.get(day) || null), [floored, pages]);

  // THE DAY THE PANEL IS ACTUALLY DRAWING, which is not always the day the machine is settled on: a
  // page whose last match the reader has just refused leaves `pages` at once, and for the length of
  // one swap the machine is still pointed at it. Ungated, the panel would rest — it draws `pageOf`,
  // which answers null — while the canvas went on lighting that page's row in lamp, which is exactly
  // the disagreement between the two surfaces this whole mark exists to make impossible.
  //
  // Asked THROUGH `pageOf` and not through `pages`, so it is the same question its only consumers
  // ask. `pageOf` also answers null under the page floor, and a gate written against `pages` would
  // agree with it only because `setFloored` and `setPages` happen to land in one React batch — true
  // by coincidence rather than by construction, and one un-batched write away from a lit row beside
  // an empty panel.
  const shownDay = pageOf(shownSubject) ? shownSubject : null;

  return {
    today,
    canvas,
    holdCanvas,
    pageOf,
    verify,
    // The read itself. Nothing in the product calls it — the beat above and the mount effect are the
    // only readers — and it is exposed so a test can land a reply without waiting out LIVE_INTERVAL.
    reread: load,
    openDay,
    openInk,
    closeInk,
    sheetDay,
    openSheet,
    closeSheet,
    retireOffer,
    retireEcho,
    retireMatch,
    markUseful,
    walkTo,
    standOn,
    hops,
    backToTonight,
    firstEchoDay,
    claimFirstEcho,
    followedDay,
    marginDay,
    // What the panel, its stamp, its stub, its rule and the lit day row all read. One source of truth,
    // so there is no frame in which the canvas and the panel name different days.
    shownDay,
    swapping,
    heldDay,
    holdPanel,
    followScroll,
    // THE GUTTER IS RESERVED ON WIDTH ALONE. It used to also need `hasGutter`, a per-account
    // localStorage latch set the first time a read came back carrying any echo — so the space
    // appeared mid-session at the moment an account was first paired, and the reading column slid
    // 150px sideways under the writer at exactly the moment the arrival light was asking to be
    // looked at. `journal.md:56` reserves the space "whether or not the panel has anything in it";
    // ruled 2026-09-02 that it means every account at this width. An empty column costs a reader
    // nothing; a canvas that moves costs them the sentence they were writing.
    marginOpen: wide,
    // The arrival. `lit` is orthogonal to every tab state there is — a page can be aged and lit, held
    // and lit — so it is a separate answer and never a member of that enum.
    lit,
    settling,
    presentedBefore,
    litInView,
    spendLight,
    taken,
    announce,
  };
}
