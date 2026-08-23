// Echoes arrive on an ordinary read; nothing here polls. The count is the array, never a total computed
// from something not in hand. A quote is re-located in the live body at render or it is not shown — the
// wire carries passage text and an occurrence index, never an offset. Under PAGE_FLOOR pages nothing
// renders unless the server says `floorWaived`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { localDay } from '../hlc.js';

const PAGE_FLOOR = 20;
const FIRST_ECHO_KEY = 'windmill:journal-first-echo';

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
  const [hops, setHops] = useState([]);                // the walk, tonight first
  const [followedDay, setFollowedDay] = useState(null); // which page the desktop margin sits beside
  // Handed over by Canvas.jsx on mount: its scroller and its day lookup. Every echo surface measures
  // through this rather than querying the canvas's own markup.
  const [canvas, setCanvas] = useState(null);
  const holdCanvas = useCallback((next) => setCanvas(next), []);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const bodies = useRef(new Map());                    // match day -> live body, fetched once for re-location
  const verifying = useRef(new Set());                 // pages whose bodies are already on the way

  useEffect(() => {
    let cancelled = false;
    // All of it is the account's own prose, so a change of who is signed in drops it before asking again.
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
        // Below the floor nothing renders; the server waives it for the accounts building this.
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

  // Fetch the bodies these quotes live in, re-locate each one, drop the ones that no longer stand.
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
  const walkTo = useCallback((triggerDay, match) => {
    journalApi.echoOpened(triggerDay, match.day).catch(() => { /* a lost signal changes nothing here */ });
    setHops((current) => {
      const trail = current.length ? current : [today];
      const seen = trail.indexOf(match.day);
      return seen >= 0 ? trail.slice(0, seen + 1) : [...trail, match.day];
    });
    setOpenDay(match.day);
    window.location.hash = `#/journal/${match.day}`;
    onFly({ day: match.day, lo: match.lo, hi: match.hi });
  }, [today, onFly]);

  // Stepping back onto a page already in the trail folds the trail rather than growing a loop.
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

  // The once-ever card belongs to the newest page with an echo. The server owns the claim; the device
  // flag can only withhold the card, never assert it.
  const firstEchoDay = useMemo(() => {
    if (!firstEver || !pages.size) return null;
    return [...pages.keys()].sort().pop();
  }, [firstEver, pages]);

  const claimFirstEcho = useCallback(() => {
    try { localStorage.setItem(FIRST_ECHO_KEY, 'seen'); } catch { /* storage unavailable — it may say itself twice */ }
  }, []);

  // The desktop margin sits beside the echo page nearest the top of the canvas; with none on screen it goes.
  useEffect(() => {
    if (!pages.size) { setFollowedDay(null); return undefined; }
    if (!canvas) return undefined;
    const { scroller, dayElement } = canvas;
    // The page being read is the last one whose day row has passed the upper half of the canvas.
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
