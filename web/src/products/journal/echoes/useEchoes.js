// The echoes the server left on your pages, and everything the surface does with them. They are
// derived from the writer's own save (backend ECHOES.md, "Delivery") rather than by a nightly pass,
// which is why nothing here polls and nothing here shows a spinner: the page is re-read on the next
// ordinary read, and the journal never speaks on its own initiative.
//
// Three rules shape this file:
//
//   The count is the array. The server sends only matches it verified, the client re-locates every
//   one before the tab draws its number, so the count on the edge of a page is a count of rows the
//   reader can open. Nothing here ever computes a total from something it hasn't got.
//
//   A quote is re-located in the live body at render, or it is not shown. The wire carries passage
//   TEXT and an occurrence index — never an offset — so an edit to an old page can't silently
//   re-point a quote at the wrong sentence, and the two sides never disagree about an encoding.
//
//   Under ~20 pages, nothing at all. No tabs, no offer — unless the server says `floorWaived`,
//   which it does for owner accounts so the people building this can see their own echoes. There is nothing true to sell yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { localDay } from '../hlc.js';

const PAGE_FLOOR = 20;
const FIRST_ECHO_KEY = 'windmill:journal-first-echo';

// `occurrenceHint` says WHICH occurrence of this text the passage is — the third "I want to teach",
// not a character position. It is a hint and nothing more: the server omits it when the body has
// moved under the passage, and the text search below is what actually decides whether a quote
// renders. A hit yields the char range in this body, which is what the canvas lights when you walk.
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

function seenFirstEcho() {
  try {
    return localStorage.getItem(FIRST_ECHO_KEY) === 'seen';
  } catch {
    return false;
  }
}

export function useEchoes({ today = localDay(), account = null, onFly = () => {} } = {}) {
  const [pages, setPages] = useState(new Map());       // trigger day -> { day, entitled, matches, verified }
  const [floored, setFloored] = useState(false);       // fewer than ~20 pages: the canvas stays quiet
  const [firstEver, setFirstEver] = useState(false);
  const [retiredOffers, setRetiredOffers] = useState(new Set());
  const [openDay, setOpenDay] = useState(null);        // the one page whose ink is open
  const [sheetDay, setSheetDay] = useState(null);
  const [hops, setHops] = useState([]);                // the walk, tonight first — a receipt, not a wizard
  const [followedDay, setFollowedDay] = useState(null); // which page the desktop margin sits beside
  // The canvas, handed over by Canvas.jsx when it mounts: its scroller and its own day lookup.
  // Every echo surface measures through this — none of them knows what the canvas's markup is
  // called, and none of them can be left querying a class that has been renamed.
  const [canvas, setCanvas] = useState(null);
  const holdCanvas = useCallback((next) => setCanvas(next), []);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const bodies = useRef(new Map());                    // match day -> live body, fetched once for re-location
  const verifying = useRef(new Set());                 // pages whose bodies are already on the way

  useEffect(() => {
    let cancelled = false;
    // Everything below is the ACCOUNT's own prose — the quotes, and the bodies fetched to re-locate
    // them — so a change of who is signed in drops all of it before anything is asked again. An
    // echo left standing across a hand-over is the previous person's writing on the new person's
    // canvas: JOURNAL-1, one room over.
    setPages(new Map());
    setFloored(false);
    setFirstEver(false);
    setOpenDay(null);
    setSheetDay(null);
    setHops([]);
    setFollowedDay(null);
    bodies.current = new Map();
    verifying.current = new Set();
    journalApi.echoes('0001-01-01', today)
      .then((reply) => {
        if (cancelled) return;
        // The floor is a rule about whether there is anything true to sell yet, and the server
        // waives it for the accounts building this — below it nothing renders at all, so a working
        // echo and a broken pipeline look identical on the one journal that has to be watched.
        if (!reply.floorWaived
            && typeof reply.pagesWritten === 'number' && reply.pagesWritten < PAGE_FLOOR) {
          setFloored(true);
          return;
        }
        const found = (reply.pages || []).filter((page) => page.matches?.length);
        setPages(new Map(found.map((page) => [page.day, {
          day: page.day,
          entitled: page.entitled !== false,
          matches: page.matches,
          verified: false,
        }])));
        setFirstEver(Boolean(reply.firstEchoEver) && !seenFirstEcho());
      })
      .catch(() => { /* no echoes to show — leave the canvas quiet */ });
    return () => { cancelled = true; };
  }, [today, account]);

  // Fetch the bodies this page's quotes live in, re-locate every one, and drop the ones that no
  // longer stand. Runs when a page's tab mounts, because the tab carries the count at rest: a number
  // that shrank the moment you opened it would be exactly the lie this feature must not tell.
  const verify = useCallback(async (day) => {
    const page = pagesRef.current.get(day);
    if (!page || page.verified || verifying.current.has(day)) return;
    verifying.current.add(day);
    const wanted = [...new Set(page.matches.map((match) => match.day))].filter((d) => !bodies.current.has(d));
    const loaded = await Promise.all(wanted.map(async (d) => {
      try {
        const fetched = await journalApi.page(d);
        return [d, fetched?.body || ''];
      } catch {
        return [d, ''];
      }
    }));
    loaded.forEach(([d, body]) => bodies.current.set(d, body));
    verifying.current.delete(day);
    setPages((current) => {
      const held = current.get(day);
      if (!held) return current;
      const located = held.matches
        .map((match) => {
          const span = locate(bodies.current.get(match.day), match.text, match.occurrenceHint);
          return span ? { ...match, lo: span[0], hi: span[1] } : null;
        })
        .filter(Boolean);
      const next = new Map(current);
      if (!located.length) next.delete(day);           // never an empty "no echoes" state
      else next.set(day, { ...held, matches: located, verified: true });
      return next;
    });
  }, []);

  const openInk = useCallback((day) => setOpenDay(day), []);
  const closeInk = useCallback(() => setOpenDay(null), []);
  const openSheet = useCallback((day) => setSheetDay(day), []);
  const closeSheet = useCallback(() => setSheetDay(null), []);

  // "Not now" — the sheet closes and the page is answered. Nothing on the canvas ever asks, so
  // there is nothing here to suppress; this is the record that the page was answered, so nothing
  // ever asks it again. Held locally first and posted after: a server that refuses the decline must
  // not cost the reader the answer they gave, and must not be told it twice.
  const retireOffer = useCallback((day) => {
    setSheetDay((current) => (current === day ? null : current));
    if (retiredOffers.has(day)) return;
    setRetiredOffers((current) => new Set(current).add(day));
    journalApi.dismissEchoOffer(day).catch(() => { /* answered here regardless */ });
  }, [retiredOffers]);

  // "Not useful" — the whole set for that page is retired, never asked about, never counted.
  //
  // One request for the set, not one per match. This looped the pair door until 2026-08-09, so a
  // nine-match page cost nine round trips that could each fail on its own and leave the page half
  // faded on the next read — the exact shape ECHOES.md rules out.
  const retireEcho = useCallback((day) => {
    const held = pagesRef.current.get(day);
    setOpenDay((current) => (current === day ? null : current));
    setPages((current) => {
      const next = new Map(current);
      next.delete(day);
      return next;
    });
    journalApi.dismissEchoPage(day).catch(() => {
      if (held) setPages((current) => new Map(current).set(day, held));
    });
  }, []);

  // "Not useful" on one pairing. Only that passage goes — the rest of the page was not what the
  // reader answered about, and retiring it would be putting words in their mouth.
  //
  // THE REFUSAL PUTS IT BACK, here and above, and that is the deliberate half. A dismissal the
  // server did not take is one the next read hands straight back: leaving it hidden buys a few
  // minutes of looking obedient and pays for them with an echo that returns days later for no reason
  // the reader can name — the failure ECHOES.md calls the most trust-destroying this feature has.
  // Coming back at once is at least legible, and the control is right there to press again. No retry
  // queue: a queue would be a second, invisible copy of the reader's answer.
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

  // "Useful" — the one answer given on purpose, and the whole point of the pair. Marked here first
  // because the reader must never wait on a round trip to see their own answer land, and unmarked
  // again if the server refused, for the same reason the dismissal comes back: `useful` is served on
  // the next read, so a mark the server never took is a mark that quietly disappears later.
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

  // Walking back: a position is a URL, so the hop is a hash change; the canvas loads the day and
  // lights the passage. The page you land on has its own ink already open, because every page
  // reaches further back than the one you came from and that is the whole point of the walk.
  const walkTo = useCallback((triggerDay, match) => {
    journalApi.echoOpened(triggerDay, match.day).catch(() => { /* a lost signal is not the reader's problem */ });
    setHops((current) => {
      const trail = current.length ? current : [today];
      const seen = trail.indexOf(match.day);
      return seen >= 0 ? trail.slice(0, seen + 1) : [...trail, match.day];
    });
    setOpenDay(match.day);
    window.location.hash = `#/journal/${match.day}`;
    onFly({ day: match.day, lo: match.lo, hi: match.hi });
  }, [today, onFly]);

  // Stepping back onto a page already in the trail. Not a new echo opened — no signal, and the trail
  // folds back to where you now stand rather than growing a loop.
  const standOn = useCallback((day) => {
    setHops((current) => {
      const seen = current.indexOf(day);
      return seen <= 0 ? [] : current.slice(0, seen + 1);
    });
    setOpenDay(null);
    window.location.hash = day === today ? '#/journal' : `#/journal/${day}`;
    onFly({ day });
  }, [today, onFly]);

  const backToTonight = useCallback(() => {
    setHops([]);
    setOpenDay(null);
    window.location.hash = '#/journal';
    onFly({ day: today });
  }, [today, onFly]);

  // The once-ever card belongs to the newest page that has an echo — tonight's, the night it happens.
  // The server owns the claim; the device flag can only withhold the card, never assert it.
  const firstEchoDay = useMemo(() => {
    if (!firstEver || !pages.size) return null;
    return [...pages.keys()].sort().pop();
  }, [firstEver, pages]);

  const claimFirstEcho = useCallback(() => {
    try { localStorage.setItem(FIRST_ECHO_KEY, 'seen'); } catch { /* storage unavailable — it may say itself twice */ }
  }, []);

  // The desktop margin panel follows the scroll, so it has to actually watch it: the echo page nearest
  // the top of the canvas is the one the panel sits beside, and when none is on screen there is
  // nothing to say and the panel goes.
  useEffect(() => {
    if (!pages.size) { setFollowedDay(null); return undefined; }
    if (!canvas) return undefined;
    const { scroller, dayElement } = canvas;
    // The page you are reading is the last one whose day row has passed the upper half of the canvas —
    // the same page a sticky day marker is showing. Nothing on screen, nothing to sit beside.
    const pick = () => {
      const frame = scroller.getBoundingClientRect();
      const waterline = frame.top + frame.height * 0.55;
      const visible = [...pages.keys()]
        .map((day) => [day, dayElement(day)?.getBoundingClientRect()])
        .filter(([, box]) => box && box.bottom > frame.top && box.top < frame.bottom)
        .sort((a, b) => a[1].top - b[1].top);
      const reading = visible.filter(([, box]) => box.top <= waterline).pop();
      setFollowedDay((reading || visible[0] || [null])[0]);
    };
    pick();
    scroller.addEventListener('scroll', pick, { passive: true });
    window.addEventListener('resize', pick);
    return () => {
      scroller.removeEventListener('scroll', pick);
      window.removeEventListener('resize', pick);
    };
  }, [pages, canvas]);

  const pageOf = useCallback((day) => (floored ? null : pages.get(day) || null), [floored, pages]);

  return {
    today,
    canvas,
    holdCanvas,
    pageOf,
    verify,
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
  };
}
