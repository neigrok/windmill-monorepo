// The canvas's data: load a window of the past, and own today's live draft with
// its autosave. History is read once (oldest→newest, gaps included); today is a
// separate editable draft that debounces to a PUT ~800ms after typing stops, and
// writes immediately on a mood/energy tap. Every write mints a fresh HLC — the
// sole convergence key — and reconciles the winning page the server hands back,
// never clobbering text the writer kept typing. A failed write goes 'offline' and
// retries; it never throws the UI.

import { useCallback, useEffect, useRef, useState } from 'react';
import { journalApi } from './journalApi.js';
import { localDay, daysBefore, mintStamp } from './hlc.js';

const WINDOW_DAYS = 60;
const SAVE_DEBOUNCE = 800;
const RETRY_DELAY = 4000;

function daysBetween(from, to) {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// The inclusive run of local days [from, to], oldest first — the calendar the
// canvas draws, gaps and all.
function span(from, to) {
  const out = [];
  for (let k = daysBetween(from, to); k >= 0; k--) out.push(daysBefore(to, k));
  return out;
}

export function usePages() {
  const today = localDay();
  const [history, setHistory] = useState([]);            // [{ date, body, mood, energy, written }], oldest→newest
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ body: '', mood: null, energy: null });
  const [saveState, setSaveState] = useState('idle');    // 'idle' | 'saved' | 'offline'
  const [saveTick, setSaveTick] = useState(0);           // bumps once per write so the "saved" note re-fades

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const historyRef = useRef(history);
  historyRef.current = history;
  const touchedRef = useRef(false);                      // the writer typed before the window arrived
  const pendingRef = useRef(false);                      // a debounced save is queued
  const saveTimer = useRef(null);
  const retryTimer = useRef(null);

  // Load the window once: today back sixty days. Fold the returned pages onto the
  // calendar from the earliest written day to yesterday; today becomes the draft.
  useEffect(() => {
    let cancelled = false;
    journalApi.range(daysBefore(today, WINDOW_DAYS), today)
      .then((pages) => {
        if (cancelled) return;
        const byDate = new Map(pages.map((page) => [page.day, page]));
        const mine = byDate.get(today);
        if (mine && !touchedRef.current) {
          setDraft({ body: mine.body || '', mood: mine.mood ?? null, energy: mine.energy ?? null });
        }
        const earliest = pages.map((page) => page.day).filter((day) => day < today).sort()[0];
        const days = earliest
          ? span(earliest, daysBefore(today, 1)).map((date) => {
              const page = byDate.get(date);
              if (!page) return { date, body: '', mood: null, energy: null, written: false };
              return { date, body: page.body || '', mood: page.mood ?? null, energy: page.energy ?? null, written: true };
            })
          : [];
        setHistory(days);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [today]);

  // Reach further back than the initial sixty-day window so a search hit older than the canvas
  // renders can still be flown to. Loads [date, current earliest − 1] and prepends it, gaps and all,
  // contiguous with what's already drawn. A no-op once the day is within the loaded window.
  const extendTo = useCallback(async (date) => {
    const hist = historyRef.current;
    const earliest = hist.length ? hist[0].date : daysBefore(today, 1);
    if (!date || date >= earliest) return;
    const pages = await journalApi.range(date, daysBefore(earliest, 1)).catch(() => null);
    if (!pages) return;
    const byDate = new Map(pages.map((page) => [page.day, page]));
    const older = span(date, daysBefore(earliest, 1)).map((day) => {
      const page = byDate.get(day);
      if (!page) return { date: day, body: '', mood: null, energy: null, written: false };
      return { date: day, body: page.body || '', mood: page.mood ?? null, energy: page.energy ?? null, written: true };
    });
    setHistory((cur) => [...older, ...cur]);
  }, [today]);

  const persist = useCallback(async (next) => {
    pendingRef.current = false;
    clearTimeout(retryTimer.current);
    try {
      const winner = await journalApi.putPage(today, {
        body: next.body, mood: next.mood, energy: next.energy, source: 'typed', stamp: mintStamp(),
      });
      setSaveState('saved');
      setSaveTick((tick) => tick + 1);
      // Adopt the winning page, but only for fields the writer hasn't moved since.
      setDraft((cur) => ({
        body: cur.body === next.body ? (winner.body ?? '') : cur.body,
        mood: cur.mood === next.mood ? (winner.mood ?? null) : cur.mood,
        energy: cur.energy === next.energy ? (winner.energy ?? null) : cur.energy,
      }));
    } catch {
      setSaveState('offline');
      setSaveTick((tick) => tick + 1);
      retryTimer.current = setTimeout(() => persist(draftRef.current), RETRY_DELAY);
    }
  }, [today]);

  const setBody = useCallback((body) => {
    touchedRef.current = true;
    pendingRef.current = true;
    setDraft((cur) => ({ ...cur, body }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(draftRef.current), SAVE_DEBOUNCE);
  }, [persist]);

  const toggle = useCallback((field, step) => {
    touchedRef.current = true;
    const next = { ...draftRef.current, [field]: draftRef.current[field] === step ? null : step };
    setDraft(next);
    clearTimeout(saveTimer.current);
    persist(next);
  }, [persist]);

  const toggleMood = useCallback((step) => toggle('mood', step), [toggle]);
  const toggleEnergy = useCallback((step) => toggle('energy', step), [toggle]);

  // Flush a queued draft on unmount so nothing typed is lost on the way out.
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(retryTimer.current);
    if (pendingRef.current) persist(draftRef.current);
  }, [persist]);

  const firstRun = !loading && history.length === 0
    && draft.body.trim() === '' && draft.mood == null && draft.energy == null;

  return {
    today, history, loading, firstRun,
    body: draft.body, mood: draft.mood, energy: draft.energy,
    saveState, saveTick,
    setBody, toggleMood, toggleEnergy, extendTo,
  };
}
