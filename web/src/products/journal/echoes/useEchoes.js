// Echoes arrive on an ordinary read; nothing here polls. The count is the array, never a total computed
// from something not in hand. A quote is re-located in the live body at render or it is not shown — the
// wire carries passage text and an occurrence index, never an offset. Under PAGE_FLOOR pages nothing
// renders unless the server says `floorWaived`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journalApi } from '../journalApi.js';
import { localDay } from '../hlc.js';

const PAGE_FLOOR = 20;
// How often an open, visible canvas asks again. The derivation behind an echo takes 10-17 seconds,
// so this is the shortest wait that is not simply guessing, and it stops dead when the tab is hidden.
const LIVE_INTERVAL = 15000;
const FIRST_ECHO_KEY = 'windmill:journal-first-echo';
const GUTTER_KEY = 'windmill:journal-gutter';   // scoped per account: one reader's echoes never reserve another's room

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

// The reserved space a returning reader already had, read before the first paint so it never widens
// under them. A latch: once open for this mount it stays open, whatever the scroll passes over.
function gutterKey(account) {
  return account ? `${GUTTER_KEY}:${account}` : GUTTER_KEY;
}

function storedGutter(account) {
  try {
    return localStorage.getItem(gutterKey(account)) === '1';
  } catch {
    return false;
  }
}

function rememberGutter(account, open) {
  try {
    if (open) localStorage.setItem(gutterKey(account), '1');
    else localStorage.removeItem(gutterKey(account));
  } catch { /* storage unavailable — the space is decided again next mount */ }
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

// The stored latch is written only when it actually moves. `rememberGutter` used to run once per
// mount; the read it sits in now repeats every LIVE_INTERVAL while the tab is visible, and a
// localStorage write every fifteen seconds to store the value already there is a cost with no
// reader. (The latch itself belongs to the reserved-gutter fix — it is never withdrawn mid-mount.)
function keepGutter(account, open) {
  if (storedGutter(account) === open) return;
  rememberGutter(account, open);
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
  const [hasGutter, setHasGutter] = useState(() => storedGutter(account)); // the reserved space, never withdrawn mid-mount
  // Handed over by Canvas.jsx on mount: its scroller and its day lookup. Every echo surface measures
  // through this rather than querying the canvas's own markup.
  const [canvas, setCanvas] = useState(null);
  const holdCanvas = useCallback((next) => setCanvas(next), []);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const bodies = useRef(new Map());                    // match day -> live body, fetched once for re-location
  const verifying = useRef(new Set());                 // pages whose bodies are already on the way
  // ONLY THE MOUNT'S FIRST COMPLETED READ MAY CLEAR THE GUTTER LATCH. Any read may SET it — an echo
  // arriving mid-session should reserve the space for next time — but a 15-second poll is not the
  // authoritative answer a single mount read was. A successful-but-empty reply happens for reasons
  // that are not "this writer has no echoes": a poll landing mid-sweep sees a page whose rows are
  // between deletion and rewrite, `pagesWritten` can read under the floor for a beat, a degraded
  // answer is still a 200. Clearing on one of those costs the reader the ~150px slide the reserved
  // gutter exists to kill — on their NEXT load, where nothing connects it to the cause.
  //
  // The asymmetry is the whole argument: keeping the space one load too long is invisible, and
  // taking it away wrongly is the bug. (windmill-4b caught this; the fix before it moved the clear
  // into the polled path and only deferred the original defect by one reload.)
  const mayClear = useRef(true);

  // The read, as a function rather than only as a mount effect. Echoes arrive SECONDS after a save —
  // the segmenter, the embedder and the curator take 10-17 of them — and until this was callable the
  // only way to see one was to reload the page, which is not a journal behaving like a journal.
  const load = useCallback(() => {
    let cancelled = false;
    journalApi.echoes('0001-01-01', today)
      .then((reply) => {
        if (cancelled) return;
        // Below the floor nothing renders; the server waives it for the accounts building this.
        if (!reply.floorWaived
            && typeof reply.pagesWritten === 'number' && reply.pagesWritten < PAGE_FLOOR) {
          setFloored(true);
          setPages(new Map());
          if (mayClear.current) keepGutter(account, false);
          mayClear.current = false;
          return;
        }
        setFloored(false);
        const found = (reply.pages || []).filter((page) => page.matches?.length);
        if (found.length) keepGutter(account, true);
        else if (mayClear.current) keepGutter(account, false);
        mayClear.current = false;
        if (found.length) setHasGutter(true);
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
    setHasGutter(storedGutter(account));
    bodies.current = new Map();
    verifying.current = new Set();
    mayClear.current = true;
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
    verifying.current.add(day);
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
    loaded.forEach(([d, body]) => { if (body !== null) bodies.current.set(d, body); });
    verifying.current.delete(day);
    setPages((current) => {
      const held = current.get(day);
      if (!held) return current;
      const standing = stillStanding(held.matches, bodies.current);
      const located = standing.map((match) => {
        const span = locate(bodies.current.get(match.day), match.text, match.occurrenceHint);
        return span ? { ...match, lo: span[0], hi: span[1] } : match;
      });
      const next = new Map(current);
      if (!located.length) next.delete(day);           // never an empty "no echoes" state
      else next.set(day, { ...held, matches: located, verified: true });
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
    // Exposed so a surface that KNOWS a page just changed can ask immediately rather than waiting
    // out the beat above — the canvas holds every body it draws, so it can do better than 15s.
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
    hasGutter,
  };
}
