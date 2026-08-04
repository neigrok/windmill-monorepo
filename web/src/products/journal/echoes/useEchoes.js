// The echoes the nightly sweep left on your pages, and everything the surface does with them.
//
// Three rules shape this file:
//
//   The count is the array. The server sends only matches it verified, so `ECHO · n` is n rows the
//   reader can tap. Nothing here ever computes a total from something it hasn't got.
//
//   A quote is re-located in the live body at render, or it is not shown. The wire carries passage
//   TEXT, never offsets, so an edit to an old page can't silently re-point a quote at the wrong
//   sentence. Locating also yields the char span the canvas lights when you walk there.
//
//   Under ~20 pages, nothing at all. No marks, no offer. There is nothing true to sell yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { localDay } from '../hlc.js';

const PAGE_FLOOR = 20;
const FIRST_ECHO_KEY = 'windmill:journal-first-echo';

// Prefer the span the server remembered, but only if the live text is still standing in it; otherwise
// fall back to a search. A hit is the passage's char range in this body — nothing is ever sliced blind.
function locate(body, text, hint) {
  if (!body || !text) return null;
  if (typeof hint === 'number' && body.slice(hint, hint + text.length) === text) return [hint, hint + text.length];
  const at = body.indexOf(text);
  if (at < 0) return null;
  return [at, at + text.length];
}

function seenFirstEcho() {
  try {
    return localStorage.getItem(FIRST_ECHO_KEY) === 'seen';
  } catch {
    return false;
  }
}

export function useEchoes({ today = localDay(), onFly = () => {} } = {}) {
  const [pages, setPages] = useState(new Map());       // trigger day -> { day, entitled, matches, verified }
  const [floored, setFloored] = useState(false);       // fewer than ~20 pages: the canvas stays quiet
  const [firstEver, setFirstEver] = useState(false);
  const [retiredOffers, setRetiredOffers] = useState(new Set());
  const [panelDay, setPanelDay] = useState(null);
  const [sheetDay, setSheetDay] = useState(null);
  const [hops, setHops] = useState([]);                // the walk, tonight first — a receipt, not a wizard
  const [followedDay, setFollowedDay] = useState(null); // which page the desktop margin panel is beside

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const bodies = useRef(new Map());                    // match day -> live body, fetched once for re-location
  const verifying = useRef(new Set());                 // pages whose bodies are already on the way

  useEffect(() => {
    let cancelled = false;
    journalApi.echoes('0001-01-01', today)
      .then((reply) => {
        if (cancelled) return;
        if (typeof reply.pagesWritten === 'number' && reply.pagesWritten < PAGE_FLOOR) {
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
  }, [today]);

  // Fetch the bodies this page's quotes live in, re-locate every one, and drop the ones that no
  // longer stand. Runs when a card or panel opens; the mark reads the same state, so the two can
  // never disagree about how many echoes a page has.
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
          const span = locate(bodies.current.get(match.day), match.text, match.lo);
          return span ? { ...match, lo: span[0], hi: span[1] } : null;
        })
        .filter(Boolean);
      const next = new Map(current);
      if (!located.length) next.delete(day);           // never an empty "no echoes" state
      else next.set(day, { ...held, matches: located, verified: true });
      return next;
    });
  }, []);

  const openPanel = useCallback((day) => { verify(day); setPanelDay(day); }, [verify]);
  const closePanel = useCallback(() => setPanelDay(null), []);
  const openSheet = useCallback((day) => setSheetDay(day), []);
  const closeSheet = useCallback(() => setSheetDay(null), []);

  // "Not now" — the offer goes, the echo stays. Nothing re-asks a page that was answered.
  const retireOffer = useCallback((day) => {
    setRetiredOffers((current) => new Set(current).add(day));
    journalApi.dismissEchoOffer(day).catch(() => { /* the offer is already gone here */ });
  }, []);

  // "Not useful" — the whole set for that page is retired, never asked about, never counted.
  const retireEcho = useCallback((day) => {
    const page = pagesRef.current.get(day);
    setPanelDay((current) => (current === day ? null : current));
    setPages((current) => {
      const next = new Map(current);
      next.delete(day);
      return next;
    });
    page?.matches.forEach((match) => {
      journalApi.dismissEcho(day, match.day).catch(() => { /* the mark is already gone here */ });
    });
  }, []);

  // Walking back: a position is a URL, so the hop is a hash change; the canvas loads the day and
  // lights the passage. The trail records where you came from — and folds back on itself rather than
  // repeating a day you already stood on.
  const walkTo = useCallback((triggerDay, match) => {
    journalApi.echoOpened(triggerDay, match.day).catch(() => { /* a lost signal is not the reader's problem */ });
    setHops((current) => {
      const trail = current.length ? current : [today];
      const seen = trail.indexOf(match.day);
      return seen >= 0 ? trail.slice(0, seen + 1) : [...trail, match.day];
    });
    setPanelDay(null);
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
    window.location.hash = day === today ? '#/journal' : `#/journal/${day}`;
    onFly({ day });
  }, [today, onFly]);

  const backToTonight = useCallback(() => {
    setHops([]);
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
    const scroller = document.querySelector('.journal-scroll');
    if (!scroller) return undefined;
    // The page you are reading is the last one whose day row has passed the upper half of the canvas —
    // the same page a sticky day marker is showing. Nothing on screen, nothing to sit beside.
    const pick = () => {
      const frame = scroller.getBoundingClientRect();
      const waterline = frame.top + frame.height * 0.55;
      const visible = [...pages.keys()]
        .map((day) => [day, scroller.querySelector(`[data-date="${day}"]`)?.getBoundingClientRect()])
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
  }, [pages]);

  const pageOf = useCallback((day) => (floored ? null : pages.get(day) || null), [floored, pages]);
  const offerRetired = useCallback((day) => retiredOffers.has(day), [retiredOffers]);

  return {
    today,
    pageOf,
    offerRetired,
    verify,
    panelDay,
    openPanel,
    closePanel,
    sheetDay,
    openSheet,
    closeSheet,
    retireOffer,
    retireEcho,
    walkTo,
    standOn,
    hops,
    backToTonight,
    firstEchoDay,
    claimFirstEcho,
    followedDay,
  };
}
